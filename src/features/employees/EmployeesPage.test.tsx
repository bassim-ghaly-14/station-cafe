/**
 * The employees page is the security-sensitive screen of this feature, so its
 * tests assert what each role is actually GIVEN, not what it hides:
 *
 *  - a manager receives the full payload: the KPI band, salaries, the create
 *    action and the details drawer;
 *  - a cashier receives a list with no salary at all and no management flag, the
 *    page never asks the backend for the analytics it may not have, and the
 *    create/edit actions are not built at all;
 *  - a punch is dispatched through the shared API with the employee's id and
 *    the wire action — and a refused punch is reported, never swallowed.
 *
 * Confirmation
 * ------------
 * No state-changing action fires from one click. Each of these tests therefore
 * asserts the pair: the click produces a dialog AND sends nothing, and only the
 * confirm button (or an explicit cancel) resolves it. This is an interaction
 * rule, not an authorization one — the service re-checks the caller's authority
 * regardless of what the dialog offered, which is covered by the Rust suite.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { ToastProvider } from '@/components/ui'
import EmployeesPage from './EmployeesPage'
import type { EmployeeList, EmployeeOverview, MyAttendance } from '@/services/employeesApi'

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
    // The login role is what the table's badge is built from — a manager's
    // employee type is also CASHIER, and that is exactly the trap this fixes.
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

// The backend sends no salary key at all for a cashier.
const CASHIER_LIST: EmployeeList = {
  management_visible: false,
  employees: [employee({ base_salary: null }) as never],
}

// A mixed roster: a manager, a cashier and a wash worker, each with the login
// role the database actually stores for them. Phone numbers are distinct per row
// so a query for one can never match another.
const MIXED_LIST: EmployeeList = {
  management_visible: true,
  employees: [
    employee({
      id: 1,
      name: 'مدير المحل',
      phone: '01000000001',
      login_role: 'MANAGER',
    }) as never,
    employee({ id: 2, name: 'أحمد سيد', phone: '01000000002', login_role: 'STAFF' }) as never,
    employee({
      id: 3,
      name: 'محمود',
      user_id: null,
      phone: '01000000003',
      employee_type: 'WASH_WORKER',
      login_role: null,
      shifts_count: 0,
      cafe_revenue: 0,
    }) as never,
  ],
}

const OVERVIEW: EmployeeOverview = {
  total_employees: 5,
  total_cashiers: 3,
  total_wash_workers: 2,
  top_attendance: { employee_id: 1, name: 'أحمد سيد', value: 20 },
  top_hours: { employee_id: 1, name: 'أحمد سيد', value: 490 },
  top_shifts: { employee_id: 1, name: 'أحمد سيد', value: 21 },
  top_cafe_revenue: { employee_id: 1, name: 'أحمد سيد', value: 45_000 },
}

const NOT_PUNCHED: MyAttendance = {
  employee: {
    id: 1,
    user_id: 1,
    name: 'أحمد سيد',
    phone: null,
    employee_type: 'CASHIER',
    status: 'ACTIVE',
    login_role: 'STAFF',
    base_salary: 300_000,
    notes: null,
    created_at: '2026-08-01 09:00:00Z',
    updated_at: '2026-09-01 09:00:00Z',
  },
  today: null,
  worked_minutes_today: null,
  active_shift_id: null,
}

/** The own-attendance card's heading, used by the layout assertions below. */
const CARD_TITLE = 'حضوري اليوم'

/** A manager-level drawer payload holding one RECORDED day. */
function detailsWith(over: Record<string, unknown> = {}) {
  return {
    employee: NOT_PUNCHED.employee,
    period_row: null,
    attendance: [
      {
        id: 4,
        employee_id: 1,
        business_date: '2026-09-27',
        state: 'PRESENT',
        check_in_actual_at: '2026-09-27 06:13:00Z',
        check_in_effective_at: '2026-09-27 06:10:00Z',
        check_out_actual_at: '2026-09-27 15:16:00Z',
        check_out_effective_at: '2026-09-27 15:20:00Z',
        worked_minutes: 550,
        shift_id: null,
        recorded_by_user_id: 1,
        recorded_by_name: 'أحمد سيد',
        note: null,
        ...over,
      },
    ],
    advances: [],
    payroll: [],
  }
}

function renderPage() {
  return render(
    <ToastProvider>
      <EmployeesPage />
    </ToastProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.role.current = 'MANAGER'
  mocks.overview.mockResolvedValue(OVERVIEW)
  mocks.myAttendance.mockResolvedValue(NOT_PUNCHED)
  mocks.recordAttendance.mockResolvedValue({})
})

describe('EmployeesPage — manager', () => {
  beforeEach(() => {
    mocks.list.mockResolvedValue(MANAGER_LIST)
  })

  it('renders the KPI band and the roster', async () => {
    renderPage()
    expect(await screen.findByText('إجمالي الموظفين')).toBeInTheDocument()
    // Attendance and hours leaders span BOTH types; the money tiles are
    // type-scoped, and each names a real employee.
    expect(screen.getByText('الأكثر حضورًا')).toBeInTheDocument()
    expect(screen.getByText('أعلى إيراد كافيه')).toBeInTheDocument()
    // There is deliberately no per-worker wash revenue leader: the wash
    // department's money belongs to the department, not to an individual.
    expect(screen.queryByText('أعلى إيراد مغسلة')).not.toBeInTheDocument()
    expect(screen.queryByText('أكثر فواتير مغسلة')).not.toBeInTheDocument()
    expect((await screen.findAllByText('أحمد سيد')).length).toBeGreaterThan(0)
  })

  it('offers the create action and the edit control', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')
    expect(screen.getByRole('button', { name: 'إضافة موظف' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'تعديل أحمد سيد' })).toBeInTheDocument()
  })

  it('dispatches a punch through the shared API with the employee id', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    // The click OPENS a confirmation and sends nothing. This is the whole point
    // of the flow: an attendance day is a fact people are paid from, so it never
    // changes from a single click.
    fireEvent.click(screen.getByRole('button', { name: 'تسجيل حضور أحمد سيد' }))
    expect(mocks.recordAttendance).not.toHaveBeenCalled()

    // The dialog states WHO and WHAT, then the confirm button performs it.
    expect(await screen.findByText('هل تريد تسجيل حضور أحمد سيد؟')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد' }))

    await waitFor(() => expect(mocks.recordAttendance).toHaveBeenCalledWith(1, 'CHECK_IN'))
  })

  it('states the rounding rule for a punch and the closed-day warning for an absence', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    // The two punches are a moment and carry the stored-time rounding rule…
    fireEvent.click(screen.getByRole('button', { name: 'تسجيل حضور أحمد سيد' }))
    expect(
      await screen.findByText(
        'يُقرَّب وقت الحضور للخلف ووقت الانصراف للأمام، بما لا يتجاوز ١٠ دقائق.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // …while closing the whole day is irreversible and says so, and neither
    // punch nor absence is presented as a destructive confirmation.
    fireEvent.click(screen.getByRole('button', { name: 'تسجيل غياب أحمد سيد' }))
    const absence = await screen.findByRole('dialog')
    expect(
      within(absence).getByText(
        'سيُسجَّل هذا اليوم غيابًا، ولا يمكن تغييره إلى حضور أو انصراف بعد التأكيد.',
      ),
    ).toBeInTheDocument()
    expect(within(absence).getByRole('button', { name: 'تأكيد' }).className).not.toMatch(
      /destructive/,
    )
  })

  it('cancelling a punch sends nothing at all', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    fireEvent.click(screen.getByRole('button', { name: 'تسجيل حضور أحمد سيد' }))
    fireEvent.click(await screen.findByRole('button', { name: 'إلغاء' }))

    // The dialog closes and no request is ever made — cancel is a real exit.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mocks.recordAttendance).not.toHaveBeenCalled()
  })

  it('confirms every attendance action, not just the check-in', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    // Absence and leave close a whole day, which is the irreversible half of this
    // surface, so each states its own sentence and its own consequence.
    for (const [label, question, consequence] of [
      [
        'تسجيل غياب أحمد سيد',
        'هل تريد تسجيل غياب أحمد سيد لهذا اليوم؟',
        'سيُسجَّل هذا اليوم غيابًا، ولا يمكن تغييره إلى حضور أو انصراف بعد التأكيد.',
      ],
      [
        'تسجيل إجازة أحمد سيد',
        'هل تريد تسجيل إجازة أحمد سيد لهذا اليوم؟',
        'سيُسجَّل هذا اليوم إجازة، ولا يمكن تغييره إلى حضور أو انصراف بعد التأكيد.',
      ],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(await screen.findByText(question)).toBeInTheDocument()
      expect(screen.getByText(consequence)).toBeInTheDocument()
      expect(mocks.recordAttendance).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    }
    expect(mocks.recordAttendance).not.toHaveBeenCalled()
  })

  it('reports a refused punch instead of swallowing it', async () => {
    mocks.recordAttendance.mockRejectedValue({ message: 'attendance.already_checked_in' })
    renderPage()
    await screen.findAllByText('أحمد سيد')

    fireEvent.click(screen.getByRole('button', { name: 'تسجيل حضور أحمد سيد' }))
    fireEvent.click(await screen.findByRole('button', { name: 'تأكيد' }))

    expect(await screen.findByText('تم تسجيل الحضور اليوم بالفعل')).toBeInTheDocument()
  })

  it('searches live through the backend', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    fireEvent.change(screen.getByLabelText('بحث عن موظف'), { target: { value: 'سيد' } })

    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith('سيد', { from: '', to: '' }, false),
    )
  })

  it("shows the cashier's own attendance panel for a manager too", async () => {
    // Attendance belongs to the person, not to the permission: a manager clocks
    // in like anybody else.
    renderPage()
    expect(await screen.findByText('حضوري اليوم')).toBeInTheDocument()
    // "Not recorded" must never be phrased as an absence.
    expect(screen.getByText('لم يتم تسجيل حضورك اليوم')).toBeInTheDocument()
  })
})

describe('EmployeesPage — cashier', () => {
  beforeEach(() => {
    mocks.role.current = 'STAFF'
    mocks.list.mockResolvedValue(CASHIER_LIST)
  })

  it('never asks the backend for the analytics it may not have', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')
    // The hook is unconditional (hook order must not follow the role) but with
    // `enabled = false` it issues no request at all.
    expect(mocks.overview).not.toHaveBeenCalled()
    expect(screen.queryByText('إجمالي الموظفين')).not.toBeInTheDocument()
  })

  it('does not build the management actions at all', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')
    expect(screen.queryByRole('button', { name: 'إضافة موظف' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'تعديل أحمد سيد' })).not.toBeInTheDocument()
  })

  it('still shows the roster and the personal attendance panel', async () => {
    renderPage()
    // The reduced view is not "the same page with columns hidden": the roster
    // and the punch panel are genuinely there, and no figure was ever sent.
    expect(await screen.findByText('حضوري اليوم')).toBeInTheDocument()
    expect((await screen.findAllByText('أحمد سيد')).length).toBeGreaterThan(0)
  })

  it('offers a colleague absence and leave, not just the punches', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')
    // The roster is an attendance-operation table, so the cashier can file an
    // absence or a leave for a colleague — the same four actions a manager gets.
    // Only the day's own state disables them, and this day is untouched.
    expect(screen.getByRole('button', { name: 'تسجيل غياب أحمد سيد' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'تسجيل إجازة أحمد سيد' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'تسجيل حضور أحمد سيد' })).toBeEnabled()
  })

  it('is offered no management action at all', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')
    // Every one of these is a Tauri command the backend refuses for a cashier;
    // the screen must not build the control either.
    expect(screen.queryByRole('button', { name: 'إضافة موظف' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'تعديل أحمد سيد' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'إيقاف أحمد سيد' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'تفاصيل أحمد سيد' })).not.toBeInTheDocument()
  })

  it('builds no cell for a figure the backend did not send', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')
    // The reduced view is not the same table with columns hidden: these cells are
    // never constructed, because the payload carries no such values.
    expect(screen.queryByText('أيام الحضور')).not.toBeInTheDocument()
    expect(screen.queryByText('ساعات العمل')).not.toBeInTheDocument()
    expect(screen.queryByText('أيام الغياب')).not.toBeInTheDocument()
    expect(screen.queryByText('أيام الإجازة')).not.toBeInTheDocument()
    expect(screen.queryByText('الأداء')).not.toBeInTheDocument()
    // The attendance column it DOES build is today's, which is what a punch needs.
    expect(screen.getByText('حضور اليوم')).toBeInTheDocument()
  })

  it('shows the cashier their own name, avatar and phone', async () => {
    mocks.myAttendance.mockResolvedValue({
      ...NOT_PUNCHED,
      employee: {
        ...NOT_PUNCHED.employee!,
        name: 'أحمد سيد',
        phone: '01001234567',
      },
    })
    renderPage()
    expect(await screen.findByText('حضوري اليوم')).toBeInTheDocument()
    // Their own record is the one employee data a cashier is shown in full. The
    // phone legitimately appears twice — on the personal card and on their own
    // roster row — because the two are the same person.
    expect(screen.getAllByText('أحمد سيد').length).toBeGreaterThan(0)
    expect(screen.getAllByText('01001234567').length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('employee-avatar').length).toBeGreaterThan(0)
  })

  it('is not offered the deactivate action', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')
    expect(screen.queryByRole('button', { name: 'إيقاف أحمد سيد' })).not.toBeInTheDocument()
  })
})

/*
 * The regression this page existed to get wrong.
 *
 * Every login in Station is a `CASHIER` employee, so a table that renders the
 * employee TYPE prints "كاشير" on every row — including the manager's and the
 * admin's. These tests pin the role to the persisted login role instead, and
 * pin the wash department's revenue to the department rather than to a person.
 */
describe('EmployeesPage — role presentation', () => {
  beforeEach(() => {
    mocks.role.current = 'MANAGER'
    mocks.list.mockResolvedValue(MIXED_LIST)
  })

  it('shows each person their real stored role, not a uniform "كاشير"', async () => {
    renderPage()
    await screen.findAllByText('مدير المحل')

    // The manager's employee TYPE is CASHIER too; the badge must still say مدير.
    // The session user is a STAFF, so "كاشير" legitimately appears twice: once on
    // their own personal card and once on their roster row.
    expect(screen.getByText('مدير')).toBeInTheDocument()
    expect(screen.getAllByText('كاشير').length).toBeGreaterThan(0)
    expect(screen.getByText('عامل مغسلة')).toBeInTheDocument()
  })

  it('gives the avatar the same role as the badge', async () => {
    renderPage()
    await screen.findAllByText('مدير المحل')
    // The wash worker is a role in their own right, not a missing role: it keeps
    // its own identity marker instead of falling into the generic fallback.
    const avatars = screen.getAllByTestId('employee-avatar')
    expect(avatars.map((node) => node.getAttribute('data-employee-role'))).toEqual(
      expect.arrayContaining(['MANAGER', 'STAFF', 'WASH_WORKER']),
    )
  })

  it('shows the phone number of every role from the employee record', async () => {
    renderPage()
    await screen.findAllByText('محمود')
    // One per row, straight from `employees.phone` — a manager, a cashier and a
    // wash worker all carry one, and none of them borrows a second field.
    expect(screen.getByText('01000000001')).toBeInTheDocument()
    expect(screen.getByText('01000000002')).toBeInTheDocument()
    expect(screen.getByText('01000000003')).toBeInTheDocument()
  })

  it('gives a wash worker no individual revenue figure', async () => {
    renderPage()
    await screen.findAllByText('محمود')
    // The performance cell states that the money is the department's, instead of
    // printing a personal wash revenue the domain does not have.
    expect(screen.getAllByText('إيراد القسم — لا يُنسب لفرد').length).toBeGreaterThan(0)
  })

  it('distinguishes an active employee from a stopped one', async () => {
    mocks.list.mockResolvedValue({
      management_visible: true,
      employees: [
        employee({ id: 1, name: 'شخص أول', status: 'ACTIVE' }) as never,
        employee({ id: 2, name: 'شخص ثاني', status: 'INACTIVE' }) as never,
      ],
    })
    renderPage()
    await screen.findAllByText('شخص ثاني')
    // The state is stated in words, not left to colour alone.
    expect(screen.getByText('نشط')).toBeInTheDocument()
    expect(screen.getByText('غير نشط')).toBeInTheDocument()
    // The stopped row offers reactivation rather than a punch it cannot take.
    expect(screen.getByRole('button', { name: 'تنشيط شخص ثاني' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'إيقاف شخص أول' })).toBeInTheDocument()
  })

  it('deactivates through the status command, never a delete', async () => {
    mocks.list.mockResolvedValue({
      management_visible: true,
      employees: [employee({ id: 7, name: 'أحمد سيد' }) as never],
    })
    mocks.setStatus.mockResolvedValue(undefined)
    renderPage()
    await screen.findAllByText('أحمد سيد')

    fireEvent.click(screen.getByRole('button', { name: 'إيقاف أحمد سيد' }))

    // Stopping an account is as serious as a punch, so it is confirmed too — and
    // the consequence is spelled out before the user commits.
    expect(mocks.setStatus).not.toHaveBeenCalled()
    expect(await screen.findByText('هل تريد إيقاف أحمد سيد؟')).toBeInTheDocument()
    expect(
      screen.getByText(
        'لن يستطيع أحمد سيد تسجيل الدخول أو تسجيل الحضور بعد الآن. لن يتم حذف بياناته أو سجلاته السابقة.',
      ),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'تأكيد' }))

    // INACTIVE, not a removal: the employee keeps their history.
    await waitFor(() => expect(mocks.setStatus).toHaveBeenCalledWith(7, 'INACTIVE'))
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('confirms the status change in words, not a raw translation key', async () => {
    mocks.list.mockResolvedValue({
      management_visible: true,
      employees: [employee({ id: 7, name: 'أحمد سيد' }) as never],
    })
    mocks.setStatus.mockResolvedValue(undefined)
    renderPage()
    await screen.findAllByText('أحمد سيد')

    fireEvent.click(screen.getByRole('button', { name: 'إيقاف أحمد سيد' }))
    fireEvent.click(await screen.findByRole('button', { name: 'تأكيد' }))

    // The confirmation is built from the status value, so the catalogue has to
    // carry a key for each one — a mismatch here would print `employees.…` to
    // the user instead of a sentence.
    expect(await screen.findByText('تم إيقاف الموظف')).toBeInTheDocument()
  })

  it('confirms a reactivation and says what it restores', async () => {
    mocks.list.mockResolvedValue({
      management_visible: true,
      employees: [employee({ id: 7, name: 'أحمد سيد', status: 'INACTIVE' }) as never],
    })
    mocks.setStatus.mockResolvedValue(undefined)
    renderPage()
    await screen.findAllByText('أحمد سيد')

    fireEvent.click(screen.getByRole('button', { name: 'تنشيط أحمد سيد' }))
    expect(mocks.setStatus).not.toHaveBeenCalled()
    // The opposite direction gets its own sentence, not a reused one.
    expect(await screen.findByText('هل تريد تنشيط أحمد سيد؟')).toBeInTheDocument()
    expect(
      screen.getByText('سيستعيد أحمد سيد إمكانية تسجيل الدخول وتسجيل الحضور.'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'تأكيد' }))
    await waitFor(() => expect(mocks.setStatus).toHaveBeenCalledWith(7, 'ACTIVE'))
  })
})

/**
 * The administrative override, on the attendance timeline inside the drawer.
 *
 * These assert what each role is GIVEN. Hiding the action is an affordance, not
 * the boundary — a STAFF session that reached `override_employee_attendance`
 * anyway is refused by the service, which is covered in the Rust suite.
 */
describe('EmployeesPage — attendance override', () => {
  beforeEach(() => {
    mocks.list.mockResolvedValue(MANAGER_LIST)
    mocks.details.mockResolvedValue(detailsWith())
  })

  async function openTimeline() {
    renderPage()
    await screen.findAllByText('أحمد سيد')
    fireEvent.click(screen.getAllByRole('button', { name: 'تفاصيل أحمد سيد' })[0])
    await screen.findByText('سجل الحضور')
  }

  it('offers a manager the override on a recorded day, and the dialog it opens', async () => {
    mocks.role.current = 'MANAGER'
    await openTimeline()

    // The action names the person and the day, so the accessible name is unique
    // and states which record would be rewritten.
    const action = screen.getByRole('button', { name: 'تعديل حضور أحمد سيد ليوم 2026-09-27' })
    expect(action).toBeInTheDocument()

    fireEvent.click(action)
    // The dialog opens on the day as it stands and announces what it is. The
    // values are asserted INSIDE the dialog: the timeline behind it shows the
    // same pair, and it is the dialog's own "current" that matters here.
    expect(await screen.findByText('تعديل حضور الموظف')).toBeInTheDocument()
    // The drawer behind it is a dialog too, so the override one is picked out by
    // the sentence that only it carries.
    const dialog = screen
      .getAllByRole('dialog')
      .find((candidate) => within(candidate).queryByText(i18n.t('employees.override.adminNote')))
    expect(dialog).toBeDefined()
    expect(within(dialog!).getByText('09:10')).toBeInTheDocument()
    expect(within(dialog!).getByText('18:20')).toBeInTheDocument()
  })

  it('never builds the action for a day that carries no punch pair', async () => {
    mocks.role.current = 'MANAGER'
    // An ABSENT day has no times to correct — that is `correct_attendance`'s job.
    mocks.details.mockResolvedValue(
      detailsWith({ state: 'ABSENT', check_in_actual_at: null, check_in_effective_at: null }),
    )
    await openTimeline()
    expect(
      screen.queryByRole('button', { name: 'تعديل حضور أحمد سيد ليوم 2026-09-27' }),
    ).not.toBeInTheDocument()
  })

  it('is not offered to a cashier at all', async () => {
    mocks.role.current = 'STAFF'
    mocks.list.mockResolvedValue(CASHIER_LIST)
    renderPage()
    await screen.findAllByText('أحمد سيد')

    // A cashier's roster carries no management payload, so the drawer they open
    // is never rendered and no override control exists anywhere in the DOM.
    expect(mocks.details).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /تعديل حضور/ })).not.toBeInTheDocument()
  })
})

/**
 * The personal attendance card is mounted for EVERY role, so it is the one
 * surface a CASHIER is certain to touch — including their own punch. The same
 * no-single-click rule applies there, and the copy names the user themselves
 * rather than a colleague.
 */
describe('EmployeesPage — own attendance card', () => {
  beforeEach(() => {
    mocks.role.current = 'STAFF'
    mocks.list.mockResolvedValue(CASHIER_LIST)
  })

  it('confirms the user their own check-in before sending it', async () => {
    renderPage()
    await screen.findByText(CARD_TITLE)

    fireEvent.click(screen.getByRole('button', { name: 'حضور' }))
    // Nothing is sent by the click, and the copy speaks to the user directly.
    expect(mocks.recordAttendance).not.toHaveBeenCalled()
    expect(await screen.findByText('هل تريد تسجيل حضورك الآن؟')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'تأكيد' }))
    await waitFor(() => expect(mocks.recordAttendance).toHaveBeenCalledWith(1, 'CHECK_IN'))
  })

  it('cancelling the personal check-in sends nothing', async () => {
    renderPage()
    await screen.findByText(CARD_TITLE)

    fireEvent.click(screen.getByRole('button', { name: 'حضور' }))
    fireEvent.click(await screen.findByRole('button', { name: 'إلغاء' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mocks.recordAttendance).not.toHaveBeenCalled()
  })

  it('confirms a personal check-out and states the rounding rule', async () => {
    // An open day: check-out is the available action.
    mocks.myAttendance.mockResolvedValue({
      ...NOT_PUNCHED,
      today: {
        state: 'PRESENT',
        check_in_effective_at: '2026-09-27 06:10:00Z',
        check_out_effective_at: null,
      },
    })
    renderPage()
    await screen.findByText(CARD_TITLE)

    fireEvent.click(screen.getByRole('button', { name: 'انصراف' }))
    expect(await screen.findByText('هل تريد تسجيل انصرافك الآن؟')).toBeInTheDocument()
    // The stored time is deliberately not the wall clock, so the rule is stated.
    expect(
      screen.getByText('يُقرَّب وقت الحضور للخلف ووقت الانصراف للأمام، بما لا يتجاوز ١٠ دقائق.'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'تأكيد' }))
    await waitFor(() => expect(mocks.recordAttendance).toHaveBeenCalledWith(1, 'CHECK_OUT'))
  })
})

describe('EmployeesPage — action column legibility', () => {
  beforeEach(() => {
    mocks.role.current = 'MANAGER'
    mocks.list.mockResolvedValue(MANAGER_LIST)
  })

  it('renders every action icon at a larger size with a 48px hit area', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    // The icon column is the screen's most-used control, and it was previously
    // rendering 16px glyphs inside 40px boxes no matter what size was passed.
    // The group carries a scoped 24px override and each button uses the 48px
    // `icon-lg` variant, so the glyph is bigger AND easier to hit.
    const actions = screen.getByRole('button', { name: 'تسجيل حضور أحمد سيد' })
    const group = actions.closest('div')
    expect(group?.className).toContain('[&_svg]:size-6')
    expect(actions.className).toContain('h-12')
    expect(actions.className).toContain('w-12')

    // Every state-changing action gets the same treatment, not just the first.
    for (const name of [
      'تسجيل انصراف أحمد سيد',
      'تسجيل غياب أحمد سيد',
      'تسجيل إجازة أحمد سيد',
      'تفاصيل أحمد سيد',
      'تعديل أحمد سيد',
      'إيقاف أحمد سيد',
    ]) {
      const button = screen.getByRole('button', { name })
      expect(button.className, `${name} should use the 48px target`).toContain('h-12')
      expect(button.closest('div')?.className).toContain('[&_svg]:size-6')
    }
  })

  it('keeps a readable accessible name on every action', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    // Growing the glyph must not cost the label: the accessible name is what a
    // screen reader announces, and the `title` is the hover affordance.
    for (const [name, title] of [
      ['تسجيل حضور أحمد سيد', 'حضور'],
      ['تسجيل انصراف أحمد سيد', 'انصراف'],
      ['تسجيل غياب أحمد سيد', 'غياب'],
      ['تسجيل إجازة أحمد سيد', 'إجازة'],
    ] as const) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveAttribute('title', title)
    }
  })
})

/**
 * The attendance card is a single horizontal band of zones, not a stack of
 * short rows. These assert the STRUCTURE rather than the pixels: the band is a
 * row at desktop width, the related figures share one parent, and the narrow
 * fallback wraps instead of shrinking type.
 */
describe('EmployeesPage — own attendance card layout', () => {
  beforeEach(() => {
    mocks.role.current = 'MANAGER'
    mocks.list.mockResolvedValue(MANAGER_LIST)
  })

  it('lays today out as one horizontal band, not a vertical stack', async () => {
    mocks.myAttendance.mockResolvedValue({
      ...NOT_PUNCHED,
      today: {
        state: 'PRESENT',
        check_in_effective_at: '2026-09-27 06:10:00Z',
        check_out_effective_at: '2026-09-27 14:30:00Z',
      },
      worked_minutes_today: 500,
    })
    renderPage()
    await screen.findByText(CARD_TITLE)

    // The card is ONE row of zones at desktop width (`lg:flex-row`) instead of
    // four stacked lines that left most of the card empty.
    const heading = screen.getByText(CARD_TITLE)
    const band = heading.closest('[class*="lg:flex-row"]')
    expect(band?.className).toContain('lg:flex-row')

    // Related values sit together: every figure is a SIBLING inside ONE zone, so
    // they are read across rather than stacked. The lookup is scoped to the
    // card's CAPTION labels, because "حضور" is also the check-in button's name.
    const caption = (text: string) =>
      Array.from(band?.querySelectorAll('span') ?? []).find(
        (node) => node.className.includes('truncate') && node.textContent === text,
      )
    const inFigure = caption('حضور')?.parentElement
    const outFigure = caption('انصراف')?.parentElement
    expect(inFigure).toBeDefined()
    // One shared zone, so the three figures occupy a single horizontal run.
    expect(inFigure?.parentElement).toBe(outFigure?.parentElement)
    // And the settled duration is labelled rather than floating unlabelled.
    expect(caption('ساعات العمل')).toBeDefined()
  })

  it('stacks cleanly on a narrow screen without forcing tiny type', async () => {
    renderPage()
    await screen.findByText(CARD_TITLE)

    // `flex-col` is the base and `lg:flex-row` is the enhancement, so a narrow
    // screen gets the stacked layout rather than a horizontal overflow.
    const band = screen.getByText(CARD_TITLE).closest('[class*="lg:flex-row"]')
    expect(band?.className).toContain('flex-col')

    // The dividers only make sense side by side, so they are hidden when the
    // zones stack and are revealed from the `sm` breakpoint.
    for (const divider of band?.children ?? []) {
      if (divider.getAttribute('aria-hidden') === 'true') {
        expect(divider.className).toContain('hidden')
        expect(divider.className).toContain('sm:block')
      }
    }

    // The layout is fixed by WRAPPING, never by shrinking the text: nothing on
    // the card drops below the caption token.
    const card = band?.closest('div')
    const tiny = Array.from(card?.querySelectorAll('*') ?? []).filter((node) =>
      /text-\[(9|10|11)px\]/.test(node.className),
    )
    expect(tiny).toHaveLength(0)
  })
})

describe('EmployeesPage — states', () => {
  beforeEach(() => {
    mocks.role.current = 'MANAGER'
  })

  it('shows a loading placeholder before the first list arrives', () => {
    mocks.list.mockReturnValue(new Promise(() => {}))
    renderPage()
    expect(screen.getByLabelText('جارٍ تحميل الجدول')).toBeInTheDocument()
  })

  it('distinguishes "no employees" from "no search results"', async () => {
    mocks.list.mockResolvedValue({ management_visible: true, employees: [] })
    renderPage()
    expect(await screen.findByText('لا يوجد موظفون مسجلون بعد')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('بحث عن موظف'), { target: { value: 'لا يوجد' } })
    expect(await screen.findByText('لا يوجد موظفون مطابقون للبحث')).toBeInTheDocument()
  })

  it('reports a failed list with a retry, not an empty table', async () => {
    mocks.list.mockRejectedValue({ message: 'db.error' })
    renderPage()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /إعادة المحاولة/ })).toBeInTheDocument()
  })
})

/**
 * Permanent deletion — ADMIN only.
 *
 * Three separate guarantees are asserted here, and none of them is "the button
 * is missing", because a hidden button is not a security control:
 *
 *  - **visibility** — only an ADMIN is offered the destructive action;
 *  - **confirmation** — the click produces a dialog and sends NOTHING, only the
 *    confirm button resolves it, and cancel sends nothing either;
 *  - **feedback** — success toasts and refreshes, while a backend refusal
 *    (an employee with history) is reported in Arabic and never read as success.
 *
 * The matching authorization guarantee — that a MANAGER or CASHIER cannot
 * invoke `delete_employee` at all — is a service rule and is covered by the
 * Rust suite in `deletion_test.rs`.
 */
describe('EmployeesPage — permanent delete (ADMIN only)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.role.current = 'ADMIN'
    mocks.overview.mockResolvedValue(OVERVIEW)
    mocks.myAttendance.mockResolvedValue(NOT_PUNCHED)
    mocks.list.mockResolvedValue(MANAGER_LIST)
    mocks.remove.mockResolvedValue(undefined)
  })

  function deleteButton() {
    return screen.getByTestId('employee-row-delete')
  }

  it('offers the delete action to an ADMIN', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')
    expect(deleteButton()).toBeInTheDocument()
  })

  it('does not offer it to a MANAGER or a CASHIER', async () => {
    for (const role of ['MANAGER', 'STAFF'] as const) {
      mocks.role.current = role
      const view = renderPage()
      await screen.findAllByText('أحمد سيد')
      expect(screen.queryByTestId('employee-row-delete')).not.toBeInTheDocument()
      view.unmount()
    }
  })

  it('confirms before deleting, and the click alone sends nothing', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    fireEvent.click(deleteButton())

    const dialog = await screen.findByRole('dialog')
    // The confirmation names the person and states the action is permanent.
    expect(within(dialog).getByText('هل أنت متأكد من حذف «أحمد سيد» نهائيًا؟')).toBeInTheDocument()
    expect(within(dialog).getByText(/لا يمكن التراجع/)).toBeInTheDocument()
    // The primary button says "permanent delete", not a generic "confirm".
    expect(within(dialog).getByRole('button', { name: 'حذف نهائي' })).toBeInTheDocument()
    // Nothing has been sent yet.
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('cancels without sending anything', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    fireEvent.click(deleteButton())
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('deletes on confirm and refreshes the employee queries', async () => {
    renderPage()
    await screen.findAllByText('أحمد سيد')

    fireEvent.click(deleteButton())
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'حذف نهائي' }))

    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(1))
    // The success feedback is shown, and the roster is refetched so the deleted
    // employee leaves the table.
    expect(await screen.findByText(/تم حذف الموظف/)).toBeInTheDocument()
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })

  it('reports a backend refusal in Arabic and never claims success', async () => {
    // The service refuses an employee with attendance, advances or payroll
    // history. The page must surface that, not swallow it and not toast success.
    mocks.remove.mockRejectedValue({ kind: 'business_rule', message: 'employee.has_history' })

    renderPage()
    await screen.findAllByText('أحمد سيد')

    fireEvent.click(deleteButton())
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'حذف نهائي' }))

    expect(await screen.findByText(/لا يمكن حذف الموظف لوجود سجلات حضور/)).toBeInTheDocument()
    expect(screen.queryByText(/تم حذف الموظف/)).not.toBeInTheDocument()
  })
})
