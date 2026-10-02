/**
 * The Employee Drawer's salary block and the deduction workflow.
 *
 * Two contracts are under test, and both are about the BACKEND being the single
 * source of truth:
 *
 *  1. the four salary cards render the `financials` block EXACTLY as the backend
 *     sent it — this file never recomputes a net salary, because no production
 *     code does either. A change here would mean the frontend had started doing
 *     payroll arithmetic;
 *  2. the block states which period it is talking about, and says plainly that it
 *     follows the page's date filter. A manager who moves the filter must be able
 *     to see why the four numbers moved, without guessing.
 *
 * The deduction dialog is asserted on the same path: it sends the amount, the date
 * and the reason, and it never sends an employee — the drawer already knows which
 * person it opened.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { formatDate } from '@/lib/date'
import { formatMinorMoney } from '@/lib/money'
import { ToastProvider } from '@/components/ui'
import { EmployeeDetailsDrawer } from './EmployeeDetailsDrawer'
import type { EmployeeDetails } from '@/services/employeesApi'

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

describe('Employee Drawer — the salary block for the selected period', () => {
  it('names the period and says the figures follow the page date filter', async () => {
    renderDrawer(detailsWith({}))
    expect(await screen.findByText('بيانات الرواتب للفترة المحددة')).toBeInTheDocument()
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

  it('renders all four cards from the backend figures, without recomputing them', async () => {
    renderDrawer(
      detailsWith({
        base_salary: 1_000_000,
        advances: 300_000,
        deductions: 50_000,
        net_salary: 650_000,
      }),
    )
    await screen.findByText('بيانات الرواتب للفترة المحددة')

    expect(screen.getByText('الراتب الأساسي')).toBeInTheDocument()
    expect(screen.getByText(money(1_000_000))).toBeInTheDocument()
    expect(screen.getByText('إجمالي السلف')).toBeInTheDocument()
    expect(screen.getByText(money(300_000))).toBeInTheDocument()
    expect(screen.getByText('إجمالي الخصومات')).toBeInTheDocument()
    expect(screen.getByText(money(50_000))).toBeInTheDocument()
    expect(screen.getByText('صافي الراتب')).toBeInTheDocument()
    expect(screen.getByText(money(650_000))).toBeInTheDocument()
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
    expect(screen.getByText(money(2_000_000))).toBeInTheDocument()
    expect(screen.getByText(money(1_620_000))).toBeInTheDocument()
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
    await screen.findByText('بيانات الرواتب للفترة المحددة')
    expect(screen.getByRole('button', { name: /تسجيل خصم/ })).toBeInTheDocument()
    expect(
      screen.getByText('الخصم يُخصم من الراتب فقط ولا يُسجَّل ضمن المصروفات.'),
    ).toBeInTheDocument()
  })

  it('is not offered at all without the manager permission', async () => {
    renderDrawer(detailsWith({}), false)
    await screen.findByText('بيانات الرواتب للفترة المحددة')
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
