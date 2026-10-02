/**
 * Typed wrappers over the employees management command surface.
 *
 * Every call goes through the Tauri IPC bridge to a Rust service — there is no
 * `fetch`, no remote endpoint and no client-side aggregation. The types mirror
 * the backend payloads exactly so a field can never be invented in the browser.
 */

import { call } from './ipc'

/** Inclusive business-date bounds; empty means unbounded, like the reports. */
export interface EmployeePeriod {
  from?: string | null
  to?: string | null
}

/** The operational employee type. NOT an auth role and NOT a permission. */
export type EmployeeType = 'CASHIER' | 'WASH_WORKER'

/**
 * The auth role a person may hold. Mirrors `auth::ROLES`.
 *
 * This is the role the employees table presents, and it is deliberately NOT the
 * employee type: every login is a `CASHIER` employee, so the type alone would
 * label a manager "كاشير".
 */
export type LoginRole = 'ADMIN' | 'MANAGER' | 'STAFF'

/** An attendance event. Mirrors the backend's SCREAMING_SNAKE deserialization. */
export type AttendanceAction = 'CHECK_IN' | 'CHECK_OUT' | 'ABSENT' | 'LEAVE'

export type AttendanceState = 'PRESENT' | 'ABSENT' | 'LEAVE'

export interface Employee {
  id: number
  /** The login this employee authenticates with. `null` for a wash worker. */
  user_id: number | null
  name: string
  phone: string | null
  employee_type: EmployeeType
  status: 'ACTIVE' | 'INACTIVE'
  /**
   * The linked login's role, or `null` for a wash worker.
   *
   * This is what the role badge and the avatar are built from. `employee_type`
   * describes the job; only this says whether the person is an admin, a manager
   * or a plain staff member.
   */
  login_role: LoginRole | null
  /** Monthly base salary in piasters. */
  base_salary: number
  notes: string | null
  created_at: string
  updated_at: string
}

export interface AttendanceDay {
  id: number
  employee_id: number
  business_date: string
  state: AttendanceState
  /** The untouched clock reading, preserved for audit. */
  check_in_actual_at: string | null
  /** The business-rounded instant every calculation reads. */
  check_in_effective_at: string | null
  check_out_actual_at: string | null
  check_out_effective_at: string | null
  /** Minutes between the EFFECTIVE punches; `null` while the day is open. */
  worked_minutes: number | null
  shift_id: number | null
  /** Always the authenticated session user — the only trace of who recorded a wash worker. */
  recorded_by_user_id: number
  recorded_by_name: string
  note: string | null
}

/** One list row, with every period figure already aggregated by SQL. */
export interface EmployeeRow {
  id: number
  user_id: number | null
  name: string
  phone: string | null
  employee_type: EmployeeType
  status: 'ACTIVE' | 'INACTIVE'
  /** See {@link Employee.login_role} — the role the table presents. */
  login_role: LoginRole | null
  /**
   * `null` for a caller the backend does not send a salary to. See
   * {@link EmployeeList.management_visible} — these fields are ABSENT, not zeroed.
   */
  base_salary: number | null
  notes: string | null
  created_at: string
  updated_at: string
  /**
   * Period HR analytics. `null` for an attendance-only caller: how many days a
   * colleague was absent last month is management information, not something
   * needed to punch them today.
   */
  attendance_days: number | null
  worked_minutes: number | null
  absence_days: number | null
  leave_days: number | null
  /** TODAY's live state, outside the selected period on purpose. */
  today_state: AttendanceState | null
  today_check_in_effective_at: string | null
  today_check_out_effective_at: string | null
  /**
   * Cashier performance: the shifts this login opened and the cafe money booked
   * to them.
   *
   * There is no per-worker wash revenue anywhere in this payload. Washing is a
   * shared department, so its money belongs to the department; attributing it to
   * an individual would be a fabrication. A wash worker is managed through
   * attendance and salary, never through a personal revenue figure.
   *
   * `null` for an attendance-only caller: revenue and individual performance are
   * management information.
   */
  shifts_count: number | null
  cafe_revenue: number | null
}

/**
 * `management_visible` is decided by the backend role gate, not by the UI.
 *
 * When it is `false` the rows are ATTENDANCE OPERATION ROWS: salary, notes, login
 * role, the period analytics and the performance figures are all `null`, because
 * the backend never sent them. The table renders the minimum a punch needs.
 */
export interface EmployeeList {
  management_visible: boolean
  employees: EmployeeRow[]
}

export interface Leader {
  employee_id: number
  name: string
  value: number
}

export interface EmployeeOverview {
  /** Unique employee records. Never users, attendance days, shifts or invoices. */
  total_employees: number
  /**
   * Employees PRESENTED as "كاشير" — derived by the backend from the same
   * decision {@link import('@/lib/roles').employeeRole} makes, so the headcount
   * and the badge on the row below it can never disagree.
   *
   * It is deliberately NOT `employee_type === 'CASHIER'`: every login in
   * Station is a CASHIER employee, so that would crown the admin and the
   * managers as cashiers too.
   */
  total_cashiers: number
  total_wash_workers: number
  top_attendance: Leader | null
  top_hours: Leader | null
  top_shifts: Leader | null
  top_cafe_revenue: Leader | null
  // No per-worker wash leader exists: wash revenue is a department-level figure,
  // reported by the sales analytics and never attributed to an individual.
}

export interface MyAttendance {
  employee: Employee | null
  today: AttendanceDay | null
  worked_minutes_today: number | null
  active_shift_id: number | null
}

export interface Advance {
  id: number
  employee_id: number
  /** Piasters. Always an integer — never a float. */
  amount: number
  advance_date: string
  reason: string
  status: 'RECORDED' | 'REVERSED'
  created_by: number
  created_by_name: string
  created_at: string
  reversed_at: string | null
}

export interface PayrollRun {
  id: number
  employee_id: number
  period: string
  base_salary: number
  attendance_days: number
  worked_minutes: number
  absence_days: number
  leave_days: number
  advances: number
  /** Manager-entered only; Station derives no attendance-based deduction. */
  deductions: number
  net_salary: number
  status: 'DRAFT' | 'FINALIZED'
  created_by: number
  created_at: string
  finalized_by: number | null
  finalized_at: string | null
}

/** One deduction — money withheld from a payslip, never an expense. */
export interface Deduction {
  id: number
  employee_id: number
  /** Piasters. Always an integer — never a float. */
  amount: number
  /** `YYYY-MM-DD`, Africa/Cairo business date. */
  deduction_date: string
  reason: string | null
  created_by: number
  created_by_name: string
  created_at: string
}

/**
 * The salary block for the Employees page's date range, aggregated in SQL.
 *
 * The drawer renders these four figures verbatim. The frontend performs NO
 * payroll arithmetic — not even `base - advances - deductions` — because the
 * backend already decided the period, the month count and the net.
 */
export interface EmployeeFinancials {
  /** The bounds actually applied. `null` on a bound means unbounded. */
  from: string | null
  to: string | null
  /** How many calendar months the salary was counted for. Never prorated by days. */
  months: number
  base_salary: number
  /** Live (non-reversed) advances inside the range. */
  advances: number
  deductions: number
  net_salary: number
}

export interface EmployeeDetails {
  employee: Employee
  period_row: EmployeeRow | null
  attendance: AttendanceDay[]
  /** Advances inside the SAME period as {@link financials}. */
  advances: Advance[]
  /** Deductions inside the same period. */
  deductions: Deduction[]
  financials: EmployeeFinancials
  payroll: PayrollRun[]
}

export interface EmployeeInput {
  name: string
  phone?: string | null
  employee_type: EmployeeType
  base_salary?: number | null
  notes?: string | null
  /** Links a CASHIER to an existing login; must be absent for a wash worker. */
  user_id?: number | null
  /**
   * The auth role of the login to CREATE, for a cashier being added with a
   * password. Ignored for a wash worker, and only an ADMIN may ask for ADMIN.
   */
  role?: LoginRole | null
  /**
   * Creates the person's login. Required for a new cashier, ignored for a wash
   * worker. A cashier cannot exist without a login, so this is what the form
   * must send for a `CASHIER`.
   */
  password?: string | null
}

export interface AdvanceInput {
  amount: number
  advance_date?: string | null
  reason: string
}

/** What the deduction dialog sends. The employee comes from the open drawer. */
export interface DeductionInput {
  amount: number
  deduction_date?: string | null
  reason?: string | null
}

export interface PayrollPreview {
  employee_id: number
  period: string
  base_salary: number
  attendance_days: number
  worked_minutes: number
  absence_days: number
  leave_days: number
  advances: number
  deductions: number
  net_salary: number
  exists: boolean
  existing_status: string | null
}

function period(period?: EmployeePeriod) {
  return { from: period?.from ?? null, to: period?.to ?? null }
}

export const employeesApi = {
  /** Open to every role: a cashier needs the roster to punch in and to mark wash staff. */
  list: (query = '', range?: EmployeePeriod, includeInactive = false) =>
    call<EmployeeList>('list_employees', {
      query: query.trim(),
      period: period(range),
      include_inactive: includeInactive,
    }),
  /** Manager-level: the KPI band. A cashier is refused by the backend. */
  overview: (range?: EmployeePeriod) =>
    call<EmployeeOverview>('employee_overview', { period: period(range) }),
  /** The caller's OWN attendance. Takes no employee id — the backend resolves it. */
  myAttendance: () => call<MyAttendance>('my_attendance'),
  recordAttendance: (employeeId: number, action: AttendanceAction, note?: string | null) =>
    call<AttendanceDay>('record_attendance', {
      employee_id: employeeId,
      action,
      note: note ?? null,
    }),
  /** Manager-level: voids a recorded day and writes its replacement. */
  correctAttendance: (
    employeeId: number,
    businessDate: string,
    action: AttendanceAction,
    note?: string | null,
  ) =>
    call<AttendanceDay>('correct_attendance', {
      employee_id: employeeId,
      business_date: businessDate,
      action,
      note: note ?? null,
    }),
  /**
   * Manager-level: an ADMINISTRATIVE override of a recorded day's effective
   * check-in / check-out.
   *
   * This is the one attendance call that carries TIMES rather than an intent,
   * and that asymmetry is the whole feature. The backend keeps the automatic
   * ten-minute rounding for `record_attendance` and stores these two wall clocks
   * exactly as they are typed — a manager who states 08:07 gets 08:07, earlier
   * or later than the recorded value, and the screen never pre-rounds them.
   *
   * `check_in` / `check_out` are business-local `HH:MM` strings. `null` (or an
   * empty string) means "leave this one as it is", never "clear it": a present
   * day must keep its check-in. The overriding manager is the session — there is
   * deliberately no actor parameter, exactly as in `recordAttendance`.
   */
  overrideAttendance: (
    employeeId: number,
    businessDate: string,
    times: { check_in?: string | null; check_out?: string | null; reason?: string | null },
  ) =>
    call<AttendanceDay>('override_employee_attendance', {
      employee_id: employeeId,
      business_date: businessDate,
      check_in: times.check_in?.trim() || null,
      check_out: times.check_out?.trim() || null,
      reason: times.reason?.trim() || null,
    }),
  /** Manager-level: the details drawer payload. */
  details: (employeeId: number, range?: EmployeePeriod) =>
    call<EmployeeDetails>('employee_details', {
      employee_id: employeeId,
      period: period(range),
    }),

  create: (input: EmployeeInput) => call<number>('create_employee', { input }),
  update: (employeeId: number, input: EmployeeInput) =>
    call<void>('update_employee', { employee_id: employeeId, input }),
  setStatus: (employeeId: number, status: 'ACTIVE' | 'INACTIVE') =>
    call<void>('set_employee_status', { employee_id: employeeId, status }),
  /**
   * ADMIN-only PERMANENT delete of an employee.
   *
   * Unlike the catalog's `remove`, this really removes the row: an employee
   * record is the roster itself, not an archived catalog entry. The backend
   * refuses an employee who has attendance, advances, payroll runs or wash
   * attributions, and that refusal comes back as a normal domain error — so a
   * rejected call changes nothing and reports why in Arabic.
   */
  remove: (employeeId: number) => call<void>('delete_employee', { employee_id: employeeId }),
  setBaseSalary: (employeeId: number, baseSalary: number) =>
    call<void>('set_employee_base_salary', { employee_id: employeeId, base_salary: baseSalary }),

  createAdvance: (employeeId: number, input: AdvanceInput) =>
    call<number>('create_employee_advance', { employee_id: employeeId, input }),
  reverseAdvance: (advanceId: number) =>
    call<void>('reverse_employee_advance', { advance_id: advanceId }),

  /**
   * MANAGER+ — record a deduction. It reduces the salary figures in the drawer and
   * creates NO expense, so the expense pages are untouched by this call.
   */
  createDeduction: (employeeId: number, input: DeductionInput) =>
    call<number>('create_employee_deduction', { employee_id: employeeId, input }),

  payrollPreview: (employeeId: number, period: string) =>
    call<PayrollPreview>('payroll_preview', { employee_id: employeeId, period }),
  createPayrollRun: (employeeId: number, period: string, deductions = 0) =>
    call<PayrollRun>('create_payroll_run', { employee_id: employeeId, period, deductions }),
  finalizePayrollRun: (runId: number) =>
    call<PayrollRun>('finalize_payroll_run', { run_id: runId }),

  /** For the POS attribution picker — naming the worker is part of taking the order. */
  washWorkers: () => call<Employee[]>('list_wash_workers'),
  setOrderWashEmployee: (orderId: number, washEmployeeId: number | null) =>
    call<void>('set_order_wash_employee', {
      order_id: orderId,
      wash_employee_id: washEmployeeId,
    }),
}
