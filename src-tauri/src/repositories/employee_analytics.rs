//! Attendance, performance, advance and payroll repository — the ONLY SQL for
//! the employees domain's derived reads.
//!
//! Every figure here is produced by ONE grouped pass, never by loading rows into
//! Rust and adding them up. The list query in particular LEFT JOINs pre-aggregated
//! CTEs, so a page of 50 employees costs a constant number of table passes
//! instead of three queries per employee.
//!
//! Worked hours are always EFFECTIVE minutes. The `actual` timestamps are stored
//! for audit and are never used in a total.
//!
//! # Attribution rules, stated once and enforced only here
//!
//! * **CASHIER** — `shifts.user_id` links a shift to the login that opened it,
//!   so the cashier's revenue is the `cafe_total` snapshot of the invoices
//!   invoices booked to those shifts.
//! * **WASH_WORKER** — `invoices.wash_employee_id` snapshots the worker at
//!   checkout. `NULL` means unattributed, and an unattributed invoice is never
//!   redistributed to whoever happens to be on the roster.

use crate::error::AppResult;
use crate::repositories::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// One attendance day, as the drawer timeline reads it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttendanceDay {
    pub id: i64,
    pub employee_id: i64,
    pub business_date: String,
    pub state: String,
    pub check_in_actual_at: Option<String>,
    pub check_in_effective_at: Option<String>,
    pub check_out_actual_at: Option<String>,
    pub check_out_effective_at: Option<String>,
    /// Worked minutes between the EFFECTIVE punches; `None` while the day is
    /// still open. A running total is deliberately not offered.
    pub worked_minutes: Option<i64>,
    pub shift_id: Option<i64>,
    /// Who pressed the button. For a wash worker this is the only trace of the
    /// cashier who recorded them, so it is always returned.
    pub recorded_by_user_id: i64,
    pub recorded_by_name: String,
    pub note: Option<String>,
}

const DAY_COLS: &str = "a.id, a.employee_id, a.business_date, a.state,
    a.check_in_actual_at, a.check_in_effective_at,
    a.check_out_actual_at, a.check_out_effective_at,
    a.shift_id, a.recorded_by_user_id, a.note";

fn day_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AttendanceDay> {
    let check_in_effective: Option<String> = row.get(5)?;
    let check_out_effective: Option<String> = row.get(7)?;
    let worked_minutes = crate::services::attendance::worked_minutes_of(
        check_in_effective.as_deref(),
        check_out_effective.as_deref(),
    );
    Ok(AttendanceDay {
        id: row.get(0)?,
        employee_id: row.get(1)?,
        business_date: row.get(2)?,
        state: row.get(3)?,
        check_in_actual_at: row.get(4)?,
        check_in_effective_at: check_in_effective,
        check_out_actual_at: row.get(6)?,
        check_out_effective_at: check_out_effective,
        shift_id: row.get(8)?,
        recorded_by_user_id: row.get(9)?,
        recorded_by_name: String::new(),
        note: row.get(10)?,
        worked_minutes,
    })
}

/// Live (non-voided) attendance days of ONE employee, newest first.
pub fn days_of_employee(
    conn: &Db,
    employee_id: i64,
    from: Option<&str>,
    to: Option<&str>,
    limit: i64,
) -> AppResult<Vec<AttendanceDay>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {DAY_COLS}, u.name
         FROM attendance_days a JOIN users u ON u.id = a.recorded_by_user_id
         WHERE a.employee_id = ?1 AND a.voided_at IS NULL
           AND (?2 IS NULL OR a.business_date >= ?2)
           AND (?3 IS NULL OR a.business_date <= ?3)
         ORDER BY a.business_date DESC, a.id DESC
         LIMIT ?4"
    ))?;
    let rows = stmt.query_map(params![employee_id, from, to, limit], |row| {
        let mut day = day_row(row)?;
        day.recorded_by_name = row.get(11)?;
        Ok(day)
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// The live attendance row of one employee for one business day, if any.
pub fn day_of_employee(
    conn: &Db,
    employee_id: i64,
    business_date: &str,
) -> AppResult<Option<AttendanceDay>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {DAY_COLS}, u.name
         FROM attendance_days a JOIN users u ON u.id = a.recorded_by_user_id
         WHERE a.employee_id = ?1 AND a.business_date = ?2 AND a.voided_at IS NULL"
    ))?;
    let mut rows = stmt.query(params![employee_id, business_date])?;
    match rows.next()? {
        Some(row) => {
            let mut day = day_row(row)?;
            day.recorded_by_name = row.get(11)?;
            Ok(Some(day))
        }
        None => Ok(None),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn insert_day(
    conn: &Db,
    employee_id: i64,
    business_date: &str,
    state: &str,
    check_in_actual_at: Option<&str>,
    check_in_effective_at: Option<&str>,
    check_out_actual_at: Option<&str>,
    check_out_effective_at: Option<&str>,
    shift_id: Option<i64>,
    recorded_by_user_id: i64,
    note: Option<&str>,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO attendance_days (employee_id, business_date, state,
             check_in_actual_at, check_in_effective_at,
             check_out_actual_at, check_out_effective_at,
             shift_id, recorded_by_user_id, note)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            employee_id,
            business_date,
            state,
            check_in_actual_at,
            check_in_effective_at,
            check_out_actual_at,
            check_out_effective_at,
            shift_id,
            recorded_by_user_id,
            note
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Close an open day by writing the check-out pair onto the SAME row.
///
/// This is the one attendance mutation that updates in place, and it is safe
/// precisely because it only ever fills a column the database CHECK proved was
/// NULL (`actual IS NULL AND effective IS NULL`). The original check-in and its
/// actual timestamp are never rewritten.
pub fn set_check_out(
    conn: &Db,
    day_id: i64,
    actual_at: &str,
    effective_at: &str,
) -> AppResult<usize> {
    conn.execute(
        "UPDATE attendance_days
         SET check_out_actual_at = ?2, check_out_effective_at = ?3, updated_at = station_now()
         WHERE id = ?1 AND check_out_actual_at IS NULL AND voided_at IS NULL",
        params![day_id, actual_at, effective_at],
    )
    .map_err(Into::into)
}

/// Void a superseded day. The row is KEPT — corrections never delete history —
/// and the partial unique index frees the (employee, day) slot for its
/// replacement.
pub fn void_day(conn: &Db, day_id: i64, by_user_id: i64) -> AppResult<usize> {
    conn.execute(
        "UPDATE attendance_days
         SET voided_at = station_now(), voided_by_user_id = ?2, updated_at = station_now()
         WHERE id = ?1 AND voided_at IS NULL",
        params![day_id, by_user_id],
    )
    .map_err(Into::into)
}

/// An inclusive business-date window. `None` means unbounded, exactly like the
/// reports service treats an empty date filter.
#[derive(Debug, Clone, Default)]
pub struct Period {
    pub from: Option<String>,
    pub to: Option<String>,
}

/// An employee row for the list, with every period figure already aggregated by
/// SQL. The UI performs NO arithmetic on these numbers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmployeeRow {
    pub id: i64,
    pub user_id: Option<i64>,
    pub name: String,
    pub phone: Option<String>,
    pub employee_type: String,
    pub status: String,
    /// The linked login's role. `None` for a wash worker — and `None` for EVERY
    /// row when the caller is not a manager, because a login role is account
    /// information, not attendance information. This — not `employee_type` — is
    /// what the table's role badge must render.
    pub login_role: Option<String>,
    /// Base salary in piasters. Manager-level only: absent for a cashier.
    pub base_salary: Option<i64>,
    /// Free-text HR notes. Manager-level only: absent for a cashier.
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    // Attendance, for the selected range. `attendance_days` counts PRESENT days
    // only — the same figure the payroll snapshot freezes — and `worked_minutes`
    // is measured between the EFFECTIVE punches.
    //
    // These four are HR ANALYTICS about a colleague, not the state of today, so
    // they are `None` for a caller who may only operate attendance: the cashier
    // roster carries TODAY's live row and nothing else about the past.
    pub attendance_days: Option<i64>,
    pub worked_minutes: Option<i64>,
    pub absence_days: Option<i64>,
    pub leave_days: Option<i64>,
    // TODAY's live state, deliberately outside the selected period: it
    // describes right now, so a past range must not hide who is at the till.
    pub today_state: Option<String>,
    pub today_check_in_effective_at: Option<String>,
    pub today_check_out_effective_at: Option<String>,
    // Performance. The meaning depends on `employee_type` and is documented in
    // the service: a cashier is measured by the shifts their login opened and
    // the cafe money booked to them.
    //
    // There is deliberately NO wash-worker revenue figure here. Washing is a
    // SHARED department: its revenue belongs to the WASH department as a whole,
    // so attributing it to an individual worker would be a fabrication. A wash
    // worker is managed through attendance and salary, never through a
    // personal revenue ranking.
    //
    // Both are manager-level, so they are `None` for an attendance-only caller:
    // revenue and individual performance are management information.
    pub shifts_count: Option<i64>,
    pub cafe_revenue: Option<i64>,
}

/// A named leader, as the KPI band renders it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Leader {
    pub employee_id: i64,
    pub name: String,
    pub value: i64,
}

/// The KPI band payload.
///
/// Every counter here is a HEADCOUNT OF UNIQUE EMPLOYEE RECORDS — never login
/// rows, attendance days, shifts or invoices, and never a row duplicated by a
/// join. `total_employees` counts each `employees.id` once.
///
/// The two type counters are counted by the role the person is PRESENTED under
/// (the same decision `src/lib/roles.ts` `employeeRole` makes), not by
/// `employees.employee_type`. The type only records whether the person HAS a
/// login, and every login in Station is a `CASHIER` employee — so counting the
/// type would report the admins and managers as cashiers too. "كاشير" is the
/// `STAFF` auth role.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EmployeeOverview {
    pub total_employees: i64,
    /// Employees presented as "كاشير" — i.e. whose login role is `STAFF`.
    pub total_cashiers: i64,
    /// Employees with no login, who can therefore only be wash workers.
    pub total_wash_workers: i64,
    /// Most attendance days in the range (any employee type).
    pub top_attendance: Option<Leader>,
    /// Most worked minutes in the range (any employee type).
    pub top_hours: Option<Leader>,
    /// Most shifts, CASHIERS ONLY.
    pub top_shifts: Option<Leader>,
    /// Highest cafe revenue, CASHIERS ONLY.
    pub top_cafe_revenue: Option<Leader>,
    // There is no per-worker wash leader, by design: wash revenue is a
    // department-level figure and is reported by the sales analytics, not
    // attributed to the individual who took the job.
}

/// Escape the LIKE wildcards so a search for "50%" finds the literal text.
fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// The inclusive-range predicate, shared verbatim by every aggregate below so
/// the list, the KPI band, the drawer and the payroll snapshot can never scope
/// different days. The parameters are always `?1` (from) and `?2` (to).
fn in_range(column: &str) -> String {
    format!("AND (?1 IS NULL OR {column} >= ?1) AND (?2 IS NULL OR {column} <= ?2)")
}

/// The pre-aggregated CTEs the list and the KPI band share.
///
/// Writing them once is what guarantees the table row and the KPI tile can never
/// report different numbers for the same period: both read [`list_rows`], and
/// the service reduces that same result set. There is no second definition of
/// "attendance days" anywhere in the application.
fn scoped_ctes() -> String {
    format!(
        "WITH att AS (
             SELECT ad.employee_id,
                    -- `days` counts PRESENT days ONLY, so it is the same figure
                    -- the payroll snapshot freezes. `absences` and `leaves` are
                    -- their own counters, the three never overlap, and their sum
                    -- is the number of RECORDED days in the period.
                    SUM(CASE WHEN ad.state = 'PRESENT' THEN 1 ELSE 0 END) AS days,
                    SUM(CASE WHEN ad.state = 'ABSENT' THEN 1 ELSE 0 END) AS absences,
                    SUM(CASE WHEN ad.state = 'LEAVE'  THEN 1 ELSE 0 END) AS leaves,
                    COALESCE(SUM(CAST(ROUND(
                        (julianday(ad.check_out_effective_at)
                       - julianday(ad.check_in_effective_at)) * 1440) AS INTEGER)), 0) AS minutes
             FROM attendance_days ad
             WHERE ad.voided_at IS NULL {att_range}
             GROUP BY ad.employee_id
         ),
         cashier AS (
             SELECT s.user_id AS employee_user_id, COUNT(*) AS shifts
             FROM shifts s JOIN business_days bd ON bd.id = s.business_day_id
             WHERE s.user_id IS NOT NULL {day_range}
             GROUP BY s.user_id
         ),
         cafe AS (
             SELECT s.user_id AS employee_user_id, COALESCE(SUM(i.cafe_total), 0) AS revenue
             FROM invoices i
             JOIN shifts s ON s.id = i.shift_id
             JOIN business_days bd ON bd.id = s.business_day_id
             WHERE 1=1 {day_range}
             GROUP BY s.user_id
         ),
         -- WASH REVENUE IS NOT HERE, ON PURPOSE.
         --
         -- Washing is a shared department: its money belongs to the WASH
         -- department as a whole and is reported at department level (see the
         -- sales analytics), never per worker. There was once a `wash` CTE that
         -- grouped invoices by `invoices.wash_employee_id` and produced a
         -- per-worker revenue figure. That aggregate was a fabrication — it
         -- implied each worker personally produced revenue he did not
         -- personally produce — so it is removed rather than merely hidden.
         --
         -- `invoices.wash_employee_id` remains a valid record of WHO TOOK THE
         -- JOB (operational accountability), and is still written by the POS;
         -- it simply no longer feeds a money figure.
         -- TODAY is deliberately outside the range filter: it describes right
         -- now, not the selected period, so a September range must not hide the
         -- fact that somebody is standing at the till this afternoon. It is one
         -- extra join, not one query per employee.
         today AS (
             SELECT ad.employee_id,
                    ad.state,
                    ad.check_in_effective_at,
                    ad.check_out_effective_at
             FROM attendance_days ad
             WHERE ad.voided_at IS NULL AND ad.business_date = station_today()
         )",
        att_range = in_range("ad.business_date"),
        day_range = in_range("bd.day_date"),
    )
}

/// The list query. `management` is the MANAGER projection, and it is the ONLY
/// thing that decides what a row may contain.
///
/// When it is false the row is an ATTENDANCE OPERATION ROW: the caller's one
/// legitimate reason to see a colleague is to punch them, so the query emits
/// `NULL` — not a zero, not a masked value — for salary, notes, the login role,
/// the period HR analytics and the performance figures. The browser therefore
/// never holds a figure it would only have to hide, and no formatting or
/// rounding path can leak one by accident.
///
/// What survives is exactly what an attendance operation needs: the identity
/// (name, phone, employee type), the employment status that decides whether a
/// punch is legal, and TODAY's live attendance row.
///
/// ONE statement, four LEFT JOINed pre-aggregates: a page of 50 employees is 50
/// rows out of a constant number of table passes, never 50 round trips.
pub fn list_rows(
    conn: &Db,
    period: &Period,
    management: bool,
    include_inactive: bool,
    query: &str,
) -> AppResult<Vec<EmployeeRow>> {
    // One helper for the whole projection, so a field can never be added to the
    // SELECT and silently leak: anything not named here is `None`.
    let or_null = |column: &str| {
        if management {
            column.to_string()
        } else {
            "NULL".to_string()
        }
    };
    let sql = format!(
        "{ctes}
         SELECT e.id, e.user_id, e.name, e.phone, e.employee_type, e.status,
                {login_role},
                {salary}, {notes}, e.created_at, e.updated_at,
                {days}, {minutes}, {absences}, {leaves},
                today.state, today.check_in_effective_at, today.check_out_effective_at,
                {shifts}, {revenue}
         FROM employees e
         LEFT JOIN users    u       ON u.id = e.user_id
         LEFT JOIN att     ON att.employee_id = e.id
         LEFT JOIN cashier ON cashier.employee_user_id = e.user_id
         LEFT JOIN cafe    ON cafe.employee_user_id = e.user_id
         LEFT JOIN today   ON today.employee_id = e.id
         WHERE (?3 = '' OR e.name LIKE ?3 ESCAPE '\\' OR IFNULL(e.phone, '') LIKE ?3 ESCAPE '\\')
           AND (?4 = 0 OR e.status = 'ACTIVE')
         ORDER BY CASE e.employee_type WHEN 'CASHIER' THEN 0 ELSE 1 END, e.name",
        ctes = scoped_ctes(),
        login_role = or_null("u.role"),
        salary = or_null("e.base_salary"),
        notes = or_null("e.notes"),
        days = or_null("COALESCE(att.days, 0)"),
        minutes = or_null("COALESCE(att.minutes, 0)"),
        absences = or_null("COALESCE(att.absences, 0)"),
        leaves = or_null("COALESCE(att.leaves, 0)"),
        shifts = or_null("COALESCE(cashier.shifts, 0)"),
        revenue = or_null("COALESCE(cafe.revenue, 0)"),
    );
    let pattern = if query.trim().is_empty() {
        String::new()
    } else {
        format!("%{}%", escape_like(query.trim()))
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        params![period.from, period.to, pattern, i64::from(include_inactive)],
        |row| {
            Ok(EmployeeRow {
                id: row.get(0)?,
                user_id: row.get(1)?,
                name: row.get(2)?,
                phone: row.get(3)?,
                employee_type: row.get(4)?,
                status: row.get(5)?,
                login_role: row.get(6)?,
                base_salary: row.get(7)?,
                notes: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                attendance_days: row.get(11)?,
                worked_minutes: row.get(12)?,
                absence_days: row.get(13)?,
                leave_days: row.get(14)?,
                today_state: row.get(15)?,
                today_check_in_effective_at: row.get(16)?,
                today_check_out_effective_at: row.get(17)?,
                shifts_count: row.get(18)?,
                cafe_revenue: row.get(19)?,
            })
        },
    )?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// One advance, as the drawer ledger shows it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Advance {
    pub id: i64,
    pub employee_id: i64,
    /// Piasters. Always an integer.
    pub amount: i64,
    pub advance_date: String,
    pub reason: String,
    /// RECORDED or REVERSED. A reversed advance keeps its amount forever; it is
    /// excluded from totals by status, never by deletion.
    pub status: String,
    pub created_by: i64,
    pub created_by_name: String,
    pub created_at: String,
    pub reversed_at: Option<String>,
}

const ADVANCE_SELECT: &str = "SELECT a.id, a.employee_id,
    -- The EXPENSE owns a linked advance's money and date; the ledger columns are
    -- the fallback for a historical advance that has no expense. `COALESCE` is the
    -- single place that decision is expressed, and the database freezes a linked
    -- expense's amount/date (migration 34) so the two can never drift apart.
    COALESCE(e.amount, a.amount),
    COALESCE(e.expense_date, a.advance_date),
    a.reason, a.status, a.created_by, u.name, a.created_at, a.reversed_at
 FROM employee_advances a
 JOIN users u ON u.id = a.created_by
 LEFT JOIN expenses e ON e.id = a.expense_id";

fn advance_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Advance> {
    Ok(Advance {
        id: row.get(0)?,
        employee_id: row.get(1)?,
        amount: row.get(2)?,
        advance_date: row.get(3)?,
        reason: row.get(4)?,
        status: row.get(5)?,
        created_by: row.get(6)?,
        created_by_name: row.get(7)?,
        created_at: row.get(8)?,
        reversed_at: row.get(9)?,
    })
}

/// Advances of one employee inside the window, newest first.
///
/// `None` bounds are unbounded. The date predicate is the same inclusive
/// business-date comparison the aggregate uses, so the ledger a manager reads and
/// the total above the cards can never describe different days.
pub fn advances_of(
    conn: &Db,
    employee_id: i64,
    from: Option<&str>,
    to: Option<&str>,
    limit: i64,
) -> AppResult<Vec<Advance>> {
    let mut stmt = conn.prepare(&format!(
        "{ADVANCE_SELECT} WHERE a.employee_id = ?1
           AND (?2 IS NULL OR COALESCE(e.expense_date, a.advance_date) >= ?2)
           AND (?3 IS NULL OR COALESCE(e.expense_date, a.advance_date) <= ?3)
         ORDER BY COALESCE(e.expense_date, a.advance_date) DESC, a.id DESC LIMIT ?4"
    ))?;
    let rows = stmt.query_map(params![employee_id, from, to, limit], advance_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn find_advance(conn: &Db, id: i64) -> AppResult<Option<Advance>> {
    let mut stmt = conn.prepare(&format!("{ADVANCE_SELECT} WHERE a.id = ?1"))?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => Ok(Some(advance_row(row)?)),
        None => Ok(None),
    }
}

/// Insert one advance. `expense_id` links it to the expense that IS this advance;
/// `None` is a historical/direct advance that has no expense.
pub fn insert_advance(
    conn: &Db,
    employee_id: i64,
    amount: i64,
    advance_date: &str,
    reason: &str,
    created_by: i64,
    expense_id: Option<i64>,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO employee_advances (employee_id, amount, advance_date, reason, created_by, expense_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![employee_id, amount, advance_date, reason, created_by, expense_id],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Reverse an advance. The original row is never deleted and its amount is never
/// altered — only its status and reversal stamp change, which is Station's
/// existing correction model for money.
pub fn reverse_advance(conn: &Db, id: i64, by_user: i64, reverses_id: i64) -> AppResult<usize> {
    conn.execute(
        "UPDATE employee_advances
         SET status = 'REVERSED', reversed_at = station_now(), reversed_by = ?2, reverses_id = ?3
         WHERE id = ?1 AND status = 'RECORDED'",
        params![id, by_user, reverses_id],
    )
    .map_err(Into::into)
}

/// Live (non-reversed) advance total for an inclusive business-date window, in
/// piasters. `None` bounds are unbounded, exactly like the rest of the period
/// filtering in Station.
///
/// The date filter runs against the SAME expression every advance read uses
/// (`COALESCE(e.expense_date, a.advance_date)`), so a linked advance is always
/// scoped by its expense's date and a legacy one by its own. A reversed advance is
/// excluded by status, never by deletion, and the date predicate is part of the
/// same indexed pass — no rows are loaded into Rust to be added up.
pub fn advances_total(
    conn: &Db,
    employee_id: i64,
    from: Option<&str>,
    to: Option<&str>,
) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(COALESCE(e.amount, a.amount)), 0)
         FROM employee_advances a
         LEFT JOIN expenses e ON e.id = a.expense_id
         WHERE a.employee_id = ?1 AND a.status = 'RECORDED'
           AND (?2 IS NULL OR COALESCE(e.expense_date, a.advance_date) >= ?2)
           AND (?3 IS NULL OR COALESCE(e.expense_date, a.advance_date) <= ?3)",
        params![employee_id, from, to],
        |r| r.get(0),
    )?)
}

/// Salary PAYMENTS made to one employee inside the window — the money the café
/// actually PAID that person, as distinct from the advance they took back out of
/// it.
///
/// This is the figure that makes a salary identifiable: it is read from the
/// expense side, through `expenses.employee_id`, so it can only ever name an
/// employee the manager selected when recording it. An advance is deliberately
/// EXCLUDED, by the same join the advances total uses in reverse — `NOT EXISTS`
/// on a claimed `expense_id` — so the two figures can never count one payment
/// twice, and so an advance is never mistaken for salary.
///
/// It is a REPORTING total. It is deliberately not an input to the net-pay
/// formula: what an employee takes home is `base_salary − advances − deductions`,
/// a salary already paid must not be subtracted from it a second time.
pub fn salary_paid_total(
    conn: &Db,
    employee_id: i64,
    from: Option<&str>,
    to: Option<&str>,
) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(e.amount), 0)
         FROM expenses e
         WHERE e.employee_id = ?1
           AND NOT EXISTS (SELECT 1 FROM employee_advances a WHERE a.expense_id = e.id)
           AND (?2 IS NULL OR e.expense_date >= ?2)
           AND (?3 IS NULL OR e.expense_date <= ?3)",
        params![employee_id, from, to],
        |r| r.get(0),
    )?)
}

/// Advance total for EXACTLY one calendar month, the shape the monthly payroll
/// snapshot freezes.
///
/// This is [`advances_total`] with the month's own bounds supplied by the caller,
/// kept as its own name so the payroll build reads as the month operation it is.
pub fn advances_total_for_month(
    conn: &Db,
    employee_id: i64,
    first_day: &str,
    last_day: &str,
) -> AppResult<i64> {
    advances_total(conn, employee_id, Some(first_day), Some(last_day))
}

// ---------------------------------------------------------------------------
// DEDUCTIONS — withheld money, never an expense
// ---------------------------------------------------------------------------

/// One deduction, as the drawer ledger shows it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Deduction {
    pub id: i64,
    pub employee_id: i64,
    /// Piasters. Always an integer.
    pub amount: i64,
    pub deduction_date: String,
    pub reason: Option<String>,
    pub created_by: i64,
    pub created_by_name: String,
    pub created_at: String,
}

const DEDUCTION_SELECT: &str = "SELECT d.id, d.employee_id, d.amount, d.deduction_date,
    d.reason, d.created_by, u.name, d.created_at
 FROM employee_deductions d JOIN users u ON u.id = d.created_by";

fn deduction_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Deduction> {
    Ok(Deduction {
        id: row.get(0)?,
        employee_id: row.get(1)?,
        amount: row.get(2)?,
        deduction_date: row.get(3)?,
        reason: row.get(4)?,
        created_by: row.get(5)?,
        created_by_name: row.get(6)?,
        created_at: row.get(7)?,
    })
}

/// Deductions of one employee inside the window, newest first.
///
/// `None` bounds are unbounded. The range predicate is the same inclusive
/// business-date comparison the advances use, so one period selects both sides of
/// an employee's money in exactly the same way.
pub fn deductions_of(
    conn: &Db,
    employee_id: i64,
    from: Option<&str>,
    to: Option<&str>,
    limit: i64,
) -> AppResult<Vec<Deduction>> {
    let mut stmt = conn.prepare(&format!(
        "{DEDUCTION_SELECT} WHERE d.employee_id = ?1
           AND (?2 IS NULL OR d.deduction_date >= ?2)
           AND (?3 IS NULL OR d.deduction_date <= ?3)
         ORDER BY d.deduction_date DESC, d.id DESC LIMIT ?4"
    ))?;
    let rows = stmt.query_map(params![employee_id, from, to, limit], deduction_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn insert_deduction(
    conn: &Db,
    employee_id: i64,
    amount: i64,
    deduction_date: &str,
    reason: Option<&str>,
    created_by: i64,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO employee_deductions (employee_id, amount, deduction_date, reason, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![employee_id, amount, deduction_date, reason, created_by],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Deduction total for an inclusive business-date window, in piasters.
pub fn deductions_total(
    conn: &Db,
    employee_id: i64,
    from: Option<&str>,
    to: Option<&str>,
) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(amount), 0) FROM employee_deductions
         WHERE employee_id = ?1
           AND (?2 IS NULL OR deduction_date >= ?2)
           AND (?3 IS NULL OR deduction_date <= ?3)",
        params![employee_id, from, to],
        |r| r.get(0),
    )?)
}

/// One payroll run — a frozen monthly snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayrollRun {
    pub id: i64,
    pub employee_id: i64,
    /// `YYYY-MM`.
    pub period: String,
    /// The salary as it was when the run was created. Never re-read from
    /// `employees`, which is what makes a finalized month immutable.
    pub base_salary: i64,
    pub attendance_days: i64,
    pub worked_minutes: i64,
    pub absence_days: i64,
    pub leave_days: i64,
    pub advances: i64,
    /// Manager-entered only. Station has no documented attendance-based
    /// deduction rule, so nothing derives this.
    pub deductions: i64,
    pub net_salary: i64,
    pub status: String,
    pub created_by: i64,
    pub created_at: String,
    pub finalized_by: Option<i64>,
    pub finalized_at: Option<String>,
}

const RUN_COLS: &str = "id, employee_id, period, base_salary, attendance_days, worked_minutes,
    absence_days, leave_days, advances, deductions, net_salary, status,
    created_by, created_at, finalized_by, finalized_at";

fn run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PayrollRun> {
    Ok(PayrollRun {
        id: row.get(0)?,
        employee_id: row.get(1)?,
        period: row.get(2)?,
        base_salary: row.get(3)?,
        attendance_days: row.get(4)?,
        worked_minutes: row.get(5)?,
        absence_days: row.get(6)?,
        leave_days: row.get(7)?,
        advances: row.get(8)?,
        deductions: row.get(9)?,
        net_salary: row.get(10)?,
        status: row.get(11)?,
        created_by: row.get(12)?,
        created_at: row.get(13)?,
        finalized_by: row.get(14)?,
        finalized_at: row.get(15)?,
    })
}

/// Every run of one employee, newest period first.
pub fn runs_of(conn: &Db, employee_id: i64) -> AppResult<Vec<PayrollRun>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLS} FROM payroll_runs WHERE employee_id = ?1 ORDER BY period DESC"
    ))?;
    let rows = stmt.query_map(params![employee_id], run_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn find_run(conn: &Db, id: i64) -> AppResult<Option<PayrollRun>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLS} FROM payroll_runs WHERE id = ?1"
    ))?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => Ok(Some(run_row(row)?)),
        None => Ok(None),
    }
}

pub fn run_for(conn: &Db, employee_id: i64, period: &str) -> AppResult<Option<PayrollRun>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLS} FROM payroll_runs WHERE employee_id = ?1 AND period = ?2"
    ))?;
    let mut rows = stmt.query(params![employee_id, period])?;
    match rows.next()? {
        Some(row) => Ok(Some(run_row(row)?)),
        None => Ok(None),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn insert_run(
    conn: &Db,
    employee_id: i64,
    period: &str,
    base_salary: i64,
    attendance_days: i64,
    worked_minutes: i64,
    absence_days: i64,
    leave_days: i64,
    advances: i64,
    deductions: i64,
    net_salary: i64,
    created_by: i64,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO payroll_runs (employee_id, period, base_salary, attendance_days,
             worked_minutes, absence_days, leave_days, advances, deductions, net_salary, created_by)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            employee_id,
            period,
            base_salary,
            attendance_days,
            worked_minutes,
            absence_days,
            leave_days,
            advances,
            deductions,
            net_salary,
            created_by
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Finalize a DRAFT run. The WHERE clause is the immutability guard: only a
/// DRAFT can be finalized, so a finalized run can never be re-stamped.
pub fn finalize_run(conn: &Db, id: i64, by_user: i64) -> AppResult<usize> {
    conn.execute(
        "UPDATE payroll_runs SET status = 'FINALIZED', finalized_at = station_now(),
            finalized_by = ?2
         WHERE id = ?1 AND status = 'DRAFT'",
        params![id, by_user],
    )
    .map_err(Into::into)
}

/// Attendance totals for one employee inside a month, used to BUILD a run. This
/// is the only place attendance feeds money, and it copies values into the run
/// rather than referencing them.
///
/// `attendance_days` counts PRESENT days only: an absence or a leave is reported
/// in its own counter, so the three figures never overlap and their sum is the
/// number of recorded days in the month.
pub fn month_attendance(
    conn: &Db,
    employee_id: i64,
    from: &str,
    to: &str,
) -> AppResult<(i64, i64, i64, i64)> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(CASE WHEN state = 'PRESENT' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN state = 'ABSENT' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN state = 'LEAVE'  THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CAST(ROUND(
                    (julianday(check_out_effective_at)
                   - julianday(check_in_effective_at)) * 1440) AS INTEGER)), 0)
         FROM attendance_days
         WHERE employee_id = ?1 AND voided_at IS NULL
           AND business_date >= ?2 AND business_date <= ?3",
        params![employee_id, from, to],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?)
}
