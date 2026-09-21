//! Inventory & expense repositories (foundation for Phase 3 analytics).

use crate::error::AppResult;
use crate::repositories::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StockRow {
    pub product_id: i64,
    pub product_name: String,
    pub department: String,
    pub quantity: i64,
    pub min_quantity: i64,
}

pub fn list_stock(conn: &Db) -> AppResult<Vec<StockRow>> {
    let mut stmt = conn.prepare(
        "SELECT i.product_id, p.name, p.department, i.quantity, i.min_quantity
         FROM inventory_items i JOIN products p ON p.id = i.product_id
         ORDER BY (i.quantity <= i.min_quantity) DESC, p.name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(StockRow {
            product_id: r.get(0)?,
            product_name: r.get(1)?,
            department: r.get(2)?,
            quantity: r.get(3)?,
            min_quantity: r.get(4)?,
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
         ON CONFLICT(product_id) DO UPDATE SET quantity = quantity + ?2, updated_at = datetime('now')",
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
         ON CONFLICT(product_id) DO UPDATE SET min_quantity = ?2, updated_at = datetime('now')",
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Expense {
    pub id: i64,
    pub category: String,
    pub amount: i64,
    pub description: Option<String>,
    pub expense_date: String,
    pub is_recurring: bool,
    pub recurrence: Option<String>,
    pub user_name: Option<String>,
    pub created_at: String,
}

#[allow(clippy::too_many_arguments)]
pub fn insert_expense(
    conn: &Db,
    category: &str,
    amount: i64,
    description: Option<&str>,
    expense_date: &str,
    is_recurring: bool,
    recurrence: Option<&str>,
    business_day_id: Option<i64>,
    user_id: i64,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO expenses (category, amount, description, expense_date, is_recurring,
            recurrence, business_day_id, user_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            category, amount, description, expense_date, is_recurring as i64, recurrence,
            business_day_id, user_id
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_expenses(
    conn: &Db,
    from: Option<&str>,
    to: Option<&str>,
    recurring_only: bool,
) -> AppResult<Vec<Expense>> {
    let mut sql = String::from(
        "SELECT e.id, e.category, e.amount, e.description, e.expense_date, e.is_recurring,
                e.recurrence, u.name, e.created_at
         FROM expenses e LEFT JOIN users u ON u.id = e.user_id WHERE 1=1",
    );
    let mut args: Vec<String> = Vec::new();
    if let Some(f) = from {
        args.push(f.to_string());
        sql.push_str(&format!(" AND e.expense_date >= ?{}", args.len()));
    }
    if let Some(t) = to {
        args.push(t.to_string());
        sql.push_str(&format!(" AND e.expense_date <= ?{}", args.len()));
    }
    if recurring_only {
        sql.push_str(" AND e.is_recurring = 1");
    }
    sql.push_str(" ORDER BY e.expense_date DESC, e.id DESC LIMIT 500");
    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(refs.as_slice(), |r| {
        Ok(Expense {
            id: r.get(0)?,
            category: r.get(1)?,
            amount: r.get(2)?,
            description: r.get(3)?,
            expense_date: r.get(4)?,
            is_recurring: r.get::<_, i64>(5)? != 0,
            recurrence: r.get(6)?,
            user_name: r.get(7)?,
            created_at: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn total_expenses(conn: &Db, from: &str, to: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(amount),0) FROM expenses WHERE expense_date BETWEEN ?1 AND ?2",
        params![from, to],
        |r| r.get(0),
    )?)
}