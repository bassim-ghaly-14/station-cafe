//! Inventory repositories (stock levels and movements).

use crate::error::AppResult;
use crate::repositories::Db;
use rusqlite::{params, OptionalExtension};
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
    sync_notification_for_product(conn, product_id)?;
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
    sync_notification_for_product(conn, product_id)?;
    Ok(())
}

/// The single source of truth for the three stock states.
///
/// BELOW_MINIMUM (`quantity < min_quantity`) is the real warning, AT_MINIMUM
/// (`==`) is its own informational state, ABOVE_MINIMUM (`>`) is healthy.
/// Untracked / archived / missing rows have no state (`None`) and resolve any
/// active alert.
pub fn stock_state(conn: &Db, product_id: i64) -> AppResult<Option<String>> {
    let row: Option<(i64, i64)> = conn
        .query_row(
            "SELECT i.quantity, i.min_quantity FROM inventory_items i
             JOIN products p ON p.id = i.product_id
             WHERE i.product_id = ?1 AND p.track_inventory = 1 AND p.deleted_at IS NULL",
            params![product_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(crate::error::AppError::from)?;
    Ok(row.map(|(q, m)| {
        if q < m {
            "BELOW_MINIMUM".to_string()
        } else if q == m {
            "AT_MINIMUM".to_string()
        } else {
            "ABOVE_MINIMUM".to_string()
        }
    }))
}

/// Idempotent per-product notification sync. Called ONLY from inventory write
/// paths (adjust / set-minimum / catalog quantity-min edits / checkout sale
/// application) — never from reads, renders, or refetches — so rerenders and
/// restarts create nothing.
///
/// Lifecycle: BELOW_MINIMUM / AT_MINIMUM → one ACTIVE row (created once,
/// morphed in place on severity change); ABOVE_MINIMUM / untracked / missing
/// → ACTIVE row RESOLVED; a later fall re-arms with a fresh ACTIVE row.
/// `read_at` is never touched here: opening a page does not mark anything.
pub fn sync_notification_for_product(conn: &Db, product_id: i64) -> AppResult<()> {
    let row: Option<(i64, i64)> = conn
        .query_row(
            "SELECT i.quantity, i.min_quantity FROM inventory_items i
             JOIN products p ON p.id = i.product_id
             WHERE i.product_id = ?1 AND p.track_inventory = 1 AND p.deleted_at IS NULL",
            params![product_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(crate::error::AppError::from)?;
    let resolve = || -> AppResult<()> {
        conn.execute(
            "UPDATE inventory_notifications SET status = 'RESOLVED', resolved_at = station_now()
             WHERE product_id = ?1 AND status = 'ACTIVE'",
            params![product_id],
        )?;
        Ok(())
    };
    let Some((quantity, min_quantity)) = row else {
        resolve()?;
        return Ok(());
    };
    let kind = if quantity < min_quantity {
        "BELOW_MINIMUM"
    } else if quantity == min_quantity {
        "AT_MINIMUM"
    } else {
        resolve()?;
        return Ok(());
    };
    let active: Option<i64> = conn
        .query_row(
            "SELECT id FROM inventory_notifications
             WHERE product_id = ?1 AND status = 'ACTIVE'",
            params![product_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(crate::error::AppError::from)?;
    match active {
        Some(id) => {
            conn.execute(
                "UPDATE inventory_notifications
                 SET kind = ?2, quantity = ?3, min_quantity = ?4
                 WHERE id = ?1",
                params![id, kind, quantity, min_quantity],
            )?;
        }
        None => {
            conn.execute(
                "INSERT INTO inventory_notifications
                     (product_id, kind, quantity, min_quantity, status)
                 VALUES (?1, ?2, ?3, ?4, 'ACTIVE')",
                params![product_id, kind, quantity, min_quantity],
            )?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InventoryNotification {
    pub id: i64,
    pub product_id: i64,
    pub product_name: String,
    pub kind: String,
    pub quantity: i64,
    pub min_quantity: i64,
    pub status: String,
    pub created_at: String,
    pub resolved_at: Option<String>,
    pub read_at: Option<String>,
}

/// Active manager queue, newest first. Resolved rows stay as history.
pub fn list_notifications(conn: &Db) -> AppResult<Vec<InventoryNotification>> {
    let mut stmt = conn.prepare(
        "SELECT n.id, n.product_id, p.name, n.kind, n.quantity, n.min_quantity,
                n.status, n.created_at, n.resolved_at, n.read_at
         FROM inventory_notifications n JOIN products p ON p.id = n.product_id
         WHERE n.status = 'ACTIVE'
         ORDER BY n.created_at DESC, n.id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(InventoryNotification {
            id: r.get(0)?,
            product_id: r.get(1)?,
            product_name: r.get(2)?,
            kind: r.get(3)?,
            quantity: r.get(4)?,
            min_quantity: r.get(5)?,
            status: r.get(6)?,
            created_at: r.get(7)?,
            resolved_at: r.get(8)?,
            read_at: r.get(9)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn unread_notification_count(conn: &Db) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM inventory_notifications
         WHERE status = 'ACTIVE' AND read_at IS NULL",
        [],
        |r| r.get(0),
    )?)
}

pub fn mark_notification_read(conn: &Db, id: i64) -> AppResult<bool> {
    Ok(conn.execute(
        "UPDATE inventory_notifications SET read_at = station_now()
         WHERE id = ?1 AND status = 'ACTIVE' AND read_at IS NULL",
        params![id],
    )? > 0)
}

pub fn mark_all_notifications_read(conn: &Db) -> AppResult<i64> {
    conn.execute(
        "UPDATE inventory_notifications SET read_at = station_now()
         WHERE status = 'ACTIVE' AND read_at IS NULL",
        [],
    )?;
    Ok(conn.changes() as i64)
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
