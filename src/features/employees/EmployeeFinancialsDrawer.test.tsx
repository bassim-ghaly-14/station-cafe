/**
 * The Employee Drawer's three financial scopes and the deduction workflow.
 *
 * Two contracts are under test, and both are about the BACKEND being the single
 * source of truth:
 *
 *  1. every card renders its backend figure EXACTLY as it arrived — this file
 *     never recomputes a net salary, because no production code does either.
 *     A change here would mean the frontend had started doing payroll arithmetic;
 *  2. the FIXED monthly salary (`employee.base_salary`), the SELECTED-PERIOD
 *     figures (`financials`) and the historical payroll snapshots (`payroll`)
 *     are three different scopes, each under its own label — a manager must be
 *     able to tell them apart without knowing the implementation;
 *  3. the period block states which period it is talking about, and says plainly
 *     that it follows the page's date filter. A manager who moves the filter must
 *     be able to see why the numbers moved, without guessing.
 *
 * The deduction dialog is asserted on the same path: it sends the amount, the date
 * and the reason, and it never sends an employee — the drawer already knows which
 * person it opened.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { formatDate } from '@/lib/date'
import { formatMinorMoney } from '@/lib/money'
import { ToastProvider } from '@/components/ui'
import { EmployeeDetailsDrawer } from './EmployeeDetailsDrawer'
import type { EmployeeDetails, PayrollRun } from '@/services/employeesApi'

const EMPLOYEE = {
  id: 7,
  user_id: 3,
  name: 'أحمد سيد',
  phone: null,
  employee_type: 'CASHIER' as const,
  status: 'ACTIVE' as const,
  base_salary: 1_000_000,
  notes: null,
  created_at: '2026-01-05 08:00:00Z',
  updated_at: '2026-01-05 08:00:00Z',
  login_role: 'STAFF' as const,
}

/** Piasters → the exact string the shared `MoneyDisplay` renders. */
const money = (piasters: number) => formatMinorMoney(piasters, { variant: 'auto' })

/**
 * The figure rendered directly after a LABEL element — `StatBlock` and
 * `LedgerRow` both place the value in the element right after the label, so a
 * test can assert WHICH card a number sits in, not merely that it exists.
 */
const figureNext = (label: Element): string | null => label.nextElementSibling?.textContent ?? null

/** The same, looked up by its exact Arabic label across the document. */
const figureAfter = (label: string): string | null => figureNext(screen.getByText(label))

/** A drawer payload with the salary block the backend would have computed. */
function detailsWith(financials: Partial<EmployeeDetails['financials']>): EmployeeDetails {
  return {
    employee: EMPLOYEE,
    period_row: null,
    attendance: [],
    advances: [],
    deductions: [],
    financials: {
      from: '2026-10-01',
      to: '2026-10-31',
      months: 1,
      base_salary: 1_000_000,
      salary_paid: 0,
      advances: 0,
      deductions: 0,
      net_salary: 1_000_000,
      ...financials,
    },
    payroll: [],
  }
}

const mocks = vi.hoisted(() => ({
  details: vi.fn(),
  // Typed by the real signature — (employeeId, input) — so a test reading the
  // recorded call sees the actual payload rather than an empty tuple.
  createDeduction: vi.fn(async (_employeeId: number, _input: Record<string, unknown>) => 11),
}))

vi.mock('@/services/employeesApi', () => ({
  employeesApi: {
    details: mocks.details,
    createDeduction: mocks.createDeduction,
  },
}))

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' }

function renderDrawer(details: EmployeeDetails, canDeduct = true) {
  mocks.details.mockResolvedValue(details)
  return render(
    <ToastProvider>
      <EmployeeDetailsDrawer
        employeeId={EMPLOYEE.id}
        employeeName={EMPLOYEE.name}
        period={OCTOBER}
        canOverride
        canDeduct={canDeduct}
        onClose={vi.fn()}
        onOverridden={vi.fn()}
        onDeducted={vi.fn()}
      />
    </ToastProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createDeduction.mockResolvedValue(11)
})

describe('Employee Drawer — the selected period zone', () => {
  it('names the period and says the figures follow the page date filter', async () => {
    renderDrawer(detailsWith({}))
    expect(await screen.findByText('الفترة المحددة')).toBeInTheDocument()
    expect(
      screen.getByText('تتأثر هذه البيانات بالفترة المحددة في فلتر التاريخ أعلى الصفحة.'),
    ).toBeInTheDocument()
    // The ACTUAL range applied is printed, not merely implied. The dates are
    // rendered through the shared `formatDate`, so the screen honours the user's
    // date-format preference exactly like the expenses page's own period line.
    const range = screen.getByText(/الفترة:/)
    expect(range).toHaveTextContent(formatDate('2026-10-01'))
    expect(range).toHaveTextContent(formatDate('2026-10-31'))
  })

  it('states how many salary months were counted', async () => {
    renderDrawer(detailsWith({ months: 1 }))
    expect(await screen.findByText('عدد شهور الراتب المحتسبة: 1')).toBeInTheDocument()
  })

  it('renders every salary card from the backend figures, without recomputing them', async () => {
    renderDrawer(
      detailsWith({
        base_salary: 1_000_000,
        advances: 300_000,
        deductions: 50_000,
        net_salary: 650_000,
      }),
    )
    await screen.findByText('الفترة المحددة')

    // The FIXED monthly configuration — its own label, verbatim, un-multiplied.
    expect(figureAfter('الراتب الأساسي الشهري')).toBe(money(1_000_000))
    // The selected period's own figures — also verbatim, also un-recomputed.
    expect(figureAfter('إجمالي رواتب الفترة')).toBe(money(1_000_000))
    expect(figureAfter('إجمالي السلف')).toBe(money(300_000))
    expect(figureAfter('إجمالي الخصومات')).toBe(money(50_000))
    expect(figureAfter('صافي راتب الفترة')).toBe(money(650_000))
  })

  it('shows a multi-month period as such, and takes the backend base for it', async () => {
    // October + November of a 10,000 monthly salary: 20,000 base, 3,000 advances,
    // 800 deductions, 16,200 net — the exact figures the service computed.
    renderDrawer(
      detailsWith({
        from: '2026-10-01',
        to: '2026-11-30',
        months: 2,
        base_salary: 2_000_000,
        advances: 300_000,
        deductions: 80_000,
        net_salary: 1_620_000,
      }),
    )
    await screen.findByText('عدد شهور الراتب المحتسبة: 2')
    // The FIXED monthly salary is untouched by the two-month window…
    expect(figureAfter('الراتب الأساسي الشهري')).toBe(money(1_000_000))
    // …while the period total IS the backend's ×2, no-proration figure.
    expect(figureAfter('إجمالي رواتب الفترة')).toBe(money(2_000_000))
    expect(figureAfter('صافي راتب الفترة')).toBe(money(1_620_000))
  })

  it('keeps a single month equal to the monthly salary, under two distinct labels', async () => {
    renderDrawer(detailsWith({ months: 1, base_salary: 1_000_000 }))
    await screen.findByText('عدد شهور الراتب المحتسبة: 1')
    // Same figure, two scopes — and the old ambiguous label is gone for good.
    expect(figureAfter('الراتب الأساسي الشهري')).toBe(money(1_000_000))
    expect(figureAfter('إجمالي رواتب الفترة')).toBe(money(1_000_000))
    expect(screen.queryByText('الراتب الأساسي')).not.toBeInTheDocument()
  })

  it('reports salary paid beside the period figures without ever feeding the net', async () => {
    renderDrawer(
      detailsWith({
        salary_paid: 700_000,
        advances: 100_000,
        deductions: 50_000,
        net_salary: 850_000,
      }),
    )
    await screen.findByText('الفترة المحددة')
    expect(figureAfter('الرواتب المدفوعة للفترة')).toBe(money(700_000))
    // The card says, in one line, what this figure IS.
    expect(screen.getByText('المبالغ المسجلة كمدفوعات خلال الفترة')).toBeInTheDocument()
    // Net is exactly what the backend sent: base − advances − deductions, with
    // the paid salary reported beside it but never subtracted by it.
    expect(figureAfter('صافي راتب الفترة')).toBe(money(850_000))
  })

  it('states the real unbounded window rather than claiming "every recorded period"', async () => {
    renderDrawer(detailsWith({ from: null, to: null, months: 12 }))
    // The backend's unbounded window is the employee's JOINING month through the
    // current business month — never "since the beginning of time", which would
    // multiply a monthly salary by an invented span. The wording states exactly
    // that window, so the screen cannot claim a wider period than was counted.
    expect(
      await screen.findByText('الفترة: من شهر التحاق الموظف حتى الشهر الحالي'),
    ).toBeInTheDocument()
    expect(screen.queryByText('الفترة: كل الفترات المسجّلة')).not.toBeInTheDocument()
  })

  it('renders zero advances and zero deductions as real zeroes', async () => {
    renderDrawer(detailsWith({ advances: 0, deductions: 0 }))
    await screen.findByText('إجمالي السلف')
    expect(screen.getAllByText(money(0)).length).toBeGreaterThanOrEqual(2)
    // The fixed monthly salary still renders independently of the empty period.
    expect(figureAfter('الراتب الأساسي الشهري')).toBe(money(1_000_000))
  })

  it('lists the deductions of the same period and their recorder', async () => {
    renderDrawer({
      ...detailsWith({ deductions: 50_000 }),
      deductions: [
        {
          id: 5,
          employee_id: 7,
          amount: 50_000,
          deduction_date: '2026-10-25',
          reason: 'تأخير عن الحضور',
          created_by: 1,
          created_by_name: 'مدير الفرع',
          created_at: '2026-10-25 10:00:00Z',
        },
      ],
    })
    await screen.findByText('تأخير عن الحضور')
    expect(screen.getByText(/مدير الفرع/)).toBeInTheDocument()
  })

  it('shows an honest empty state when the period holds no deductions', async () => {
    renderDrawer(detailsWith({}))
    expect(await screen.findByText('لا توجد خصومات مسجلة')).toBeInTheDocument()
  })
})

describe('Employee Drawer — recording a deduction', () => {
  it('offers the action to a manager and states that it is not an expense', async () => {
    renderDrawer(detailsWith({}))
    await screen.findByText('الفترة المحددة')
    expect(screen.getByRole('button', { name: /تسجيل خصم/ })).toBeInTheDocument()
    expect(
      screen.getByText('الخصم يُخصم من الراتب فقط ولا يُسجَّل ضمن المصروفات.'),
    ).toBeInTheDocument()
  })

  it('is not offered at all without the manager permission', async () => {
    renderDrawer(detailsWith({}), false)
    await screen.findByText('الفترة المحددة')
    expect(screen.queryByRole('button', { name: /تسجيل خصم/ })).not.toBeInTheDocument()
  })

  it('refuses an empty or zero amount before sending anything', async () => {
    renderDrawer(detailsWith({}))
    fireEvent.click(await screen.findByRole('button', { name: /تسجيل خصم/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'حفظ' }))
    expect(await screen.findByText('مبلغ الخصم غير صحيح')).toBeInTheDocument()
    expect(mocks.createDeduction).not.toHaveBeenCalled()
  })

  it('sends the amount for the OPEN employee only, with no employee in the payload', async () => {
    renderDrawer(detailsWith({}))
    fireEvent.click(await screen.findByRole('button', { name: /تسجيل خصم/ }))

    expect(await screen.findByText('تسجيل خصم لموظف')).toBeInTheDocument()
    // The employee is named but NOT selectable: the drawer already knows.
    expect(screen.getByText(/يُسجَّل الخصم على راتب أحمد سيد/)).toBeInTheDocument()

    const amount = document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')
    fireEvent.change(amount as HTMLInputElement, { target: { value: '500' } })

    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))
    await waitFor(() => expect(mocks.createDeduction).toHaveBeenCalledTimes(1))

    const [employeeId, input] = mocks.createDeduction.mock.calls[0]
    expect(employeeId).toBe(EMPLOYEE.id)
    expect(input).toMatchObject({ amount: 50_000 })
    // No employee travels in the payload — the id is the separate first argument.
    expect(input).not.toHaveProperty('employee_id')
  })

  it('re-reads the drawer after a deduction so the cards move', async () => {
    renderDrawer(detailsWith({}))
    fireEvent.click(await screen.findByRole('button', { name: /تسجيل خصم/ }))
    const amount = document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')
    fireEvent.change(amount as HTMLInputElement, { target: { value: '500' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    await waitFor(() => expect(mocks.details).toHaveBeenCalledTimes(2))
  })
})

describe('Employee Drawer — payroll history', () => {
  /** One FINALIZED monthly snapshot, exactly as the backend returns it. */
  const RUN: PayrollRun = {
    id: 42,
    employee_id: 7,
    period: '2026-09',
    base_salary: 950_000,
    attendance_days: 24,
    worked_minutes: 11_400,
    absence_days: 2,
    leave_days: 1,
    advances: 100_000,
    deductions: 50_000,
    net_salary: 800_000,
    status: 'FINALIZED',
    created_by: 1,
    created_at: '2026-09-30 20:00:00Z',
    finalized_by: 1,
    finalized_at: '2026-10-01 09:00:00Z',
  }

  it('labels a run as the saved monthly snapshot it is, distinct from the live figures', async () => {
    renderDrawer({ ...detailsWith({}), payroll: [RUN] })
    await screen.findByText('سجل الرواتب')
    expect(
      screen.getByText('قيم محفوظة عند إنشاء مسير الراتب ولا تتأثر بفلتر التاريخ'),
    ).toBeInTheDocument()

    const run = screen.getByText('2026-09').closest('li')
    expect(run).not.toBeNull()
    // The run's month and status survive exactly as before.
    expect(within(run!).getByText('2026-09')).toBeInTheDocument()
    expect(within(run!).getByText('معتمد')).toBeInTheDocument()
    // The snapshot's OWN labels — never the live selected-period ones.
    expect(figureNext(within(run!).getByText('الراتب الأساسي للشهر'))).toBe(money(950_000))
    expect(figureNext(within(run!).getByText('السلف'))).toBe(money(100_000))
    expect(figureNext(within(run!).getByText('الخصومات'))).toBe(money(50_000))
    expect(figureNext(within(run!).getByText('صافي راتب الشهر'))).toBe(money(800_000))
  })

  it('renders every run regardless of the selected Employees-page range', async () => {
    // The drawer's applied period is October (see `detailsWith`); September's
    // run still renders — the backend returns all runs and the drawer filters
    // none of them. Payroll history must never follow the page's date filter.
    renderDrawer({ ...detailsWith({ from: '2026-10-01', to: '2026-10-31' }), payroll: [RUN] })
    await screen.findByText('سجل الرواتب')
    expect(screen.getByText('2026-09')).toBeInTheDocument()
  })

  it('keeps the DRAFT badge on an unfinalized run', async () => {
    renderDrawer({
      ...detailsWith({}),
      payroll: [
        {
          ...RUN,
          id: 43,
          period: '2026-10',
          status: 'DRAFT',
          finalized_by: null,
          finalized_at: null,
        },
      ],
    })
    await screen.findByText('سجل الرواتب')
    const run = screen.getByText('2026-10').closest('li')
    expect(within(run!).getByText('مسودة')).toBeInTheDocument()
  })

  it('shows an honest empty state when no run exists', async () => {
    renderDrawer(detailsWith({}))
    expect(await screen.findByText('لا توجد فترات رواتب')).toBeInTheDocument()
  })
})
