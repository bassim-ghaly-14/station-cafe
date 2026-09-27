//! User repository — the only SQL for staff accounts.

use crate::error::AppResult;
use crate::repositories::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: i64,
    pub name: String,
    pub phone: Option<String>,
    pub role: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserWithMeta {
    #[serde(flatten)]
    pub user: User,
    pub password_hash: String,
    pub is_seed: bool,
}

const USER_COLS: &str = "id, name, phone, role, status, created_at, updated_at";

fn row_to_user(row: &rusqlite::Row<'_>) -> rusqlite::Result<User> {
    Ok(User {
        id: row.get(0)?,
        name: row.get(1)?,
        phone: row.get(2)?,
        role: row.get(3)?,
        status: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

pub fn find_by_name(conn: &Db, name: &str) -> AppResult<Option<UserWithMeta>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, phone, role, status, created_at, updated_at, password_hash, is_seed
         FROM users WHERE name = ?1",
    )?;
    let mut rows = stmt.query(params![name])?;
    match rows.next()? {
        Some(row) => Ok(Some(UserWithMeta {
            user: row_to_user(row)?,
            password_hash: row.get(7)?,
            is_seed: row.get::<_, i64>(8)? != 0,
        })),
        None => Ok(None),
    }
}

pub fn find_by_id(conn: &Db, id: i64) -> AppResult<Option<User>> {
    let mut stmt = conn.prepare(&format!("SELECT {USER_COLS} FROM users WHERE id = ?1"))?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => Ok(Some(row_to_user(row)?)),
        None => Ok(None),
    }
}

// NOTE: there is deliberately no `list()` here. The old staff screen had a
// "list every login" read, which produced a SECOND roster of the same people
// that disagreed with the employees one. The canonical roster now comes from
// `repositories::employees::list`, which carries each person's role, status and
// phone alongside their HR record, so one query serves the whole page.

pub struct NewUser<'a> {
    pub name: &'a str,
    pub phone: Option<&'a str>,
    pub role: &'a str,
    pub password_hash: &'a str,
    pub is_seed: bool,
}

/// Returns Ok(Some(id)) or Ok(None) when the name is already taken.
pub fn insert(conn: &Db, u: &NewUser<'_>) -> AppResult<Option<i64>> {
    let n = conn.execute(
        "INSERT INTO users (name, phone, role, password_hash, is_seed)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(name) DO NOTHING",
        params![u.name, u.phone, u.role, u.password_hash, u.is_seed as i64],
    )?;
    if n == 0 {
        return Ok(None);
    }
    Ok(Some(conn.last_insert_rowid()))
}

pub fn set_status(conn: &Db, id: i64, status: &str) -> AppResult<usize> {
    conn.execute(
        "UPDATE users SET status = ?2, updated_at = station_now() WHERE id = ?1",
        params![id, status],
    )
    .map_err(Into::into)
}

pub fn set_password(conn: &Db, id: i64, hash: &str) -> AppResult<usize> {
    conn.execute(
        "UPDATE users SET password_hash = ?2, updated_at = station_now() WHERE id = ?1",
        params![id, hash],
    )
    .map_err(Into::into)
}

pub fn set_role(conn: &Db, id: i64, role: &str) -> AppResult<usize> {
    conn.execute(
        "UPDATE users SET role = ?2, updated_at = station_now() WHERE id = ?1",
        params![id, role],
    )
    .map_err(Into::into)
}

pub fn update(conn: &Db, id: i64, name: &str, phone: Option<&str>) -> AppResult<usize> {
    conn.execute(
        "UPDATE users SET name = ?2, phone = ?3, updated_at = station_now() WHERE id = ?1",
        params![id, name, phone],
    )
    .map_err(Into::into)
}

pub fn count(conn: &Db) -> AppResult<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?)
}

/// Total number of rows anywhere in the database that reference this login.
///
/// A `users` row is the most-referenced record in Station: an invoice, a
/// payment, an expense, a shift, an attendance correction and a finalized
/// payroll run all name the person who did it. That makes a login a HISTORICAL
/// record, not an owned child, so it is deleted only when this count is zero.
pub fn reference_count(conn: &Db, id: i64) -> AppResult<i64> {
    // One row of sub-selects, summed, so the count is a single consistent read
    // and a new referencing table can only ever be added in ONE place.
    conn.query_row(
        "SELECT
            (SELECT COUNT(*) FROM sessions           WHERE user_id = ?1)
          + (SELECT COUNT(*) FROM orders             WHERE user_id = ?1)
          + (SELECT COUNT(*) FROM invoices           WHERE user_id = ?1)
          + (SELECT COUNT(*) FROM payments           WHERE user_id = ?1)
          + (SELECT COUNT(*) FROM expenses           WHERE user_id = ?1)
          + (SELECT COUNT(*) FROM credit_payments    WHERE user_id = ?1)
          + (SELECT COUNT(*) FROM shifts             WHERE user_id = ?1)
          + (SELECT COUNT(*) FROM business_days      WHERE opened_by = ?1)
          + (SELECT COUNT(*) FROM business_days      WHERE closed_by = ?1)
          + (SELECT COUNT(*) FROM day_closings       WHERE closed_by = ?1)
          + (SELECT COUNT(*) FROM attendance_days    WHERE recorded_by_user_id = ?1)
          + (SELECT COUNT(*) FROM attendance_days    WHERE voided_by_user_id = ?1)
          + (SELECT COUNT(*) FROM employee_advances  WHERE created_by = ?1)
          + (SELECT COUNT(*) FROM employee_advances  WHERE reversed_by = ?1)
          + (SELECT COUNT(*) FROM payroll_runs       WHERE created_by = ?1)
          + (SELECT COUNT(*) FROM payroll_runs       WHERE finalized_by = ?1)
          + (SELECT COUNT(*) FROM employees          WHERE user_id = ?1)",
        params![id],
        |r| r.get(0),
    )
    .map_err(Into::into)
}

/// Physically remove a login. Only reached when [`reference_count`] is zero, so
/// it can never orphan a transaction. The caller owns the transaction.
pub fn delete(conn: &Db, id: i64) -> AppResult<usize> {
    conn.execute("DELETE FROM users WHERE id = ?1", params![id])
        .map_err(Into::into)
}
