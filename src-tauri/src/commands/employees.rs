//! Tauri commands — employees, attendance, advances and payroll.
//!
//! Commands stay thin, exactly like every other file here: resolve the session,
//! let the SERVICE decide authorization, delegate. No business rule and no SQL
//! lives in this file, and no frontend-supplied identity is ever trusted —
//! `recorded_by` in particular is not a parameter anywhere, because the recorder
//! is the authenticated session.
//!
//! Note the `STAFF` gate on every command: the SERVICE applies the real rule
//! (`MANAGER` for money and for another person's records), which is the same
//! split the customers commands use.

use super::common::authorized;
use crate::error::AppResult;
use crate::repositories::employee_analytics::{AttendanceDay, EmployeeOverview, PayrollRun};
use crate::repositories::employees::Employee;
use crate::services::attendance::AttendanceAction;
use crate::services::employees::{
    self as employee_svc, AdvanceInput, EmployeeDetails, EmployeeInput, EmployeeList,
    EmployeePeriod, MyAttendance, PayrollPreview,
};
use crate::AppState;
use tauri::State;

/// The employees table. Open to every authenticated role, because a cashier
/// genuinely needs it: to punch their own attendance and to mark the wash staff
/// in. The MANAGER-gated figures (salary, revenue) are omitted from a cashier's
/// payload by the service, not hidden by this page.
#[tauri::command(rename_all = "snake_case")]
pub fn list_employees(
    state: State<'_, AppState>,
    token: String,
    query: Option<String>,
    period: Option<EmployeePeriod>,
    include_inactive: Option<bool>,
) -> AppResult<EmployeeList> {
    let period = period.unwrap_or_default();
    employee_svc::validate_period(&period)?;
    let query = query.unwrap_or_default();
    let include_inactive = include_inactive.unwrap_or(false);
    authorized(&state, &token, "STAFF", move |conn, actor| {
        employee_svc::list(conn, actor, &period, &query, include_inactive)
    })
}

/// The KPI band. Manager-level — a headcount ranking and money.
#[tauri::command(rename_all = "snake_case")]
pub fn employee_overview(
    state: State<'_, AppState>,
    token: String,
    period: Option<EmployeePeriod>,
) -> AppResult<EmployeeOverview> {
    let period = period.unwrap_or_default();
    employee_svc::validate_period(&period)?;
    authorized(&state, &token, "STAFF", move |conn, actor| {
        employee_svc::overview(conn, actor, &period)
    })
}

/// The caller's OWN attendance. Takes no employee id: the employee is resolved
/// from the session's login inside the service.
#[tauri::command(rename_all = "snake_case")]
pub fn my_attendance(state: State<'_, AppState>, token: String) -> AppResult<MyAttendance> {
    authorized(&state, &token, "STAFF", |conn, actor| {
        employee_svc::my_attendance(conn, actor)
    })
}

/// Record one attendance event (check-in / check-out / absence / leave).
///
/// The command deliberately has NO `recorded_by_user_id` parameter: the
/// recorder is the session, resolved server-side.
#[tauri::command(rename_all = "snake_case")]
pub fn record_attendance(
    state: State<'_, AppState>,
    token: String,
    employee_id: i64,
    action: AttendanceAction,
    note: Option<String>,
) -> AppResult<AttendanceDay> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        employee_svc::record_attendance(conn, actor, employee_id, action, note.as_deref())
    })
}

/// Manager correction: voids the recorded day and writes its replacement,
/// keeping both in history with an audit entry.
#[tauri::command(rename_all = "snake_case")]
pub fn correct_attendance(
    state: State<'_, AppState>,
    token: String,
    employee_id: i64,
    business_date: String,
    action: AttendanceAction,
    note: Option<String>,
) -> AppResult<AttendanceDay> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        employee_svc::correct_attendance(
            conn,
            actor,
            employee_id,
            &business_date,
            action,
            note.as_deref(),
        )
    })
}

/// Manager attendance override: an administrative correction of the EFFECTIVE
/// check-in / check-out of a recorded day.
///
/// The two times are business-LOCAL wall clocks (`HH:MM` or `HH:MM:SS`) for the
/// business date being corrected, exactly as the manager sees them on the
/// attendance timeline. They are stored verbatim — the automatic ten-minute
/// rounding belongs to a NORMAL punch and is deliberately not applied here.
///
/// Like every other command in this file, the arguments carry no identity: the
/// overriding manager is the authenticated session, resolved server-side.
#[tauri::command(rename_all = "snake_case")]
pub fn override_employee_attendance(
    state: State<'_, AppState>,
    token: String,
    employee_id: i64,
    business_date: String,
    check_in: Option<String>,
    check_out: Option<String>,
    reason: Option<String>,
) -> AppResult<AttendanceDay> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        employee_svc::override_attendance(
            conn,
            actor,
            employee_id,
            &business_date,
            check_in.as_deref(),
            check_out.as_deref(),
            reason.as_deref(),
        )
    })
}

/// The employee details drawer payload. Manager-level.
#[tauri::command(rename_all = "snake_case")]
pub fn employee_details(
    state: State<'_, AppState>,
    token: String,
    employee_id: i64,
    period: Option<EmployeePeriod>,
) -> AppResult<EmployeeDetails> {
    let period = period.unwrap_or_default();
    employee_svc::validate_period(&period)?;
    authorized(&state, &token, "STAFF", move |conn, actor| {
        employee_svc::details(conn, actor, employee_id, &period)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn create_employee(
    state: State<'_, AppState>,
    token: String,
    input: EmployeeInput,
) -> AppResult<i64> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        employee_svc::create_employee(conn, actor, &input)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn update_employee(
    state: State<'_, AppState>,
    token: String,
    employee_id: i64,
    input: EmployeeInput,
) -> AppResult<()> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        employee_svc::update_employee(conn, actor, employee_id, &input)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_employee_status(
    state: State<'_, AppState>,
    token: String,
    employee_id: i64,
    status: String,
) -> AppResult<()> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        employee_svc::set_employee_status(conn, actor, employee_id, &status)
    })
}

/// ADMIN-only permanent delete of an employee.
///
/// Deactivation (above) is the reversible, MANAGER-level "this person has left".
/// Deletion is the terminal action an ADMIN performs for a record with NO
/// history at all — a duplicate, or a mistyped entry that was never used. It is
/// a REAL delete, not an archive: the row is gone, and so is the linked login
/// when nothing references it.
///
/// The service refuses an employee who has attendance, advances, payroll runs or
/// wash attributions, so this can never cost Station a historical record. The
/// command requires ADMIN at the boundary AND the service re-checks the role, so
/// a bypassed frontend — or a direct Tauri invocation from a MANAGER or CASHIER
/// session — still cannot delete anything.
#[tauri::command(rename_all = "snake_case")]
pub fn delete_employee(
    state: State<'_, AppState>,
    token: String,
    employee_id: i64,
) -> AppResult<()> {
    authorized(&state, &token, "ADMIN", move |conn, actor| {
        employee_svc::delete_employee(conn, actor, employee_id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_employee_base_salary(
    state: State<'_, AppState>,
    token: String,
    employee_id: i64,
    base_salary: i64,
) -> AppResult<()> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        employee_svc::set_base_salary(conn, actor, employee_id, base_salary)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn create_employee_advance(
    state: State<'_, AppState>,
    token: String,
    employee_id: i64,
    input: AdvanceInput,
) -> AppResult<i64> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        employee_svc::create_advance(conn, actor, employee_id, &input)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn reverse_employee_advance(
    state: State<'_, AppState>,
    token: String,
    advance_id: i64,
) -> AppResult<()> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        employee_svc::reverse_advance(conn, actor, advance_id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn payroll_preview(
    state: State<'_, AppState>,
    token: String,
    employee_id: i64,
    period: String,
) -> AppResult<PayrollPreview> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        employee_svc::payroll_preview(conn, actor, employee_id, &period)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn create_payroll_run(
    state: State<'_, AppState>,
    token: String,
    employee_id: i64,
    period: String,
    deductions: Option<i64>,
) -> AppResult<PayrollRun> {
    let deductions = deductions.unwrap_or(0);
    authorized(&state, &token, "STAFF", move |conn, actor| {
        employee_svc::create_payroll_run(conn, actor, employee_id, &period, deductions)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn finalize_payroll_run(
    state: State<'_, AppState>,
    token: String,
    run_id: i64,
) -> AppResult<PayrollRun> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        employee_svc::finalize_payroll_run(conn, actor, run_id)
    })
}

/// Active wash workers, for the POS attribution picker. STAFF+: naming the
/// worker who washed the car is part of taking the order.
#[tauri::command(rename_all = "snake_case")]
pub fn list_wash_workers(state: State<'_, AppState>, token: String) -> AppResult<Vec<Employee>> {
    authorized(&state, &token, "STAFF", |conn, _| {
        employee_svc::active_wash_workers(conn)
    })
}

/// Attribute the open order's wash job to a worker. STAFF+.
#[tauri::command(rename_all = "snake_case")]
pub fn set_order_wash_employee(
    state: State<'_, AppState>,
    token: String,
    order_id: i64,
    wash_employee_id: Option<i64>,
) -> AppResult<()> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        employee_svc::set_order_wash_employee(conn, actor, order_id, wash_employee_id)
    })
}
