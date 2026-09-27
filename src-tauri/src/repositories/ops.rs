//! Inventory repositories (stock levels and movements).

use crate::error::AppResult;
use crate::repositories::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StockRow {
    pub product_id: i64,
    pub product_name: String,
    pub department: String,
    pub category_name: String,
    pub item_type: String,
    pub quantity: i64,
    pub min_quantity: i64,
}

pub fn list_stock(conn: &Db) -> AppResult<Vec<StockRow>> {
    let mut stmt = conn.prepare(
        "SELECT i.product_id, p.name, p.department, c.name, p.item_type, i.quantity, i.min_quantity
         FROM inventory_items i JOIN products p ON p.id = i.product_id
         JOIN categories c ON c.id = p.category_id
         WHERE p.track_inventory = 1
           AND p.deleted_at IS NULL
         ORDER BY (i.quantity <= i.min_quantity) DESC, p.name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(StockRow {
            product_id: r.get(0)?,
            product_name: r.get(1)?,
            department: r.get(2)?,
            category_name: r.get(3)?,
            item_type: r.get(4)?,
            quantity: r.get(5)?,
            min_quantity: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Upsert a stock row and record the movement (caller's transaction).
pub fn adjust(
    conn: &Db,
    product_id: i64,
    change: i64,
    reason: &str,
    note: Option<&str>,
    ref_invoice_id: Option<i64>,
    user_id: i64,
) -> AppResult<()> {
    if change == 0 {
        return Err(crate::error::AppError::validation("inventory.zero_change"));
    }
    conn.execute(
        "INSERT INTO inventory_items (product_id, quantity) VALUES (?1, ?2)
         ON CONFLICT(product_id) DO UPDATE SET quantity = quantity + ?2, updated_at = station_now()",
        params![product_id, change],
    )?;
    conn.execute(
        "INSERT INTO stock_movements (product_id, change, reason, note, ref_invoice_id, user_id)
         VALUES (?1,?2,?3,?4,?5,?6)",
        params![product_id, change, reason, note, ref_invoice_id, user_id],
    )?;
    Ok(())
}

pub fn set_min_quantity(conn: &Db, product_id: i64, min_quantity: i64) -> AppResult<()> {
    if min_quantity < 0 {
        return Err(crate::error::AppError::validation("inventory.invalid_min"));
    }
    conn.execute(
        "INSERT INTO inventory_items (product_id, min_quantity) VALUES (?1, ?2)
         ON CONFLICT(product_id) DO UPDATE SET min_quantity = ?2, updated_at = station_now()",
        params![product_id, min_quantity],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MovementRow {
    pub id: i64,
    pub product_name: String,
    pub change: i64,
    pub reason: String,
    pub note: Option<String>,
    pub created_at: String,
}

pub fn list_movements(conn: &Db, limit: i64) -> AppResult<Vec<MovementRow>> {
    let mut stmt = conn.prepare(
        "SELECT m.id, p.name, m.change, m.reason, m.note, m.created_at
         FROM stock_movements m JOIN products p ON p.id = m.product_id
         ORDER BY m.id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |r| {
        Ok(MovementRow {
            id: r.get(0)?,
            product_name: r.get(1)?,
            change: r.get(2)?,
            reason: r.get(3)?,
            note: r.get(4)?,
            created_at: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Tracked products sold in an invoice — used to decrement stock on checkout.
pub fn tracked_lines_of_invoice(conn: &Db, invoice_id: i64) -> AppResult<Vec<(i64, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, l.quantity FROM invoice_lines l
         JOIN invoices i ON i.id = l.invoice_id
         JOIN products p ON p.name = l.product_name AND p.track_inventory = 1
         WHERE l.invoice_id = ?1",
    )?;
    let rows = stmt.query_map([invoice_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

// ---- EXPENSES --------------------------------------------------------------
//
// Expense persistence moved to `repositories::expenses`: expenses are now tied
// to a shift and its cash drawer, and they carry a dynamic category rather than
// a hardcoded enum. Nothing is re-implemented here, so there is exactly one
// expense read path in the application.
