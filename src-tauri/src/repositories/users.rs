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

pub fn list(conn: &Db) -> AppResult<Vec<User>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {USER_COLS} FROM users ORDER BY role, name"
    ))?;
    let rows = stmt.query_map([], row_to_user)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

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

/// The cashier's OWN discount-authorization credential (Argon2id PHC string).
///
/// This is deliberately NOT part of `User`/`UserWithMeta` listing shapes: the
/// management UI only ever learns WHETHER a credential exists, never its value.
pub fn find_discount_password(conn: &Db, id: i64) -> AppResult<Option<String>> {
    match conn.query_row(
        "SELECT discount_password_hash FROM users WHERE id = ?1",
        params![id],
        |r| r.get::<_, Option<String>>(0),
    ) {
        Ok(hash) => Ok(hash),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn set_discount_password(conn: &Db, id: i64, hash: &str) -> AppResult<usize> {
    conn.execute(
        "UPDATE users SET discount_password_hash = ?2, updated_at = station_now() WHERE id = ?1",
        params![id, hash],
    )
    .map_err(Into::into)
}

/// Per-account discount-authorization FLAGS for the management screen: a
/// boolean per user id, never the credential.
pub fn discount_authorization_states(conn: &Db) -> AppResult<Vec<(i64, bool)>> {
    let mut stmt =
        conn.prepare("SELECT id, discount_password_hash IS NOT NULL FROM users ORDER BY name")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
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
