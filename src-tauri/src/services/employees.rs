//! Employees service — every business rule of the employees domain.
//!
//! # The three roles this service distinguishes
//!
//! | concept              | where it lives             | who may rely on it    |
//! |----------------------|----------------------------|-----------------------|
//! | employee type        | `employees.employee_type`  | everyone, read-only   |
//! | authentication role  | `users.role`               | the login system      |
//! | **authorization**    | this service               | **the only boundary** |
//!
//! A CASHIER may be `STAFF`, `MANAGER` or `ADMIN`; a WASH_WORKER has no
//! `users` row at all. Neither fact grants any permission here: every permission
//! in this file is decided from the SESSION's role, so hiding a button in React
//! is never what protects a rule.
//!
//! # Who may record attendance for whom
//!
//!  - **anyone, for anyone** — every authenticated role may take any of the four
//!    actions (حضور / انصراف / غياب / إجازة) for any employee. The roster a
//!    CASHIER sees is an ATTENDANCE OPERATION table; taking a punch is the whole
//!    reason it exists. What that grant excludes is everything about the person:
//!    salary, notes, role, status and credentials stay MANAGER+, and the list
//!    payload for a CASHIER does not contain them at all.
//!  - **corrections** — rewriting an already-recorded day is MANAGER+ and audited
//!    (see `correct_attendance`); a punch is never silently overwritten.
//!
//! In every case the RECORDER is the session user, resolved server-side.
//!
//! # Nothing here is inferred
//!
//! Absence is never derived from a missing check-in. A day with no attendance
//! row is "not recorded" and is reported as such.

use crate::error::{AppError, AppResult};
use crate::money::Money;
use crate::repositories::employee_analytics::{self, Advance, EmployeeRow, PayrollRun, Period};
use crate::repositories::employees::{self, Employee};
use crate::repositories::Db;
use crate::repositories::{pos as pos_repo, shifts};
use crate::services::attendance::{self, AttendanceAction, AttendanceState};
use crate::services::auth::{self, User};
use chrono::Datelike;
use serde::{Deserialize, Serialize};

/// The two employee types, as the service spells them.
pub const CASHIER: &str = "CASHIER";
pub const WASH_WORKER: &str = "WASH_WORKER";

/// The auth role whose Arabic label is literally "كاشير".
///
/// It is spelled as a constant rather than inlined so the headcount below and
/// `auth::ROLES` can never drift apart.
const STAFF: &str = "STAFF";

/// An inclusive business-date window supplied by the UI's date-range picker.
/// Empty / whitespace means unbounded, exactly like the reports service.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct EmployeePeriod {
    pub from: Option<String>,
    pub to: Option<String>,
}

impl EmployeePeriod {
    pub fn bounds(&self) -> (Option<&str>, Option<&str>) {
        (clean(self.from.as_deref()), clean(self.to.as_deref()))
    }

    /// The repository projection of this window.
    pub fn to_period(&self) -> Period {
        let (from, to) = self.bounds();
        Period {
            from: from.map(str::to_string),
            to: to.map(str::to_string),
        }
    }
}

fn clean(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// Reject a malformed bound before it can reach a report query. The rule matches
/// `services::customers::validate_period` so the two pages behave identically.
pub fn validate_period(period: &EmployeePeriod) -> AppResult<()> {
    for value in [period.bounds().0, period.bounds().1].into_iter().flatten() {
        attendance::validate_business_date(value)?;
    }
    Ok(())
}

/// The employees list, projected for the caller's role.
///
/// `management_visible` comes from the SAME `MANAGER` gate that protects the KPI
/// band, the drawer, advances and payroll, so the table, the tiles and the drawer
/// can never disagree about what a role may see.
///
/// When it is false the rows are ATTENDANCE OPERATION ROWS: the repository emits
/// `None` for salary, notes, login role, the period HR analytics and the
/// performance figures, so a CASHIER's payload carries the minimum a punch needs
/// and nothing else. The page cannot leak a figure it never received.
#[derive(Debug, Serialize)]
pub struct EmployeeList {
    pub management_visible: bool,
    pub employees: Vec<EmployeeRow>,
}

pub fn list(
    conn: &Db,
    actor: &User,
    period: &EmployeePeriod,
    query: &str,
    include_inactive: bool,
) -> AppResult<EmployeeList> {
    let management_visible = auth::require_role(actor, "MANAGER").is_ok();
    Ok(EmployeeList {
        management_visible,
        employees: employee_analytics::list_rows(
            conn,
            &period.to_period(),
            management_visible,
            include_inactive,
            query,
        )?,
    })
}

/// The KPI band. Manager-level, because every tile is either a headcount
/// ranking or money.
///
/// The leaders are reduced from the SAME aggregated list the table renders, so a
/// tile can never quote a number the row below it disagrees with, and the whole
/// band costs the one query the page already made.
pub fn overview(
    conn: &Db,
    actor: &User,
    period: &EmployeePeriod,
) -> AppResult<employee_analytics::EmployeeOverview> {
    auth::require_role(actor, "MANAGER")?;
    let rows = employee_analytics::list_rows(conn, &period.to_period(), true, false, "")?;
    Ok(reduce_overview(&rows))
}

/// The role a row is PRESENTED under — the one decision the whole employees
/// surface shares, and the Rust mirror of `employeeRole` in `src/lib/roles.ts`
/// (which is what the table badge, the avatar and the details drawer render).
///
/// Counting a headcount by `employees.employee_type` alone is exactly the
/// mistake this exists to prevent. EVERY login in Station is a `CASHIER`
/// employee, so the type says "this person has a login" and nothing more: it
/// would crown the admin and the managers as cashiers too. "كاشير" in this
/// application is the STAFF auth role, so a cashier is a person presented as
/// STAFF — never a person whose type happens to be CASHIER.
fn presented_role(row: &EmployeeRow) -> &str {
    match row.login_role.as_deref() {
        Some(role) if auth::ROLES.contains(&role) => role,
        // No usable login role: only a wash worker can be in this branch, and
        // this mirrors `employeeRole`'s fallback rather than assuming it.
        _ if row.employee_type == WASH_WORKER => WASH_WORKER,
        _ => STAFF,
    }
}

/// Pure reduction of the list into the KPI payload.
///
/// Kept separate from the SQL so the ranking rules are unit-testable without a
/// database, and so it is obvious that no second aggregation exists.
///
/// Every figure here is a HEADCOUNT OF UNIQUE EMPLOYEE RECORDS. The rows are
/// therefore de-duplicated by `id` first, so a repeated row — a future
/// one-to-many join, a duplicated aggregate — can never inflate a person into
/// two. Children (attendance days, shifts, invoices) are joined upstream as
/// pre-aggregated CTEs, and none of them is ever counted as an employee.
pub fn reduce_overview(rows: &[EmployeeRow]) -> employee_analytics::EmployeeOverview {
    use employee_analytics::Leader;
    use std::collections::BTreeMap;

    // A leader must actually HAVE the metric, and a tie is broken by name so
    // the tile is stable between two otherwise identical refreshes.
    fn best<'a, F>(
        rows: &'a [EmployeeRow],
        eligible: fn(&EmployeeRow) -> bool,
        value: F,
    ) -> Option<Leader>
    where
        F: Fn(&EmployeeRow) -> i64,
    {
        let mut winner: Option<&EmployeeRow> = None;
        let mut best_value = 0;
        for row in rows.iter().filter(|r| eligible(r)) {
            let v = value(row);
            let wins = v > best_value
                || (v == best_value && v > 0 && winner.is_some_and(|w| row.name < w.name));
            if wins {
                winner = Some(row);
                best_value = v;
            }
        }
        winner.map(|row| Leader {
            employee_id: row.id,
            name: row.name.clone(),
            value: best_value,
        })
    }

    // One entry per employee, first occurrence wins: the canonical employee
    // record is the unit of every number in this band.
    let unique: BTreeMap<i64, &EmployeeRow> = rows.iter().map(|row| (row.id, row)).collect();
    let people: Vec<&EmployeeRow> = unique.values().copied().collect();

    // "Shifts" and "cafe revenue" belong to the LOGIN that opened the shift, so
    // those two leaders span every login-holding employee — a manager who opens
    // a shift genuinely has one, and hiding that would understate the business.
    let has_login = |r: &EmployeeRow| r.employee_type == CASHIER;
    // Attendance and hours describe anyone who showed up, so those two leaders
    // consider EVERY employee, wash workers included.
    let everyone = |_: &EmployeeRow| true;

    // There is deliberately no wash-worker leaderboard. Washing is a shared
    // department: its revenue belongs to the department, not to the individual
    // who took the job, so ranking workers by it would fabricate a fact.
    //
    // The `unwrap_or(0)` calls are unreachable in practice: this reduction only
    // ever runs over the MANAGER projection (`overview` passes `true`), where
    // every figure is present. Reading a missing figure as "no activity" is the
    // safe direction anyway — a leader can only be crowned from a real value.
    employee_analytics::EmployeeOverview {
        total_employees: people.len() as i64,
        // Counted by the PRESENTED role, not by `employee_type`. The type marks
        // "has a login", so counting it reported every admin and manager as a
        // cashier; the label "كاشير" means the STAFF role.
        total_cashiers: people.iter().filter(|r| presented_role(r) == STAFF).count() as i64,
        total_wash_workers: people
            .iter()
            .filter(|r| presented_role(r) == WASH_WORKER)
            .count() as i64,
        top_attendance: best(rows, everyone, |r| r.attendance_days.unwrap_or(0)),
        top_hours: best(rows, everyone, |r| r.worked_minutes.unwrap_or(0)),
        top_shifts: best(rows, has_login, |r| r.shifts_count.unwrap_or(0)),
        top_cafe_revenue: best(rows, has_login, |r| r.cafe_revenue.unwrap_or(0)),
    }
}

/// One employee's own attendance state, as the cashier sees it on the page.
#[derive(Debug, Serialize)]
pub struct MyAttendance {
    /// The employee record behind the session's login. `None` for an account
    /// with no employee record — attendance is a property of the person, not of
    /// the permission, so such an account reports none rather than erroring.
    pub employee: Option<Employee>,
    pub today: Option<employee_analytics::AttendanceDay>,
    /// Minutes worked today between the EFFECTIVE punches. `None` while the day
    /// is still open: a running total must never be frozen into payroll.
    pub worked_minutes_today: Option<i64>,
    /// The caller's ACTIVE shift, when there is one. A wash-worker event is
    /// stamped with it, which is what ties the recording to the shift.
    pub active_shift_id: Option<i64>,
}

/// The caller's own attendance, for any authenticated role.
///
/// The employee is resolved from the session's login, so this function takes no
/// employee id at all — there is nothing for the frontend to tamper with.
pub fn my_attendance(conn: &Db, actor: &User) -> AppResult<MyAttendance> {
    let employee = employees::find_by_user(conn, actor.id)?;
    let today = crate::time::today_business_date();
    let day = match &employee {
        Some(emp) => employee_analytics::day_of_employee(conn, emp.id, &today)?,
        None => None,
    };
    let worked_minutes_today = day.as_ref().and_then(|d| {
        attendance::worked_minutes_of(
            d.check_in_effective_at.as_deref(),
            d.check_out_effective_at.as_deref(),
        )
    });
    Ok(MyAttendance {
        employee,
        today: day,
        worked_minutes_today,
        active_shift_id: shifts::active_shift_for(conn, actor.id)?.map(|s| s.id),
    })
}

/// Who may act on whom, resolved from the SESSION — never from a parameter.
///
/// # The rule
///
/// **Any authenticated user (STAFF+) may record attendance for ANY employee, with
/// any of the four actions.** The roster a CASHIER sees is not an HR table they
/// happen to be trusted with; it is an ATTENDANCE OPERATION table, and taking a
/// punch is the operation it exists for. Refusing a cashier the ability to mark a
/// colleague present would make the screen useless for the one job it is given.
///
/// What this grant deliberately does NOT include is anything about the person:
/// no salary, no notes, no role, no status change, no credential. Those are
/// gated by [`auth::require_role`] in their own functions, and the list payload
/// for this caller does not contain them in the first place.
///
/// Correcting an already-recorded day stays MANAGER+ and goes through
/// [`correct_attendance`], which voids and rewrites with an audit trail rather
/// than quietly overwriting a colleague's history.
///
/// The recorder is always the session user; there is no `recorded_by` parameter
/// anywhere in the command, so no caller can attribute an event to somebody else.
fn require_may_record(actor: &User) -> AppResult<()> {
    // The service states the minimum authority itself rather than trusting the
    // command's gate, so the rule survives being called from anywhere else.
    // There is deliberately no per-employee check beyond that: the employee's
    // existence is guaranteed by `employees::require`, and their ACTIVE status is
    // a day-state rule ("an inactive employee has no attendance"), not a
    // permission, so it is enforced by the algebra below.
    auth::require_role(actor, "STAFF")
}

/// Stable machine name of an action, used for the audit `action` column.
fn action_name(action: AttendanceAction) -> &'static str {
    match action {
        AttendanceAction::CheckIn => "check_in",
        AttendanceAction::CheckOut => "check_out",
        AttendanceAction::Absent => "absent",
        AttendanceAction::Leave => "leave",
    }
}

/// Record one attendance event for an employee.
///
/// # Identity
///
/// The recorder is ALWAYS `actor` — the authenticated session user. There is no
/// `recorded_by` parameter anywhere in this signature, so no caller and no
/// modified client can attribute an event to somebody else.
///
/// # Shift relationship
///
/// The event is stamped with the recorder's ACTIVE shift when one exists, so a
/// wash worker's check-in can always be traced to the shift it happened on. When
/// no shift is open the column is simply NULL — the event is still valid, it
/// just has no shift to point at.
pub fn record_attendance(
    conn: &Db,
    actor: &User,
    employee_id: i64,
    action: AttendanceAction,
    note: Option<&str>,
) -> AppResult<employee_analytics::AttendanceDay> {
    // Authorization happens ONCE, before any write: an authenticated user may
    // take any of the four actions for any employee. There is deliberately no
    // per-action manager gate here any more — filing an absence for a colleague
    // is an attendance operation, and the day-state algebra below is what
    // decides whether it is a LEGAL one.
    require_may_record(actor)?;

    let tx = conn.unchecked_transaction()?;
    let employee = employees::require(&tx, employee_id)?;

    let now = crate::time::now_utc();
    let business_date = crate::time::business_date_of(now);
    let actual_at = crate::time::to_db_timestamp(now);
    // The rounding direction is chosen by the ACTION, in the attendance domain,
    // and nowhere else: a check-in lands on the grid at or before the action and
    // a check-out at or after it. The frontend sends an intent, never a time.
    let effective_at = crate::time::to_db_timestamp(attendance::effective_instant(now, action));

    let existing = employee_analytics::day_of_employee(&tx, employee_id, &business_date)?;
    attendance::ensure_transition_allowed(
        employee.status == "ACTIVE",
        existing
            .as_ref()
            .map(|d| attendance::parse_state(&d.state))
            .transpose()?,
        existing
            .as_ref()
            .is_some_and(|d| d.check_in_actual_at.is_some()),
        existing
            .as_ref()
            .is_some_and(|d| d.check_out_actual_at.is_some()),
        action,
    )?;

    let shift_id = shifts::active_shift_for(&tx, actor.id)?.map(|s| s.id);

    match action {
        AttendanceAction::CheckIn => {
            employee_analytics::insert_day(
                &tx,
                employee_id,
                &business_date,
                AttendanceState::Present.as_str(),
                Some(&actual_at),
                Some(&effective_at),
                None,
                None,
                shift_id,
                actor.id,
                clean(note),
            )?;
        }
        AttendanceAction::CheckOut => {
            let day = existing
                .as_ref()
                .ok_or_else(|| AppError::business("attendance.no_check_in"))?;
            // An effective check-out may never precede the effective check-in.
            if let Some(in_) = day.check_in_effective_at.as_deref() {
                if crate::time::parse_timestamp(&effective_at) <= crate::time::parse_timestamp(in_)
                {
                    return Err(AppError::business("attendance.check_out_before_in"));
                }
            }
            let changed =
                employee_analytics::set_check_out(&tx, day.id, &actual_at, &effective_at)?;
            if changed == 0 {
                return Err(AppError::conflict("attendance.already_checked_out"));
            }
        }
        AttendanceAction::Absent | AttendanceAction::Leave => {
            let state = match action {
                AttendanceAction::Leave => AttendanceState::Leave,
                _ => AttendanceState::Absent,
            };
            employee_analytics::insert_day(
                &tx,
                employee_id,
                &business_date,
                state.as_str(),
                None,
                None,
                None,
                None,
                shift_id,
                actor.id,
                clean(note),
            )?;
        }
    }

    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        &format!("attendance.{}", action_name(action)),
        "attendance_day",
        Some(&format!("{employee_id}:{business_date}")),
        existing
            .as_ref()
            .map(|d| serde_json::json!({ "state": d.state }))
            .as_ref(),
        Some(&serde_json::json!({
            "employee_id": employee_id,
            "employee_type": employee.employee_type,
            "business_date": business_date,
            "action": action_name(action),
            // The recorder is the session, recorded explicitly so the audit
            // trail of a wash worker reads without joining any session table.
            "recorded_by": actor.id,
            "shift_id": shift_id,
            "actual_at": actual_at,
            "effective_at": effective_at,
        })),
    )?;
    tx.commit()?;

    employee_analytics::day_of_employee(conn, employee_id, &business_date)?
        .ok_or_else(|| AppError::internal("attendance day missing after commit"))
}

/// Manager correction of a recorded day.
///
/// History is never rewritten in place: the existing row is VOIDED (kept
/// forever, stamped with the manager who voided it) and a replacement row is
/// written in the same transaction. The audit entry records both sides, so "the
/// day was changed" is always answerable even though the original values still
/// exist on disk.
pub fn correct_attendance(
    conn: &Db,
    actor: &User,
    employee_id: i64,
    business_date: &str,
    action: AttendanceAction,
    note: Option<&str>,
) -> AppResult<employee_analytics::AttendanceDay> {
    auth::require_role(actor, "MANAGER")?;
    attendance::validate_business_date(business_date)?;
    let tx = conn.unchecked_transaction()?;

    let employee = employees::require(&tx, employee_id)?;
    let existing = employee_analytics::day_of_employee(&tx, employee_id, business_date)?
        .ok_or_else(|| AppError::not_found("attendance.day_not_found"))?;

    // The replacement is validated against a day that no longer exists, so the
    // state algebra sees a blank day — exactly what a fresh recording sees.
    attendance::ensure_transition_allowed(employee.status == "ACTIVE", None, false, false, action)?;

    let now = crate::time::now_utc();
    let actual_at = crate::time::to_db_timestamp(now);
    // A manager correction reuses the SAME rounding rule as a fresh recording, so
    // a corrected day can never be filed on a different lattice than a live one.
    let effective_at = crate::time::to_db_timestamp(attendance::effective_instant(now, action));
    let shift_id = shifts::active_shift_for(&tx, actor.id)?.map(|s| s.id);

    employee_analytics::void_day(&tx, existing.id, actor.id)?;

    match action {
        AttendanceAction::Absent | AttendanceAction::Leave => {
            let state = match action {
                AttendanceAction::Leave => AttendanceState::Leave,
                _ => AttendanceState::Absent,
            };
            employee_analytics::insert_day(
                &tx,
                employee_id,
                business_date,
                state.as_str(),
                None,
                None,
                None,
                None,
                shift_id,
                actor.id,
                clean(note),
            )?;
        }
        AttendanceAction::CheckIn => {
            employee_analytics::insert_day(
                &tx,
                employee_id,
                business_date,
                AttendanceState::Present.as_str(),
                Some(&actual_at),
                Some(&effective_at),
                None,
                None,
                shift_id,
                actor.id,
                clean(note),
            )?;
        }
        // A correction may CLOSE a day. Its check-in is carried over verbatim —
        // the original actual and effective stamps are facts about the morning,
        // not something a correction may improve upon.
        AttendanceAction::CheckOut => {
            let check_in_actual = existing
                .check_in_actual_at
                .as_deref()
                .ok_or_else(|| AppError::business("attendance.no_check_in"))?;
            let check_in_effective = existing
                .check_in_effective_at
                .as_deref()
                .ok_or_else(|| AppError::internal("attendance check-in pair is inconsistent"))?;
            if crate::time::parse_timestamp(&effective_at)
                <= crate::time::parse_timestamp(check_in_effective)
            {
                return Err(AppError::business("attendance.check_out_before_in"));
            }
            employee_analytics::insert_day(
                &tx,
                employee_id,
                business_date,
                AttendanceState::Present.as_str(),
                Some(check_in_actual),
                Some(check_in_effective),
                Some(&actual_at),
                Some(&effective_at),
                shift_id,
                actor.id,
                clean(note),
            )?;
        }
    }

    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "attendance.corrected",
        "attendance_day",
        Some(&format!("{employee_id}:{business_date}")),
        Some(&serde_json::json!({
            "voided_id": existing.id,
            "state": existing.state,
            "check_in_actual_at": existing.check_in_actual_at,
            "check_out_actual_at": existing.check_out_actual_at,
        })),
        Some(&serde_json::json!({
            "employee_id": employee_id,
            "business_date": business_date,
            "action": action_name(action),
            "corrected_by": actor.id,
        })),
    )?;
    tx.commit()?;

    employee_analytics::day_of_employee(conn, employee_id, business_date)?
        .ok_or_else(|| AppError::internal("attendance day missing after correction"))
}

/// Manager override of a recorded attendance day — an ADMINISTRATIVE correction.
///
/// # This is not `correct_attendance`
///
/// The two operations answer different questions:
///
///  - [`correct_attendance`] re-files a day as if it were being recorded NOW: the
///    machine's clock is the source, so the normal rounding applies and a
///    manager cannot choose a time;
///  - this function takes the time the manager STATES. It is an administrative
///    correction of a fact someone already entered, and it is the only path in
///    the application that can write an attendance timestamp the rounding rule
///    never produced.
///
/// # Why there is no rounding anywhere in here
///
/// The selected instant goes through [`attendance::override_instant`] and
/// nowhere else. It is not compared to the grid, not floored, not ceiled and not
/// re-rounded on the way in: a manager who sets 08:07 gets 08:07, and a value
/// already on the grid stays exactly where they put it. The normal rounding rule
/// in [`record_attendance`] is untouched by this function.
///
/// # Authorization
///
/// MANAGER and above, enforced HERE rather than by the caller: a CASHIER/STAFF
/// session is refused by the service no matter how the command was invoked, and
/// a WASH_WORKER has no login at all, so the operation is unreachable for one.
///
/// # History
///
/// The superseded row is VOIDED, never edited, exactly as a correction does — the
/// partial unique index frees the (employee, day) slot for the replacement inside
/// the same transaction. So the original machine readings stay on disk forever,
/// and the audit entry carries the previous pair and the new one side by side.
/// The live row's `recorded_by_user_id` becomes the MANAGER, which is what
/// distinguishes an adjusted day from a punched one. A punch the manager did not
/// touch keeps BOTH its original actual and effective stamps, so an override of
/// the check-out alone never rewrites a fact about the morning.
pub fn override_attendance(
    conn: &Db,
    actor: &User,
    employee_id: i64,
    business_date: &str,
    check_in: Option<&str>,
    check_out: Option<&str>,
    reason: Option<&str>,
) -> AppResult<employee_analytics::AttendanceDay> {
    // 1. Authorize, before anything is read or written.
    auth::require_role(actor, "MANAGER")?;
    attendance::validate_business_date(business_date)?;

    // An empty field means "leave this one as it is", not "clear it" — a PRESENT
    // day must keep its check-in, and clearing a punch pair is not an
    // adjustment. At least one side has to be stated, or there is nothing to do.
    let check_in = clean(check_in);
    let check_out = clean(check_out);
    if check_in.is_none() && check_out.is_none() {
        return Err(AppError::validation("attendance.override_requires_time"));
    }

    // 2. Load the record being corrected.
    let tx = conn.unchecked_transaction()?;
    let employee = employees::require(&tx, employee_id)?;
    if employee.status != "ACTIVE" {
        return Err(AppError::business("attendance.employee_inactive"));
    }
    let existing = employee_analytics::day_of_employee(&tx, employee_id, business_date)?
        .ok_or_else(|| AppError::not_found("attendance.day_not_found"))?;
    if !attendance::parse_state(&existing.state)?.is_present() {
        // An absence or a leave carries no punch pair, so there is no time to
        // correct. Re-recording such a day is `correct_attendance`'s job.
        return Err(AppError::business("attendance.override_requires_present"));
    }

    // 3. Validate the requested values. The two stated sides are converted here
    // and nowhere else; the untouched sides are carried over verbatim, so the
    // resulting pair is always the whole day, never half of one.
    let stated_in = match check_in {
        Some(value) => Some(attendance::override_instant(
            business_date,
            attendance::parse_override_time(value)?,
        )?),
        None => None,
    };
    let stated_out = match check_out {
        Some(value) => Some(attendance::override_instant(
            business_date,
            attendance::parse_override_time(value)?,
        )?),
        None => None,
    };
    let check_in_effective = match stated_in {
        Some(instant) => crate::time::to_db_timestamp(instant),
        None => existing
            .check_in_effective_at
            .clone()
            .ok_or_else(|| AppError::internal("attendance check-in pair is inconsistent"))?,
    };
    let check_out_effective = match stated_out {
        Some(instant) => Some(crate::time::to_db_timestamp(instant)),
        None => existing.check_out_effective_at.clone(),
    };
    // The machine readings follow the effective ones only where the manager
    // actually spoke: a stated side is written as both, and an untouched side
    // keeps the clock reading that produced it.
    let check_in_actual = match stated_in {
        Some(instant) => crate::time::to_db_timestamp(instant),
        None => existing
            .check_in_actual_at
            .clone()
            .ok_or_else(|| AppError::internal("attendance check-in pair is inconsistent"))?,
    };
    let check_out_actual = match stated_out {
        Some(instant) => Some(crate::time::to_db_timestamp(instant)),
        None => existing.check_out_actual_at.clone(),
    };

    // The ordering rule, applied to the pair the day will actually carry.
    attendance::ensure_override_pair_allowed(
        crate::time::parse_timestamp(&check_in_effective),
        check_out_effective
            .as_deref()
            .and_then(crate::time::parse_timestamp),
    )?;

    // 4. Apply atomically: the old row is voided (kept forever) and its
    // replacement is written in the same transaction, so the unique live index
    // is never briefly empty and a failure leaves the day exactly as it was.
    let reason = clean(reason);
    employee_analytics::void_day(&tx, existing.id, actor.id)?;
    let replacement_id = employee_analytics::insert_day(
        &tx,
        employee_id,
        business_date,
        AttendanceState::Present.as_str(),
        Some(&check_in_actual),
        Some(&check_in_effective),
        check_out_actual.as_deref(),
        check_out_effective.as_deref(),
        existing.shift_id,
        actor.id,
        reason.or(existing.note.as_deref()),
    )?;

    // 5. The audit entry: who, when (audit_log's own created_at), which record,
    // the previous pair and the new one. A reason is stored in the row's existing
    // `note` — the domain already has a place for it, so no second mechanism is
    // invented here.
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "attendance.override",
        "attendance_day",
        Some(&format!("{employee_id}:{business_date}")),
        Some(&serde_json::json!({
            "id": existing.id,
            "state": existing.state,
            "check_in_actual_at": existing.check_in_actual_at,
            "check_in_effective_at": existing.check_in_effective_at,
            "check_out_actual_at": existing.check_out_actual_at,
            "check_out_effective_at": existing.check_out_effective_at,
            "recorded_by_user_id": existing.recorded_by_user_id,
            "note": existing.note,
        })),
        Some(&serde_json::json!({
            "replacement_id": replacement_id,
            "employee_id": employee_id,
            "business_date": business_date,
            "overridden_by": actor.id,
            "overridden_by_role": actor.role,
            "check_in_actual_at": check_in_actual,
            "check_in_effective_at": check_in_effective,
            "check_out_actual_at": check_out_actual,
            "check_out_effective_at": check_out_effective,
            "reason": reason,
        })),
    )?;
    tx.commit()?;

    // 6. The updated record, read back through the normal read path so the caller
    // sees exactly what every other reader will see.
    employee_analytics::day_of_employee(conn, employee_id, business_date)?
        .ok_or_else(|| AppError::internal("attendance day missing after override"))
}

/// The employee form payload. `user_id` is accepted for a CASHIER that is being
/// linked to an EXISTING login, and MUST be absent for a wash worker — the
/// database CHECK enforces that too, so a crafted request cannot give a wash
/// worker a login.
///
/// # `role` + `password`: creating the login as part of the employee
///
/// A CASHIER is a person who can sign in, so creating one has to be able to
/// create that login; otherwise the employee record would exist with nothing
/// behind it and the person could never be scheduled, never be given the
/// authorization their job requires, and never be deactivated through the
/// employees surface.
///
/// Both fields are ignored for a WASH_WORKER, who has no login by definition.
/// Role assignment stays AUTHORIZATION-AWARE: a MANAGER may create a MANAGER or
/// a STAFF, but only an ADMIN may create another ADMIN — the same
/// privilege-escalation guard the login command enforced, now enforced here so
/// there is exactly one place that can mint a privileged account.
#[derive(Debug, Deserialize)]
pub struct EmployeeInput {
    pub name: String,
    pub phone: Option<String>,
    pub employee_type: String,
    pub base_salary: Option<Money>,
    pub notes: Option<String>,
    pub user_id: Option<i64>,
    /// The auth role of the login to create. `None` means "a plain STAFF
    /// login" when a password is supplied.
    pub role: Option<String>,
    /// The login's password. Required when a new login is being created, and
    /// validated by the SHARED auth rule so this surface cannot have a laxer
    /// password policy than the login screen.
    pub password: Option<String>,
}

fn validate_employee_input(input: &EmployeeInput) -> AppResult<(String, Money)> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::validation("employee.name_required"));
    }
    if !employees::EMPLOYEE_TYPES.contains(&input.employee_type.as_str()) {
        return Err(AppError::validation("employee.invalid_type"));
    }
    // Money is integer piasters everywhere; a negative salary is not a salary.
    let base_salary = input.base_salary.unwrap_or(0);
    if base_salary < 0 {
        return Err(AppError::validation("employee.invalid_salary"));
    }
    if input.employee_type == WASH_WORKER && input.user_id.is_some() {
        return Err(AppError::validation(
            "employee.wash_worker_cannot_authenticate",
        ));
    }
    Ok((name, base_salary))
}

/// Create an employee. MANAGER+.
///
/// Three shapes, decided by the employee type and the presence of a login:
///
///  1. **CASHIER + a password** — the common case. The login is created here, in
///     the same transaction as the employee row, so a person can never end up
///     half-created. The login's role is validated against the SAME
///     `auth::ROLES` list the login system uses and against the actor's own
///     authority, so this screen cannot mint a more powerful account than the
///     manager creating it.
///  2. **CASHIER + `user_id`** — link the person to an EXISTING login.
///  3. **WASH_WORKER** — no login, ever. The database CHECK enforces it too.
///
/// Deactivating a manager must be able to reach the login behind a cashier, which
/// is why the two are created together rather than as two separate screens.
pub fn create_employee(conn: &Db, actor: &User, input: &EmployeeInput) -> AppResult<i64> {
    auth::require_role(actor, "MANAGER")?;
    let (name, base_salary) = validate_employee_input(input)?;
    let phone = clean(input.phone.as_deref());
    let notes = clean(input.notes.as_deref());

    // The role a new login would get, validated and authorization-checked
    // BEFORE any write, so an unauthorized request never opens a transaction.
    let new_login = match (input.employee_type.as_str(), input.password.as_deref()) {
        (WASH_WORKER, _) => None,
        (_, None) => None,
        (_, Some(password)) => {
            let role = input.role.as_deref().unwrap_or("STAFF").to_string();
            if !auth::ROLES.contains(&role.as_str()) {
                return Err(AppError::validation("user.invalid_role"));
            }
            // Privilege escalation guard, identical to the one the login
            // command enforced: only an ADMIN may mint another ADMIN.
            if role == "ADMIN" && actor.role != "ADMIN" {
                return Err(AppError::unauthorized("auth.admin_only"));
            }
            // The SHARED password rule, so this surface can never be laxer than
            // the login screen.
            auth::validate_password(password)?;
            let hash = auth::hash_password(password)?;
            Some((role, hash))
        }
    };
    if input.user_id.is_some() && new_login.is_some() {
        return Err(AppError::validation("employee.login_already_linked"));
    }
    // A CASHIER with neither an existing login nor a new one is refused HERE,
    // with a real message, rather than reaching the table and surfacing as a
    // SQLite CHECK violation. The CHECK stays as the last line of defence; this
    // is what turns an unfriendly constraint failure into a clear validation.
    if input.employee_type == CASHIER && input.user_id.is_none() && new_login.is_none() {
        return Err(AppError::validation("employee.login_required"));
    }

    let tx = conn.unchecked_transaction()?;
    let user_id = match (input.user_id, new_login) {
        // Link an existing login.
        (Some(user_id), None) => {
            let user = crate::repositories::users::find_by_id(&tx, user_id)?
                .ok_or_else(|| AppError::not_found("user.not_found"))?;
            if employees::is_user_linked(&tx, user_id)? {
                return Err(AppError::conflict("employee.login_already_linked"));
            }
            Some(user.id)
        }
        // Mint a fresh login for this person.
        (None, Some((role, hash))) => {
            let new_user_id = crate::repositories::users::insert(
                &tx,
                &crate::repositories::users::NewUser {
                    name: &name,
                    phone,
                    role: &role,
                    password_hash: &hash,
                    is_seed: false,
                },
            )?
            .ok_or_else(|| AppError::conflict("user.name_taken"))?;
            Some(new_user_id)
        }
        // A wash worker, or a caller that neither linked nor created a login.
        // The database CHECK refuses the latter, which is the correct outcome:
        // a CASHIER without a login is not a state the domain allows.
        (None, None) => None,
        (Some(_), Some(_)) => unreachable!("rejected before the transaction opened"),
    };

    let id = employees::insert(
        &tx,
        &employees::NewEmployee {
            name: &name,
            phone,
            employee_type: &input.employee_type,
            base_salary,
            notes,
            user_id,
        },
    )?;
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "employee.created",
        "employee",
        Some(&id.to_string()),
        None,
        Some(&serde_json::json!({
            "name": name,
            "employee_type": input.employee_type,
            "user_id": user_id,
            "base_salary": base_salary,
        })),
    )?;
    tx.commit()?;
    Ok(id)
}

/// Edit an employee's identity fields. MANAGER+.
///
/// The employee type is IMMUTABLE here on purpose: turning a wash worker into a
/// cashier would silently grant authentication, and turning a cashier into a
/// wash worker would orphan a live login. Both are HR decisions with real
/// consequences, not a field edit.
pub fn update_employee(
    conn: &Db,
    actor: &User,
    employee_id: i64,
    input: &EmployeeInput,
) -> AppResult<()> {
    auth::require_role(actor, "MANAGER")?;
    let (name, _) = validate_employee_input(input)?;
    let tx = conn.unchecked_transaction()?;
    let before = employees::require(&tx, employee_id)?;
    if before.employee_type != input.employee_type {
        return Err(AppError::business("employee.type_is_immutable"));
    }
    employees::update_profile(
        &tx,
        employee_id,
        &name,
        clean(input.phone.as_deref()),
        clean(input.notes.as_deref()),
    )?;
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "employee.updated",
        "employee",
        Some(&employee_id.to_string()),
        Some(&serde_json::json!({ "name": before.name, "phone": before.phone })),
        Some(&serde_json::json!({ "name": name, "phone": input.phone })),
    )?;
    tx.commit()?;
    Ok(())
}

/// Set the monthly base salary. MANAGER+, and audited as money.
///
/// Existing payroll runs are deliberately untouched: a finalized September run
/// already holds its own copy of the salary, so raising it in October cannot
/// move a figure that was already paid.
pub fn set_base_salary(
    conn: &Db,
    actor: &User,
    employee_id: i64,
    base_salary: Money,
) -> AppResult<()> {
    auth::require_role(actor, "MANAGER")?;
    if base_salary < 0 {
        return Err(AppError::validation("employee.invalid_salary"));
    }
    let tx = conn.unchecked_transaction()?;
    let before = employees::require(&tx, employee_id)?;
    employees::set_base_salary(&tx, employee_id, base_salary)?;
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "employee.salary_changed",
        "employee",
        Some(&employee_id.to_string()),
        Some(&serde_json::json!({ "base_salary": before.base_salary })),
        Some(&serde_json::json!({ "base_salary": base_salary })),
    )?;
    tx.commit()?;
    Ok(())
}

/// Permanently delete an employee. ADMIN only.
///
/// # This is NOT the catalog delete
///
/// `services::catalog::delete_product` archives: a product row is referenced by
/// order lines and stock movements, so it is marked deleted and kept. An
/// employee cannot be handled that way — the employees table is the AUTHORITATIVE
/// roster, and a hidden row is exactly what "no longer an active employee record"
/// must not mean. So this really does remove the row, and the safety comes from
/// the guards below instead of from keeping the record.
///
/// # The guards, in order
///
///   1. **Authorization** — `ADMIN`, before anything is opened, so a MANAGER or
///      CASHIER call is rejected without touching the database. The command
///      repeats the check, so a direct Tauri invocation is refused too.
///   2. **No self-deletion** — deleting your own record would revoke the session
///      performing the delete. Same guard `set_employee_status` uses.
///   3. **No history** — attendance, advances, payroll runs and wash
///      attributions BLOCK the delete. Station will not destroy a salary
///      calculation or an attendance record to make a person removable; the
///      reversible answer for a departing employee with history is
///      `set_employee_status(..., "INACTIVE")`, which keeps every record.
///   4. **Login is exclusively owned** — a linked login is deleted with the
///      employee ONLY when nothing anywhere references it. A login that opened a
///      shift, raised an invoice, recorded an attendance day or finalized a
///      payroll run is a historical actor and is preserved, which means the
///      employee is deleted but the login survives. That is a deliberate,
///      documented outcome, not an orphan: `users` is a parent of those tables,
///      never a child of them.
///
/// Everything that does happen happens in ONE transaction with the audit entry,
/// so there is no partial deletion: either the employee (and, when safe, the
/// login) are gone and the deletion is on record, or nothing changed at all.
pub fn delete_employee(conn: &Db, actor: &User, employee_id: i64) -> AppResult<()> {
    auth::require_role(actor, "ADMIN")?;

    let tx = conn.unchecked_transaction()?;
    let before = employees::require(&tx, employee_id)?;

    if before.user_id == Some(actor.id) {
        return Err(AppError::business("employee.cannot_delete_self"));
    }

    let blockers = employees::delete_blockers(&tx, employee_id)?;
    if !blockers.is_empty() {
        return Err(AppError::business("employee.has_history"));
    }

    // Delete the employee FIRST, then ask whether anything still references the
    // login. The order matters: `employees.user_id` is itself a reference, so
    // counting first would always report the row this call is about to remove
    // and the login could never be judged "exclusively owned". Both writes share
    // the transaction, so a later failure still rolls the employee back.
    employees::delete(&tx, employee_id)?;

    // The linked login is deleted only when nothing anywhere references it. A
    // login that opened a shift, raised an invoice, recorded an attendance day or
    // finalized a payroll run is a historical actor and is preserved instead.
    let login_deleted = match before.user_id {
        None => false,
        Some(user_id) => {
            let references = crate::repositories::users::reference_count(&tx, user_id)?;
            if references > 0 {
                false
            } else {
                crate::repositories::users::delete(&tx, user_id)? > 0
            }
        }
    };

    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "employee.deleted",
        "employee",
        Some(&employee_id.to_string()),
        Some(&serde_json::json!({
            "name": before.name,
            "employee_type": before.employee_type,
            "status": before.status,
            "user_id": before.user_id,
            // Whether the linked login went with the employee or was preserved
            // as a historical actor — recorded so the audit trail states which
            // of the two outcomes actually happened.
            "login_deleted": login_deleted,
        })),
        None,
    )?;

    tx.commit()?;
    Ok(())
}

/// Activate or deactivate an employee. MANAGER+.
///
/// Deactivation is REVERSIBLE and non-destructive: the row stays, its history
/// stays, and only the status changes. Nothing is ever deleted, because an
/// employee participates in historical invoices, payments and reports that must
/// keep resolving to them.
///
/// The linked login is suspended in the SAME transaction, so an inactive
/// employee can never authenticate — a real authorization rule applied together
/// with the HR fact it belongs to, rather than as a second, separate action that
/// a manager could forget.
///
/// The guards are the ones the standalone staff screen enforced, kept verbatim:
/// nobody may deactivate themselves, and only an ADMIN may deactivate an ADMIN.
pub fn set_employee_status(
    conn: &Db,
    actor: &User,
    employee_id: i64,
    status: &str,
) -> AppResult<()> {
    auth::require_role(actor, "MANAGER")?;
    if !["ACTIVE", "INACTIVE"].contains(&status) {
        return Err(AppError::validation("employee.invalid_status"));
    }
    let tx = conn.unchecked_transaction()?;
    let before = employees::require(&tx, employee_id)?;
    if before.user_id == Some(actor.id) {
        return Err(AppError::business("user.cannot_suspend_self"));
    }
    // The staff screen's privilege guard, preserved: a manager who is not an
    // ADMIN must not be able to switch off an ADMIN's employee record, and with
    // the cascade below, their LOGIN either.
    if before.login_role.as_deref() == Some("ADMIN") && actor.role != "ADMIN" {
        return Err(AppError::unauthorized("auth.admin_only"));
    }
    employees::set_status(&tx, employee_id, status)?;
    if let Some(user_id) = before.user_id {
        let user_status = if status == "ACTIVE" {
            "ACTIVE"
        } else {
            "SUSPENDED"
        };
        crate::repositories::users::set_status(&tx, user_id, user_status)?;
    }
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        if status == "ACTIVE" {
            "employee.activated"
        } else {
            "employee.deactivated"
        },
        "employee",
        Some(&employee_id.to_string()),
        Some(&serde_json::json!({ "status": before.status })),
        Some(&serde_json::json!({ "status": status })),
    )?;
    tx.commit()?;
    Ok(())
}

/// The advances form payload. Amounts arrive as piasters from the UI's existing
/// money parsing, never as floats.
#[derive(Debug, Deserialize)]
pub struct AdvanceInput {
    pub amount: Money,
    pub advance_date: Option<String>,
    pub reason: String,
}

/// Record an advance. MANAGER+.
///
/// An advance is an immutable money transaction: it is INSERTED, never updated
/// or deleted. A later mistake is corrected by [`reverse_advance`], the same
/// reversal pattern Station already uses for financial documents.
///
/// # This is the DIRECT, ledger-only path
///
/// An advance is money the café spent, so the ordinary way to record one is now
/// the EXPENSE workflow (`services::ops::create_expense`), which writes the
/// expense and its linked advance in ONE transaction. This function remains for a
/// direct ledger entry, and it is deliberately the only path that does NOT create
/// an expense: it therefore writes `expense_id = NULL`, which the salary queries
/// read exactly like a historical advance. It never fabricates an expense, so one
/// advance can never end up claimed by two records.
pub fn create_advance(
    conn: &Db,
    actor: &User,
    employee_id: i64,
    input: &AdvanceInput,
) -> AppResult<i64> {
    auth::require_role(actor, "MANAGER")?;
    let (amount, advance_date, reason) = validate_advance(input)?;
    let tx = conn.unchecked_transaction()?;
    let id = insert_advance_in(
        &tx,
        actor,
        employee_id,
        amount,
        &advance_date,
        &reason,
        None,
    )?;
    tx.commit()?;
    Ok(id)
}

/// The one place an advance row is written, so validation, the employee check and
/// the audit entry cannot differ between the two creation paths.
///
/// The caller owns the transaction, which is what lets the expense workflow put
/// the expense and this row in the same atomic unit.
fn insert_advance_in(
    tx: &crate::repositories::Db,
    actor: &User,
    employee_id: i64,
    amount: Money,
    advance_date: &str,
    reason: &str,
    expense_id: Option<i64>,
) -> AppResult<i64> {
    // The employee must exist: a foreign key would refuse the row, but naming the
    // person in the error is what tells a manager what to fix.
    employees::require(tx, employee_id)?;
    let id = employee_analytics::insert_advance(
        tx,
        employee_id,
        amount,
        advance_date,
        reason,
        actor.id,
        expense_id,
    )?;
    crate::services::audit::record(
        tx,
        Some(actor.id),
        Some(&actor.role),
        "advance.created",
        "employee_advance",
        Some(&id.to_string()),
        None,
        Some(&serde_json::json!({
            "employee_id": employee_id,
            "amount": amount,
            "advance_date": advance_date,
            "reason": reason,
            "expense_id": expense_id,
        })),
    )?;
    Ok(id)
}

/// The public seam the EXPENSE workflow uses to write the advance half of an
/// advance-expense, inside the transaction it already owns.
///
/// It is the same [`insert_advance_in`] the direct path calls, exposed because an
/// advance created from an expense MUST be atomic with that expense: SQLite has
/// no nested transaction, so the higher-level flow opens one transaction and both
/// writes join it. A partial write is therefore impossible — if this fails, the
/// expense is rolled back with it.
pub fn link_advance_to_expense(
    tx: &Db,
    actor: &User,
    employee_id: i64,
    input: &AdvanceInput,
    expense_id: i64,
) -> AppResult<i64> {
    let (amount, advance_date, reason) = validate_advance(input)?;
    insert_advance_in(
        tx,
        actor,
        employee_id,
        amount,
        &advance_date,
        &reason,
        Some(expense_id),
    )
}

/// Validate an advance's own fields, returning the resolved amount, date and
/// reason. Shared by the direct path and by the expense workflow, so an advance
/// can never be valid on one screen and invalid on the other.
fn validate_advance(input: &AdvanceInput) -> AppResult<(Money, String, String)> {
    if input.amount <= 0 {
        return Err(AppError::validation("advance.invalid_amount"));
    }
    let reason = input.reason.trim();
    if reason.is_empty() {
        return Err(AppError::validation("advance.reason_required"));
    }
    // A blank date means "today" — the same default the expenses domain uses, so
    // the manager does not have to pick a day they are already standing in.
    let advance_date = clean(input.advance_date.as_deref())
        .map(str::to_string)
        .unwrap_or_else(crate::time::today_business_date);
    attendance::validate_business_date(&advance_date)?;
    Ok((input.amount, advance_date, reason.to_string()))
}

/// Reverse an advance. MANAGER+.
///
/// The original row is never deleted and its amount is never altered: only its
/// status and reversal stamp change, and the audit entry records the before and
/// after. A reversal of a reversal is refused — money is corrected once, in one
/// direction, so a run of toggles cannot fabricate history.
pub fn reverse_advance(conn: &Db, actor: &User, advance_id: i64) -> AppResult<()> {
    auth::require_role(actor, "MANAGER")?;
    let tx = conn.unchecked_transaction()?;
    let before = employee_analytics::find_advance(&tx, advance_id)?
        .ok_or_else(|| AppError::not_found("advance.not_found"))?;
    if before.status != "RECORDED" {
        return Err(AppError::conflict("advance.already_reversed"));
    }
    // A FINALIZED payroll run has already published a net figure that included
    // this money; reversing it now would silently contradict a document that was
    // already produced.
    if payroll_month_is_finalized(&tx, before.employee_id, &before.advance_date)? {
        return Err(AppError::conflict("advance.used_by_finalized_payroll"));
    }
    let changed = employee_analytics::reverse_advance(&tx, advance_id, actor.id, advance_id)?;
    if changed == 0 {
        return Err(AppError::conflict("advance.already_reversed"));
    }
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "advance.reversed",
        "employee_advance",
        Some(&advance_id.to_string()),
        Some(&serde_json::json!({ "status": before.status, "amount": before.amount })),
        Some(&serde_json::json!({ "status": "REVERSED" })),
    )?;
    tx.commit()?;
    Ok(())
}

/// Has a FINALIZED payroll run already covered the month this business date
/// falls in, for this employee?
///
/// Deliberately conservative: any finalized run for that employee in that month
/// blocks the operation, because that run has already published a net figure.
///
/// This is ONE helper for BOTH directions of the same invariant — reversing an
/// advance and recording a deduction. They are the same fact seen from two sides:
/// either one would move a month whose payslip is already frozen, and would
/// silently contradict a document that was already produced. Keeping a single
/// implementation is what stops the two from drifting apart again.
fn payroll_month_is_finalized(conn: &Db, employee_id: i64, business_date: &str) -> AppResult<bool> {
    // The date was validated as `YYYY-MM-DD` when it was written, so the period
    // prefix is exactly its month.
    let period = &business_date[..7];
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM payroll_runs
                       WHERE employee_id = ?1 AND period = ?2 AND status = 'FINALIZED')",
        rusqlite::params![employee_id, period],
        |r| r.get(0),
    )?)
}

/// A payroll period, `YYYY-MM`. Parsed, never string-sliced, so `2026-9` is a
/// validation error instead of a period that silently matches nothing.
fn parse_period(period: &str) -> AppResult<(String, String, String)> {
    let text = period.trim();
    let (year, month) = text
        .split_once('-')
        .ok_or_else(|| AppError::validation("payroll.invalid_period"))?;
    if year.len() != 4 || !year.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::validation("payroll.invalid_period"));
    }
    if month.len() != 2 || !month.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::validation("payroll.invalid_period"));
    }
    let month_num: u32 = month
        .parse()
        .map_err(|_| AppError::validation("payroll.invalid_period"))?;
    if !(1..=12).contains(&month_num) {
        return Err(AppError::validation("payroll.invalid_period"));
    }
    let first = format!("{year}-{month}-01");
    // The last day is derived by asking the calendar for the day before the
    // first of the next month, so a 31-day month and a leap February are both
    // correct without a hand-maintained days-in-month table.
    let next_year = year.parse::<i32>().unwrap_or(0) + i32::from(month_num == 12);
    let next_month = if month_num == 12 { 1 } else { month_num + 1 };
    let last = chrono::NaiveDate::parse_from_str(
        &format!("{next_year:04}-{next_month:02}-01"),
        "%Y-%m-%d",
    )
    .ok()
    .and_then(|d| d.pred_opt())
    .map(|d| d.to_string())
    .ok_or_else(|| AppError::validation("payroll.invalid_period"))?;
    Ok((text.to_string(), first, last))
}

/// The payroll formula, stated ONCE and used by both the preview and the stored
/// run:
///
/// ```text
/// net = base_salary - advances - deductions      (floored at 0)
/// ```
///
/// There is deliberately NO attendance-derived deduction: absence and leave are
/// reported to the manager as facts, and what (if anything) they cost is a
/// business decision the manager records explicitly. Inventing a per-absence
/// penalty here would be an undocumented rule that silently changes payroll.
pub fn compute_net(base_salary: Money, advances: Money, deductions: Money) -> Money {
    (base_salary - advances - deductions).max(0)
}

// ---------------------------------------------------------------------------
// DEDUCTIONS
// ---------------------------------------------------------------------------

/// What a manager records when money is withheld from an employee's pay.
///
/// The employee is NOT part of this input: the drawer already knows which person it
/// opened, so re-selecting them would only create a way to record a deduction
/// against the wrong person. The service still receives and validates the id.
#[derive(Debug, Clone, Deserialize)]
pub struct DeductionInput {
    pub amount: Money,
    /// `None` means today, the same default the advances and expenses use.
    pub deduction_date: Option<String>,
    /// Optional free text. Station documents no mandatory reason, so an empty one
    /// is a valid record rather than a rejected form.
    pub reason: Option<String>,
}

/// Record a deduction. MANAGER+.
///
/// A deduction is money withheld from a payslip, not money spent, so it creates NO
/// expense and touches no expense aggregate. It is written to `employee_deductions`
/// and read by the salary figures only.
pub fn create_deduction(
    conn: &Db,
    actor: &User,
    employee_id: i64,
    input: &DeductionInput,
) -> AppResult<i64> {
    auth::require_role(actor, "MANAGER")?;
    if input.amount <= 0 {
        return Err(AppError::validation("deduction.invalid_amount"));
    }
    let date = clean(input.deduction_date.as_deref())
        .map(str::to_string)
        .unwrap_or_else(crate::time::today_business_date);
    attendance::validate_business_date(&date)?;
    let reason = clean(input.reason.as_deref());

    let tx = conn.unchecked_transaction()?;
    // A deduction against a person who does not exist is refused by name, not left
    // to a foreign-key failure the manager cannot act on.
    employees::require(&tx, employee_id)?;
    // The SAME guard an advance reversal carries, for the SAME reason. A FINALIZED
    // payroll run has already published a net figure for this month; a deduction
    // dated inside it would move the drawer's salary for a month that was already
    // paid, and — because a deduction is append-only and has no reversal of its
    // own — nothing could ever put that month back. One invariant, one helper.
    if payroll_month_is_finalized(&tx, employee_id, &date)? {
        return Err(AppError::conflict("deduction.month_finalized"));
    }
    let id = employee_analytics::insert_deduction(
        &tx,
        employee_id,
        input.amount,
        &date,
        reason,
        actor.id,
    )?;
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "deduction.created",
        "employee_deduction",
        Some(&id.to_string()),
        None,
        Some(&serde_json::json!({
            "employee_id": employee_id,
            "amount": input.amount,
            "deduction_date": date,
            "reason": reason,
        })),
    )?;
    tx.commit()?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// SALARY FIGURES FOR A PERIOD
// ---------------------------------------------------------------------------

/// The salary block the Employee Drawer renders, for the Employees page's own
/// date range.
///
/// Every number is produced by SQL inside the service; the UI performs no
/// arithmetic. `months` is returned so the screen can explain the base salary
/// instead of the reader having to guess why a number moved.
#[derive(Debug, Clone, Serialize)]
pub struct EmployeeFinancials {
    /// The bounds the figures were filtered by. `None` on a bound means unbounded,
    /// exactly as the rest of Station's period handling.
    pub from: Option<String>,
    pub to: Option<String>,
    /// How many calendar months the salary was counted for.
    pub months: i64,
    /// `base_salary × months`. Never prorated by days: a monthly salary is a
    /// monthly amount.
    pub base_salary: Money,
    /// Live (non-reversed) advances inside the window.
    pub advances: Money,
    /// Deductions inside the window.
    pub deductions: Money,
    /// Salary PAYMENTS recorded against this employee inside the window.
    ///
    /// Reported beside the advances so a manager can tell the two money sides
    /// apart at a glance: this is what was PAID, `advances` is what was taken
    /// back. It is a reporting figure and is NOT an input to `net_salary`.
    pub salary_paid: Money,
    /// The one shared net formula, applied to the period totals.
    pub net_salary: Money,
}

/// The month a business date falls in, as a comparable count of months.
///
/// Parsed, never string-sliced, so a malformed day can never be filed under an
/// invented month. An unparseable value maps to 0, which can only widen a window,
/// never narrow it into a wrong figure.
fn month_index(day: &str) -> i64 {
    chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .map(|d| d.year() as i64 * 12 + d.month0() as i64)
        .unwrap_or(0)
}

/// How many calendar months a window touches, and why.
///
/// A bounded window is counted from its own first and last day. An unbounded one
/// has no start to read, so the earliest eligible month is the employee's own
/// creation month and the latest is the current business month — never "since the
/// beginning of time", which would multiply a monthly salary by an invented span.
///
/// The result is at least 1: an employee who exists has, at minimum, the month
/// they joined, and a zero-month base salary would be a worse lie than one month.
fn months_in_window(employee: &Employee, from: Option<&str>, to: Option<&str>) -> i64 {
    let created = crate::time::business_date_of(
        crate::time::parse_timestamp(&employee.created_at).unwrap_or_else(crate::time::now_utc),
    );
    // The employee's own creation month is the floor: a window reaching further
    // back than they existed still starts at the month they joined.
    let requested_start = from.map_or_else(|| created.clone(), str::to_string);
    let first_day = if requested_start < created {
        created
    } else {
        requested_start
    };
    let requested_end = to.map_or_else(crate::time::today_business_date, str::to_string);
    let last_day = if requested_end < first_day {
        first_day.clone()
    } else {
        requested_end
    };
    (month_index(&last_day) - month_index(&first_day) + 1).max(1)
}

/// Build the drawer's salary block for the selected period.
///
/// Two indexed aggregate reads — no ledger rows are fetched to be summed in Rust —
/// and the net figure comes from the SAME [`compute_net`] the monthly payroll
/// snapshot uses, so a payslip and a drawer can never state different arithmetic.
pub fn financials(
    conn: &Db,
    employee: &Employee,
    period: &EmployeePeriod,
) -> AppResult<EmployeeFinancials> {
    let (from, to) = period.bounds();
    let months = months_in_window(employee, from, to);
    let advances = employee_analytics::advances_total(conn, employee.id, from, to)?;
    let deductions = employee_analytics::deductions_total(conn, employee.id, from, to)?;
    // The salary payments are read from the EXPENSE side, through the employee the
    // manager selected when recording each one. Advances are excluded there, so
    // this never double-counts the figure above.
    let salary_paid = employee_analytics::salary_paid_total(conn, employee.id, from, to)?;
    let base_salary = employee.base_salary.saturating_mul(months);
    Ok(EmployeeFinancials {
        from: from.map(str::to_string),
        to: to.map(str::to_string),
        months,
        base_salary,
        salary_paid,
        advances,
        deductions,
        // The formula is UNCHANGED and still the one shared with the payroll
        // snapshot: a salary already paid is reported beside it, never subtracted
        // by it.
        net_salary: compute_net(base_salary, advances, deductions),
    })
}

/// What a payroll run WOULD contain, before it is written.
///
/// Exposed as its own read so the manager sees the exact figures — attendance
/// counters, advances, net — that pressing "create" will freeze. The numbers come
/// from the same aggregation the stored run uses, so the preview and the document
/// can never disagree.
#[derive(Debug, Serialize)]
pub struct PayrollPreview {
    pub employee_id: i64,
    pub period: String,
    pub base_salary: Money,
    pub attendance_days: i64,
    pub worked_minutes: i64,
    pub absence_days: i64,
    pub leave_days: i64,
    pub advances: Money,
    /// Always zero here: Station documents no attendance-based deduction rule,
    /// so a preview never invents one. A manager may enter one explicitly when
    /// creating the run.
    pub deductions: Money,
    pub net_salary: Money,
    /// True when a run already exists for this employee and period.
    pub exists: bool,
    pub existing_status: Option<String>,
}

pub fn payroll_preview(
    conn: &Db,
    actor: &User,
    employee_id: i64,
    period: &str,
) -> AppResult<PayrollPreview> {
    auth::require_role(actor, "MANAGER")?;
    let (period, first, last) = parse_period(period)?;
    let employee = employees::require(conn, employee_id)?;
    let (attendance_days, absence_days, leave_days, worked_minutes) =
        employee_analytics::month_attendance(conn, employee_id, &first, &last)?;
    let advances = employee_analytics::advances_total_for_month(conn, employee_id, &first, &last)?;
    let existing = employee_analytics::run_for(conn, employee_id, &period)?;
    Ok(PayrollPreview {
        employee_id,
        period,
        base_salary: employee.base_salary,
        attendance_days,
        worked_minutes,
        absence_days,
        leave_days,
        advances,
        deductions: 0,
        net_salary: compute_net(employee.base_salary, advances, 0),
        exists: existing.is_some(),
        existing_status: existing.map(|r| r.status),
    })
}

/// Create (or re-create) a DRAFT payroll run. MANAGER+.
///
/// The run COPIES the base salary, the attendance counters, the advances and the
/// net onto its own row. From that moment the run no longer reads `employees` or
/// `attendance_days`, which is precisely what makes a finalized month immutably
/// its own. A FINALIZED run is never replaced — re-creating a month that was
/// already paid is refused, not overwritten.
pub fn create_payroll_run(
    conn: &Db,
    actor: &User,
    employee_id: i64,
    period: &str,
    deductions: Money,
) -> AppResult<PayrollRun> {
    auth::require_role(actor, "MANAGER")?;
    if deductions < 0 {
        return Err(AppError::validation("payroll.invalid_deductions"));
    }
    let (period, first, last) = parse_period(period)?;

    let tx = conn.unchecked_transaction()?;
    let employee = employees::require(&tx, employee_id)?;
    if employee_analytics::run_for(&tx, employee_id, &period)?
        .is_some_and(|existing| existing.status == "FINALIZED")
    {
        return Err(AppError::conflict("payroll.already_finalized"));
    }
    let (attendance_days, absence_days, leave_days, worked_minutes) =
        employee_analytics::month_attendance(&tx, employee_id, &first, &last)?;
    let advances = employee_analytics::advances_total_for_month(&tx, employee_id, &first, &last)?;
    let net = compute_net(employee.base_salary, advances, deductions);

    let id = employee_analytics::insert_run(
        &tx,
        employee_id,
        &period,
        employee.base_salary,
        attendance_days,
        worked_minutes,
        absence_days,
        leave_days,
        advances,
        deductions,
        net,
        actor.id,
    )?;
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "payroll.created",
        "payroll_run",
        Some(&id.to_string()),
        None,
        Some(&serde_json::json!({
            "employee_id": employee_id,
            "period": period,
            "base_salary": employee.base_salary,
            "attendance_days": attendance_days,
            "absence_days": absence_days,
            "leave_days": leave_days,
            "advances": advances,
            "deductions": deductions,
            "net_salary": net,
        })),
    )?;
    tx.commit()?;

    employee_analytics::find_run(conn, id)?
        .ok_or_else(|| AppError::internal("payroll run missing after commit"))
}

/// Finalize a payroll run. MANAGER+.
///
/// This is the point of no return, and the repository's `WHERE status = 'DRAFT'`
/// is the guard that makes it real: a second finalize touches zero rows and is
/// refused, so a finalized run can never be re-stamped or re-computed.
pub fn finalize_payroll_run(conn: &Db, actor: &User, run_id: i64) -> AppResult<PayrollRun> {
    auth::require_role(actor, "MANAGER")?;
    let tx = conn.unchecked_transaction()?;
    let before = employee_analytics::find_run(&tx, run_id)?
        .ok_or_else(|| AppError::not_found("payroll.not_found"))?;
    if before.status != "DRAFT" {
        return Err(AppError::conflict("payroll.already_finalized"));
    }
    let changed = employee_analytics::finalize_run(&tx, run_id, actor.id)?;
    if changed == 0 {
        return Err(AppError::conflict("payroll.already_finalized"));
    }
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "payroll.finalized",
        "payroll_run",
        Some(&run_id.to_string()),
        Some(&serde_json::json!({ "status": before.status, "net_salary": before.net_salary })),
        Some(&serde_json::json!({ "status": "FINALIZED", "finalized_by": actor.id })),
    )?;
    tx.commit()?;

    employee_analytics::find_run(conn, run_id)?
        .ok_or_else(|| AppError::internal("payroll run missing after commit"))
}

/// The employee details drawer payload — one manager-level read.
///
/// A FIXED number of queries, never one per section: the identity and its period
/// figures come from the same `list_rows` projection the table uses, and the
/// timeline, the two ledgers and the payroll runs are four more reads. The UI
/// therefore performs no arithmetic and cannot disagree with the table.
#[derive(Debug, Serialize)]
pub struct EmployeeDetails {
    pub employee: Employee,
    /// The matching row of the current period, so the drawer's header figures are
    /// literally the ones the table showed.
    pub period_row: Option<EmployeeRow>,
    pub attendance: Vec<employee_analytics::AttendanceDay>,
    /// Advances inside the SELECTED PERIOD — the same range the salary cards use.
    pub advances: Vec<Advance>,
    /// Deductions inside the same period.
    pub deductions: Vec<employee_analytics::Deduction>,
    /// The period's salary figures, aggregated in SQL. The four cards render these
    /// values as they arrive.
    pub financials: EmployeeFinancials,
    pub payroll: Vec<PayrollRun>,
}

/// How many days the drawer timeline reads. Bounded so a multi-year range can
/// never pull an unbounded history into the UI; the totals are unaffected because
/// they are aggregated in SQL, not counted from these rows.
const TIMELINE_LIMIT: i64 = 400;

/// How many ledger rows the drawer's advances/deductions lists read, per the
/// same reasoning as [`TIMELINE_LIMIT`]: a bounded list, aggregated totals.
const LEDGER_LIMIT: i64 = 200;

pub fn details(
    conn: &Db,
    actor: &User,
    employee_id: i64,
    period: &EmployeePeriod,
) -> AppResult<EmployeeDetails> {
    auth::require_role(actor, "MANAGER")?;
    let employee = employees::require(conn, employee_id)?;
    let (from, to) = period.bounds();
    let period_row = employee_analytics::list_rows(conn, &period.to_period(), true, true, "")?
        .into_iter()
        .find(|row| row.id == employee_id);
    // The salary block is built from the SAME employee row and the SAME bounds the
    // rest of the drawer uses, so a period filter change moves every figure at once.
    let financials = financials(conn, &employee, period)?;
    Ok(EmployeeDetails {
        advances: employee_analytics::advances_of(conn, employee_id, from, to, LEDGER_LIMIT)?,
        deductions: employee_analytics::deductions_of(conn, employee_id, from, to, LEDGER_LIMIT)?,
        employee,
        period_row,
        attendance: employee_analytics::days_of_employee(
            conn,
            employee_id,
            from,
            to,
            TIMELINE_LIMIT,
        )?,
        payroll: employee_analytics::runs_of(conn, employee_id)?,
        financials,
    })
}

/// Active wash workers, for the POS attribution picker. Naming the worker is part
/// of taking the order, not a management task.
pub fn active_wash_workers(conn: &Db) -> AppResult<Vec<Employee>> {
    employees::list_by_type(conn, WASH_WORKER)
}

/// Attribute a wash job to the wash worker who did it. STAFF+.
///
/// The attribution lives on the ORDER while the job is open and is SNAPSHOTTED
/// onto the invoice at checkout, so a finalized document is never re-read from a
/// mutable master — the same rule every other invoice field follows. Setting it
/// on a settled order is refused, because from that moment the invoice's snapshot
/// is the truth.
pub fn set_order_wash_employee(
    conn: &Db,
    actor: &User,
    order_id: i64,
    wash_employee_id: Option<i64>,
) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    let order_status: String = tx
        .query_row(
            "SELECT status FROM orders WHERE id = ?1",
            rusqlite::params![order_id],
            |r| r.get(0),
        )
        .map_err(|_| AppError::not_found("pos.order_not_found"))?;
    if order_status == "CLOSED" || order_status == "CANCELLED" {
        return Err(AppError::business("employees.order_already_settled"));
    }
    if let Some(id) = wash_employee_id {
        let employee = employees::require(&tx, id)?;
        if employee.employee_type != WASH_WORKER {
            return Err(AppError::validation("employees.not_a_wash_worker"));
        }
        if employee.status != "ACTIVE" {
            return Err(AppError::business("attendance.employee_inactive"));
        }
    }
    pos_repo::set_order_wash_employee(&tx, order_id, wash_employee_id)?;
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "invoice.wash_employee_assigned",
        "order",
        Some(&order_id.to_string()),
        None,
        Some(&serde_json::json!({ "wash_employee_id": wash_employee_id })),
    )?;
    tx.commit()?;
    Ok(())
}
