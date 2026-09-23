//! Product catalog repository.

use crate::error::AppResult;
use crate::repositories::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Product {
    pub id: i64,
    pub name: String,
    pub item_type: String,  // PRODUCT | SERVICE
    pub department: String, // CAFE | WASH
    pub price_minor: i64,
    pub is_active: bool,
    pub track_inventory: bool,
    pub is_seed: bool,
}

const COLS: &str =
    "id, name, item_type, department, price_minor, is_active, track_inventory, is_seed";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Product> {
    Ok(Product {
        id: row.get(0)?,
        name: row.get(1)?,
        item_type: row.get(2)?,
        department: row.get(3)?,
        price_minor: row.get(4)?,
        is_active: row.get::<_, i64>(5)? != 0,
        track_inventory: row.get::<_, i64>(6)? != 0,
        is_seed: row.get::<_, i64>(7)? != 0,
    })
}

/// Staff-facing list: active items only. Manager list: everything.
pub fn list(conn: &Db, department: Option<&str>, active_only: bool) -> AppResult<Vec<Product>> {
    let mut sql = format!("SELECT {COLS} FROM products WHERE 1=1");
    if active_only {
        sql.push_str(" AND is_active = 1");
    }
    if department.is_some() {
        sql.push_str(" AND department = ?1");
    }
    sql.push_str(" ORDER BY department, name");
    let mut stmt = conn.prepare(&sql)?;
    // The department placeholder only exists when a filter was appended;
    // binding unconditionally would fail with "Got 1, needed 0".
    let rows = match department {
        Some(d) => stmt.query_map(params![d], row)?,
        None => stmt.query_map([], row)?,
    };
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get(conn: &Db, id: i64) -> AppResult<Option<Product>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM products WHERE id = ?1"))?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(r) => Ok(Some(row(r)?)),
        None => Ok(None),
    }
}

pub struct NewProduct<'a> {
    pub name: &'a str,
    pub item_type: &'a str,
    pub department: &'a str,
    pub price_minor: i64,
    pub track_inventory: bool,
}

pub fn insert(conn: &Db, p: &NewProduct<'_>) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO products (name, item_type, department, price_minor, track_inventory)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            p.name,
            p.item_type,
            p.department,
            p.price_minor,
            p.track_inventory as i64
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Returns the previous row state (name/price/active) for audit purposes.
pub fn update_price(conn: &Db, id: i64, price_minor: i64) -> AppResult<i64> {
    let old: i64 = conn.query_row(
        "SELECT price_minor FROM products WHERE id = ?1",
        [id],
        |r| r.get(0),
    )?;
    conn.execute(
        "UPDATE products SET price_minor = ?2, updated_at = datetime('now') WHERE id = ?1",
        params![id, price_minor],
    )?;
    Ok(old)
}

pub fn set_active(conn: &Db, id: i64, active: bool) -> AppResult<()> {
    conn.execute(
        "UPDATE products SET is_active = ?2, updated_at = datetime('now') WHERE id = ?1",
        params![id, active as i64],
    )?;
    Ok(())
}

pub fn rename(conn: &Db, id: i64, name: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE products SET name = ?2, updated_at = datetime('now') WHERE id = ?1",
        params![id, name],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate;
    use crate::seed::run_if_empty;
    use rusqlite::Connection;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();
        conn
    }

    /// Regression: the department filter is appended conditionally, so an
    /// unfiltered list must bind ZERO parameters (was "Got 1, needed 0").
    #[test]
    fn list_without_department_filter_binds_no_params() {
        let conn = fresh();
        let all = list(&conn, None, false).unwrap();
        assert!(!all.is_empty());
        let active = list(&conn, None, true).unwrap();
        assert!(active.iter().all(|p| p.is_active));
        let cafe = list(&conn, Some("CAFE"), false).unwrap();
        assert!(!cafe.is_empty() && cafe.iter().all(|p| p.department == "CAFE"));
    }
}
