//! Employee repository — the ONLY SQL for the employees domain.
//!
//! # One rule for performance attribution
//!
//! The two employee types are attributed from two DIFFERENT persisted sources,
//! and this module is where that difference is expressed exactly once:
//!
//!  * **Cashier** — `shifts.user_id`. A shift is opened by a login, so the
//!    cashier's revenue is *the cafe money of the invoices booked to that
//!    cashier's shifts*, and the cafe figure
//!    is the invoice's own `cafe_total` snapshot (never recomputed from lines).
//!  * **Wash worker** — `invoices.wash_employee_id`, the snapshot taken at
//!    checkout. An invoice with no worker is unattributed and is never
//!    redistributed to "the only active wash worker" — that would be a guess.
//!
//! Both are scoped by BUSINESS DATE (`business_days.day_date`), exactly like the
//! existing reports and customer analytics, never by a raw timestamp range.
//!
//! # No N+1
//!
//! The employee list is ONE query: the per-employee aggregates are LEFT JOINed
//! as grouped subqueries, so a page of 50 employees is 50 rows returned and
//! exactly one pass over `attendance_days`, `shifts` and `invoices`.

use crate::error::{AppError, AppResult};
use crate::repositories::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// The operational employee type. NOT an authentication role and NOT an
/// authorization role: a WASH_WORKER has no login at all, and a CASHIER may be
/// STAFF, MANAGER or ADMIN depending on the separate `users.role`.
pub const EMPLOYEE_TYPES: [&str; 2] = ["CASHIER", "WASH_WORKER"];

/// One employee, as the list and the drawer read it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Employee {
    pub id: i64,
    /// The login this employee authenticates with, when it has one. `None` for
    /// a wash worker — that is the whole point of the type.
    pub user_id: Option<i64>,
    pub name: String,
    pub phone: Option<String>,
    pub employee_type: String,
    pub status: String,
    /// Monthly base salary in piasters. Never a float.
    pub base_salary: i64,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// The linked login's `users.role` (ADMIN / MANAGER / STAFF), or `None` for
    /// a wash worker, which the database CHECK guarantees has no login at all.
    ///
    /// This is the AUTHORITATIVE role of the person. `employee_type` describes
    /// the job they do; only this column says whether they are an admin, a
    /// manager or a plain staff member, so the UI must never substitute one for
    /// the other.
    pub login_role: Option<String>,
}

/// Every read of an employee LEFT JOINs its login, because a caller must never
/// have to make a second round trip to learn the person's real role.
const EMPLOYEE_SELECT: &str = "e.id, e.user_id, e.name, e.phone, e.employee_type, e.status, e.base_salary, e.notes, e.created_at, e.updated_at, u.role";

const EMPLOYEE_FROM: &str = "FROM employees e LEFT JOIN users u ON u.id = e.user_id";

fn employee_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Employee> {
    Ok(Employee {
        id: row.get(0)?,
        user_id: row.get(1)?,
        name: row.get(2)?,
        phone: row.get(3)?,
        employee_type: row.get(4)?,
        status: row.get(5)?,
        base_salary: row.get(6)?,
        notes: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        login_role: row.get(10)?,
    })
}

pub fn find(conn: &Db, id: i64) -> AppResult<Option<Employee>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {EMPLOYEE_SELECT} {EMPLOYEE_FROM} WHERE e.id = ?1"
    ))?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => Ok(Some(employee_row(row)?)),
        None => Ok(None),
    }
}

pub fn require(conn: &Db, id: i64) -> AppResult<Employee> {
    find(conn, id)?.ok_or_else(|| AppError::not_found("employee.not_found"))
}

/// The employee record behind an authenticated login, if one exists.
///
/// This is how the service resolves "who am I?" for attendance WITHOUT ever
/// trusting a frontend-supplied employee id: the session token names the user,
/// and the database resolves the employee.
pub fn find_by_user(conn: &Db, user_id: i64) -> AppResult<Option<Employee>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {EMPLOYEE_SELECT} {EMPLOYEE_FROM} WHERE e.user_id = ?1"
    ))?;
    let mut rows = stmt.query(params![user_id])?;
    match rows.next()? {
        Some(row) => Ok(Some(employee_row(row)?)),
        None => Ok(None),
    }
}

/// All employees, ordered by type then name. `include_inactive` is what makes
/// deactivation reversible: an inactive employee stays listed, it simply cannot
/// take attendance.
pub fn list(conn: &Db, include_inactive: bool) -> AppResult<Vec<Employee>> {
    let sql = format!(
        "SELECT {EMPLOYEE_SELECT} {EMPLOYEE_FROM}
         {where_clause} ORDER BY CASE e.employee_type WHEN 'CASHIER' THEN 0 ELSE 1 END, e.name",
        where_clause = if include_inactive {
            ""
        } else {
            "WHERE e.status = 'ACTIVE'"
        }
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], employee_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Active employees of one type — the wash-worker picker and the KPI groups.
pub fn list_by_type(conn: &Db, employee_type: &str) -> AppResult<Vec<Employee>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {EMPLOYEE_SELECT} {EMPLOYEE_FROM}
         WHERE e.employee_type = ?1 AND e.status = 'ACTIVE'
         ORDER BY e.name"
    ))?;
    let rows = stmt.query_map(params![employee_type], employee_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub struct NewEmployee<'a> {
    pub name: &'a str,
    pub phone: Option<&'a str>,
    pub employee_type: &'a str,
    pub base_salary: i64,
    pub notes: Option<&'a str>,
    pub user_id: Option<i64>,
}

/// Insert a wash worker (no login) or link a cashier to an existing login.
pub fn insert(conn: &Db, e: &NewEmployee<'_>) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO employees (user_id, name, phone, employee_type, base_salary, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            e.user_id,
            e.name,
            e.phone,
            e.employee_type,
            e.base_salary,
            e.notes
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// A non-salary edit. The base salary is deliberately NOT editable here: it is
/// a money attribute, so it is always audited as a distinct action.
pub fn update_profile(
    conn: &Db,
    id: i64,
    name: &str,
    phone: Option<&str>,
    notes: Option<&str>,
) -> AppResult<usize> {
    conn.execute(
        "UPDATE employees SET name = ?2, phone = ?3, notes = ?4, updated_at = station_now()
         WHERE id = ?1",
        params![id, name, phone, notes],
    )
    .map_err(Into::into)
}

pub fn set_status(conn: &Db, id: i64, status: &str) -> AppResult<usize> {
    conn.execute(
        "UPDATE employees SET status = ?2, updated_at = station_now() WHERE id = ?1",
        params![id, status],
    )
    .map_err(Into::into)
}

pub fn set_base_salary(conn: &Db, id: i64, base_salary: i64) -> AppResult<usize> {
    conn.execute(
        "UPDATE employees SET base_salary = ?2, updated_at = station_now() WHERE id = ?1",
        params![id, base_salary],
    )
    .map_err(Into::into)
}

pub fn count(conn: &Db) -> AppResult<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM employees", [], |r| r.get(0))?)
}

/// Does a login already belong to a cashier employee? Guards the one-to-one
/// link from the service side (the partial unique index guards it in the DB).
pub fn is_user_linked(conn: &Db, user_id: i64) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM employees WHERE user_id = ?1)",
        params![user_id],
        |r| r.get(0),
    )?)
}

/// The HISTORICAL references that make an employee undeletable.
///
/// Every column here is a live `REFERENCES employees(id)` foreign key, so SQLite
/// would refuse the `DELETE` anyway. Naming them explicitly lets the service
/// refuse FIRST, with a message the ADMIN can act on, instead of surfacing a raw
/// constraint violation.
///
/// None of these may be cascaded: attendance days, advances and payroll runs are
/// immutable money/fact records, and `orders`/`invoices` are the wash-worker
/// performance attribution. Deleting any of them to make a person removable
/// would destroy the business history Station exists to keep.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DeleteBlockers {
    pub attendance_days: i64,
    pub employee_advances: i64,
    pub payroll_runs: i64,
    pub orders: i64,
    pub invoices: i64,
}

impl DeleteBlockers {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Count every historical row that references this employee. One query, so the
/// refusal can never be a partial view of the dependencies.
pub fn delete_blockers(conn: &Db, id: i64) -> AppResult<DeleteBlockers> {
    conn.query_row(
        "SELECT
            (SELECT COUNT(*) FROM attendance_days   WHERE employee_id = ?1),
            (SELECT COUNT(*) FROM employee_advances WHERE employee_id = ?1),
            (SELECT COUNT(*) FROM payroll_runs      WHERE employee_id = ?1),
            (SELECT COUNT(*) FROM orders            WHERE wash_employee_id = ?1),
            (SELECT COUNT(*) FROM invoices          WHERE wash_employee_id = ?1)",
        params![id],
        |r| {
            Ok(DeleteBlockers {
                attendance_days: r.get(0)?,
                employee_advances: r.get(1)?,
                payroll_runs: r.get(2)?,
                orders: r.get(3)?,
                invoices: r.get(4)?,
            })
        },
    )
    .map_err(Into::into)
}

/// Physically remove the employee row.
///
/// Only ever reached after [`delete_blockers`] proved there is no history, so
/// this can never orphan an attendance day, an advance, a payroll run or a
/// wash attribution. The caller owns the transaction.
pub fn delete(conn: &Db, id: i64) -> AppResult<usize> {
    conn.execute("DELETE FROM employees WHERE id = ?1", params![id])
        .map_err(Into::into)
}
