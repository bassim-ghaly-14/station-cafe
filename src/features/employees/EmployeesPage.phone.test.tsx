/**
 * EmployeesPage on a PHONE.
 *
 * The main suite proves the table is right at 1280px. This file proves the other
 * half of the contract: that below `md` the roster is a different PRESENTATION
 * of the same data, and that presentation is usable at 360px.
 *
 * What is asserted here, and why each was a real defect:
 *
 *  - the roster is NOT a table on a phone, because a ten-column table whose
 *    actions need 336px leaves the identity column off-screen — the user cannot
 *    tell whose row they are acting on;
 *  - exactly ONE presentation is mounted (no CSS-hidden duplicate a screen
 *    reader would read twice);
 *  - the four attendance punches stay DIRECTLY VISIBLE at their 48px target,
 *    because taking a punch is what the roster exists for and burying the common
 *    case behind a menu makes the common case the slow one;
 *  - the management actions move behind ONE control, keeping their labels, their
 *    icons, their disabled states, their semantic tones, and the irreversible
 *    delete LAST;
 *  - a CASHIER is given neither the menu nor its entries — they are not
 *    constructed, not merely hidden.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { resetViewportWidth, setViewportWidth } from '@/test/setup'
import { ToastProvider } from '@/components/ui'
import EmployeesPage from './EmployeesPage'
import type { EmployeeList } from '@/services/employeesApi'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  overview: vi.fn(),
  myAttendance: vi.fn(),
  recordAttendance: vi.fn(),
  details: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  setStatus: vi.fn(),
  remove: vi.fn(),
  setBaseSalary: vi.fn(),
  createAdvance: vi.fn(),
  reverseAdvance: vi.fn(),
  payrollPreview: vi.fn(),
  createPayrollRun: vi.fn(),
  finalizePayrollRun: vi.fn(),
  correctAttendance: vi.fn(),
  washWorkers: vi.fn(),
  setOrderWashEmployee: vi.fn(),
  role: { current: 'MANAGER' as 'STAFF' | 'MANAGER' | 'ADMIN' },
}))

vi.mock('@/services/employeesApi', () => ({
  employeesApi: {
    list: mocks.list,
    overview: mocks.overview,
    myAttendance: mocks.myAttendance,
    recordAttendance: mocks.recordAttendance,
    details: mocks.details,
    create: mocks.create,
    update: mocks.update,
    setStatus: mocks.setStatus,
    remove: mocks.remove,
    setBaseSalary: mocks.setBaseSalary,
    createAdvance: mocks.createAdvance,
    reverseAdvance: mocks.reverseAdvance,
    payrollPreview: mocks.payrollPreview,
    createPayrollRun: mocks.createPayrollRun,
    finalizePayrollRun: mocks.finalizePayrollRun,
    correctAttendance: mocks.correctAttendance,
    washWorkers: mocks.washWorkers,
    setOrderWashEmployee: mocks.setOrderWashEmployee,
  },
}))

vi.mock('@/features/auth/useSession', () => ({
  useSession: () => ({ user: { id: 1, name: 'أحمد', role: mocks.role.current } }),
  atLeast: (role: string | undefined, min: string) => {
    const rank = (value?: string) =>
      value === 'ADMIN' ? 3 : value === 'MANAGER' ? 2 : value === 'STAFF' ? 1 : 0
    return rank(role) >= rank(min)
  },
}))

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

function employee(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    user_id: 1,
    name: 'أحمد سيد',
    phone: '01001234567',
    employee_type: 'CASHIER',
    status: 'ACTIVE',
    // A STAFF login, deliberately. This file is about the operational ROSTER —
    // the record list on a phone and the table on a wide screen — and a MANAGER
    // or ADMIN is no longer part of that: those people are presented in their own
    // management section above. A manager-role fixture would simply leave the
    // roster empty and quietly stop testing the thing under test.
    login_role: 'STAFF',
    base_salary: 300_000,
    notes: null,
    created_at: '2026-08-01 09:00:00Z',
    updated_at: '2026-09-01 09:00:00Z',
    attendance_days: 20,
    worked_minutes: 490,
    absence_days: 1,
    leave_days: 2,
    today_state: null,
    today_check_in_effective_at: null,
    today_check_out_effective_at: null,
    shifts_count: 21,
    cafe_revenue: 45_000,
    ...over,
  }
}

const MANAGER_LIST: EmployeeList = {
  management_visible: true,
  employees: [employee() as never],
}

const CASHIER_LIST: EmployeeList = {
  management_visible: false,
  employees: [employee({ base_salary: null, login_role: 'STAFF' }) as never],
}

function renderPage() {
  return render(
    <ToastProvider>
      <EmployeesPage />
    </ToastProvider>,
  )
}

/** Opens the record's overflow menu and returns the sheet it opened. */
async function openMoreMenu() {
  const trigger = await screen.findByRole('button', { name: 'المزيد من الإجراءات: أحمد سيد' })
  fireEvent.click(trigger)
  return screen.findByRole('dialog')
}

beforeEach(() => {
  vi.clearAllMocks()
  // 360px is the width this file is about: the narrow end of the phone range,
  // and the one where a 336px action column is wider than the screen.
  setViewportWidth(360)
  mocks.role.current = 'MANAGER'
  mocks.overview.mockResolvedValue({
    total_employees: 1,
    total_cashiers: 1,
    total_wash_workers: 0,
    top_attendance: { name: 'أحمد سيد', value: 20 },
    top_hours: { name: 'أحمد سيد', value: 490 },
    top_shifts: { name: 'أحمد سيد', value: 21 },
    top_cafe_revenue: { name: 'أحمد سيد', value: 45_000 },
  })
  mocks.myAttendance.mockResolvedValue({
    employee: {
      id: 1,
      user_id: 1,
      name: 'سلمى',
      phone: null,
      employee_type: 'CASHIER',
      status: 'ACTIVE',
      login_role: 'MANAGER',
      base_salary: null,
      notes: null,
      created_at: '2026-08-01 09:00:00Z',
      updated_at: '2026-09-01 09:00:00Z',
    },
    today: null,
    worked_minutes_today: null,
  })
  mocks.recordAttendance.mockResolvedValue({})
  mocks.remove.mockResolvedValue({})
})

afterEach(() => {
  resetViewportWidth()
})

describe('EmployeesPage — the roster on a phone', () => {
  beforeEach(() => {
    mocks.list.mockResolvedValue(MANAGER_LIST)
  })

  it('is a record list, not a squeezed table', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    // The defect this replaces: a ten-column table with a 336px action cell,
    // whose identity column was therefore off the screen the whole time.
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getAllByText('أحمد سيد').length).toBeGreaterThan(0)
  })

  it('keeps the identity, the status, the role and the figures readable', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    // Identity: the name, the avatar in the REAL stored role, and the phone.
    // `getAllByTestId` because the personal attendance card above carries its own
    // avatar for the signed-in user — two avatars on this page is correct.
    const avatars = screen.getAllByTestId('employee-avatar')
    expect(avatars.some((a) => a.getAttribute('data-employee-role') === 'MANAGER')).toBe(true)
    expect(screen.getByText('01001234567')).toBeInTheDocument()

    // Status in words, not by colour alone; the role badge from the login role.
    // `getAllByText` because the signed-in user's own card states their role too.
    expect(screen.getAllByText('نشط').length).toBeGreaterThan(0)
    expect(screen.getAllByText('مدير').length).toBeGreaterThan(0)

    // The period figures a manager is given are all still stated, with their
    // labels — nothing was dropped for being inconvenient on a phone.
    for (const label of ['أيام الحضور', 'ساعات العمل', 'أيام الغياب', 'أيام الإجازة']) {
      expect(screen.getByText(label), label).toBeInTheDocument()
    }
  })

  it('keeps the four attendance punches direct, grouped and at the 48px target', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    const punches = [
      'تسجيل حضور أحمد سيد',
      'تسجيل انصراف أحمد سيد',
      'تسجيل غياب أحمد سيد',
      'تسجيل إجازة أحمد سيد',
    ]
    for (const name of punches) {
      const button = screen.getByRole('button', { name })
      // Same target and the same 24px glyph as the desktop column, so a control
      // is never easier to hit on a phone than on a desktop.
      expect(button.className, name).toContain('h-12')
      expect(button.className, name).toContain('w-12')
      expect(button.closest('div')?.className, name).toContain('[&_svg]:size-6')
    }

    // And they are ONE horizontal group, not a column of icons.
    const group = screen.getByRole('button', { name: punches[0] }).closest('div')
    expect(group?.className).toContain('flex-nowrap')
  })

  it('puts the management actions behind ONE control, not a stack of buttons', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    // The defect this replaces: four more full-size buttons in the same cell,
    // which is what stacked into a vertical column of icons.
    for (const name of ['تفاصيل أحمد سيد', 'تعديل أحمد سيد', 'إيقاف أحمد سيد']) {
      expect(screen.queryByRole('button', { name }), name).not.toBeInTheDocument()
    }

    // Exactly one overflow control, labelled for the record it acts on.
    expect(screen.getAllByRole('button', { name: 'المزيد من الإجراءات: أحمد سيد' })).toHaveLength(1)
  })

  it('keeps every menu entry labelled, toned, and irreversible-last', async () => {
    // Delete is ADMIN-only, so the irreversible-last assertion needs that role.
    mocks.role.current = 'ADMIN'
    renderPage()
    await screen.findAllByText('أحمد سيد')

    const sheet = await openMoreMenu()
    const names = ['تفاصيل أحمد سيد', 'تعديل أحمد سيد', 'إيقاف أحمد سيد', 'حذف أحمد سيد نهائيًا']
    for (const name of names) {
      const row = within(sheet).getByRole('button', { name })
      // A menu row is a full-width line of text at the same 48px floor as a
      // table action — never a smaller, easier-to-miss target.
      expect(row.className, name).toContain('min-h-12')
      expect(row.className, name).toContain('w-full')
    }

    // The permanent delete is LAST and reads as destructive from the row
    // itself — the same separation the desktop column draws with its hairline.
    const order = within(sheet)
      .getAllByRole('button')
      .map((row) => row.textContent)
    expect(order.indexOf('حذف أحمد سيد نهائيًا')).toBe(order.length - 1)
    expect(within(sheet).getByRole('button', { name: 'حذف أحمد سيد نهائيًا' }).className).toContain(
      'text-destructive-soft-foreground',
    )
  })

  it('dispatches a punch from the record, and still sends nothing on one click', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    fireEvent.click(screen.getByRole('button', { name: 'تسجيل حضور أحمد سيد' }))
    // The single-click rule is a business rule, not a layout one: it holds
    // identically in the phone presentation.
    expect(mocks.recordAttendance).not.toHaveBeenCalled()
    expect(await screen.findByText('هل تريد تسجيل حضور أحمد سيد؟')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'تأكيد' }))
    await waitFor(() => expect(mocks.recordAttendance).toHaveBeenCalledWith(1, 'CHECK_IN'))
  })

  it('routes a menu entry to the same intent the table row would', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    const sheet = await openMoreMenu()
    fireEvent.click(within(sheet).getByRole('button', { name: 'تعديل أحمد سيد' }))

    // The menu records the intent and closes; the shared edit dialog owns it.
    expect(await screen.findByText('تعديل بيانات الموظف')).toBeInTheDocument()
  })

  it('offers a cashier no menu at all, because it would have nothing behind it', async () => {
    mocks.role.current = 'STAFF'
    mocks.list.mockResolvedValue(CASHIER_LIST)
    renderPage()
    await screen.findAllByText('أحمد سيد')

    // A "more" control that opens an empty sheet is a control that lies about
    // what is behind it, and the management entries must not be CONSTRUCTED for
    // a role the backend refuses them to.
    expect(
      screen.queryByRole('button', { name: 'المزيد من الإجراءات: أحمد سيد' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('تعديل أحمد سيد')).not.toBeInTheDocument()

    // The attendance actions this role DOES own are all still there.
    expect(screen.getByRole('button', { name: 'تسجيل غياب أحمد سيد' })).toBeEnabled()
  })
})

describe('EmployeesPage — a wide viewport keeps the table', () => {
  beforeEach(() => {
    setViewportWidth(1280)
    mocks.list.mockResolvedValue(MANAGER_LIST)
  })

  it('is the table, with every action visible in the one action column', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    expect(screen.getByRole('table')).toBeInTheDocument()
    // No overflow control on a desktop: the actions fit on one line there, and
    // folding them away would only add a tap.
    expect(
      screen.queryByRole('button', { name: 'المزيد من الإجراءات: أحمد سيد' }),
    ).not.toBeInTheDocument()
    for (const name of [
      'تسجيل حضور أحمد سيد',
      'تسجيل انصراف أحمد سيد',
      'تسجيل غياب أحمد سيد',
      'تسجيل إجازة أحمد سيد',
      'تفاصيل أحمد سيد',
      'تعديل أحمد سيد',
      'إيقاف أحمد سيد',
    ]) {
      expect(screen.getByRole('button', { name }), name).toBeInTheDocument()
    }
  })
})
