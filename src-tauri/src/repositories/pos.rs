//! Tables & orders repository — the operational core of the POS.

use crate::error::AppResult;
use crate::repositories::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableView {
    pub id: i64,
    pub label: String,
    pub status: String, // EMPTY | OPEN | READY_TO_PAY
    pub order_id: Option<i64>,
    pub items_count: i64,
    pub total_minor: i64,
    pub opened_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderLine {
    pub id: i64,
    pub order_id: i64,
    pub product_id: i64,
    pub department: String,
    pub product_name: String,
    pub unit_price: i64,
    pub quantity: i64,
    pub discount_minor: i64,
    pub line_total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub id: i64,
    pub table_id: i64,
    pub user_id: i64,
    pub status: String,
    pub customer_id: Option<i64>,
    pub opened_at: String,
    pub waiting_no: Option<i64>,
    pub shift_id: Option<i64>,
    pub lines: Vec<OrderLine>,
}

/// All tables with their live status/total in a single query (fast grid).
pub fn list_tables(conn: &Db) -> AppResult<Vec<TableView>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.label,
                COALESCE(o.status, 'EMPTY'),
                o.id, COUNT(l.id), COALESCE(SUM(l.line_total), 0), o.opened_at
         FROM cafe_tables t
         LEFT JOIN orders o ON o.table_id = t.id AND o.status IN ('OPEN','READY_TO_PAY')
         LEFT JOIN order_lines l ON l.order_id = o.id
         WHERE t.is_active = 1
         GROUP BY t.id, o.id
         ORDER BY t.label",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TableView {
            id: r.get(0)?,
            label: r.get(1)?,
            status: r.get(2)?,
            order_id: r.get(3)?,
            items_count: r.get(4)?,
            total_minor: r.get(5)?,
            opened_at: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get_table(conn: &Db, id: i64) -> AppResult<Option<(i64, String)>> {
    let mut stmt = conn.prepare("SELECT id, label FROM cafe_tables WHERE id = ?1")?;
    let mut rows = stmt.query([id])?;
    match rows.next()? {
        Some(r) => Ok(Some((r.get(0)?, r.get(1)?))),
        None => Ok(None),
    }
}

pub fn open_order(
    conn: &Db,
    table_id: i64,
    user_id: i64,
    business_day_id: i64,
    shift_id: i64,
) -> AppResult<Option<i64>> {
    let n = conn.execute(
        "INSERT INTO orders (table_id, user_id, business_day_id, shift_id)
         VALUES (?1, ?2, ?3, ?4)",
        params![table_id, user_id, business_day_id, shift_id],
    )?;
    if n == 0 {
        return Ok(None);
    }
    Ok(Some(conn.last_insert_rowid()))
}

pub fn get_order(conn: &Db, order_id: i64) -> AppResult<Option<Order>> {
    let head = conn
        .query_row(
            "SELECT id, table_id, user_id, status, customer_id, opened_at, waiting_no, shift_id
             FROM orders WHERE id = ?1",
            [order_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                ))
            },
        )
        .ok();
    let (id, table_id, user_id, status, customer_id, opened_at, waiting_no, shift_id) = match head {
        Some(v) => v,
        None => return Ok(None),
    };
    let lines = lines_of(conn, order_id)?;
    Ok(Some(Order {
        id,
        table_id,
        user_id,
        status,
        customer_id,
        opened_at,
        waiting_no,
        shift_id,
        lines,
    }))
}

pub fn lines_of(conn: &Db, order_id: i64) -> AppResult<Vec<OrderLine>> {
    let mut stmt = conn.prepare(
        "SELECT id, order_id, product_id, department, product_name, unit_price, quantity,
                discount_minor, line_total
         FROM order_lines WHERE order_id = ?1 ORDER BY id",
    )?;
    let rows = stmt.query_map([order_id], |r| {
        Ok(OrderLine {
            id: r.get(0)?,
            order_id: r.get(1)?,
            product_id: r.get(2)?,
            department: r.get(3)?,
            product_name: r.get(4)?,
            unit_price: r.get(5)?,
            quantity: r.get(6)?,
            discount_minor: r.get(7)?,
            line_total: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Active order on a table, if any.
pub fn active_order_on_table(conn: &Db, table_id: i64) -> AppResult<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT id FROM orders WHERE table_id = ?1 AND status IN ('OPEN','READY_TO_PAY')",
            [table_id],
            |r| r.get(0),
        )
        .ok())
}

pub fn set_order_status(conn: &Db, order_id: i64, status: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE orders SET status = ?2,
            ready_at = CASE WHEN ?2 = 'READY_TO_PAY' THEN datetime('now') ELSE ready_at END,
            closed_at = CASE WHEN ?2 IN ('CLOSED','CANCELLED') THEN datetime('now') ELSE closed_at END
         WHERE id = ?1",
        params![order_id, status],
    )?;
    Ok(())
}

pub fn set_order_customer(conn: &Db, order_id: i64, customer_id: i64) -> AppResult<()> {
    conn.execute("UPDATE orders SET customer_id = ?2 WHERE id = ?1", params![order_id, customer_id])?;
    Ok(())
}

pub fn set_waiting_no(conn: &Db, order_id: i64, waiting_no: i64) -> AppResult<()> {
    conn.execute("UPDATE orders SET waiting_no = ?2 WHERE id = ?1", params![order_id, waiting_no])?;
    Ok(())
}

/// Insert a line as an immutable snapshot of the product at sale time.
pub fn add_line(
    conn: &Db,
    order_id: i64,
    product_id: i64,
    department: &str,
    product_name: &str,
    unit_price: i64,
    quantity: i64,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO order_lines (order_id, product_id, department, product_name, unit_price, quantity, line_total)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5 * ?6)",
        params![order_id, product_id, department, product_name, unit_price, quantity],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update_line_quantity(conn: &Db, line_id: i64, quantity: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE order_lines SET quantity = ?2, line_total = unit_price * ?2 WHERE id = ?1",
        params![line_id, quantity],
    )?;
    Ok(())
}

pub fn remove_line(conn: &Db, line_id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM order_lines WHERE id = ?1", [line_id])?;
    Ok(())
}

pub fn line_of(conn: &Db, line_id: i64) -> AppResult<Option<OrderLine>> {
    let mut stmt = conn.prepare(
        "SELECT id, order_id, product_id, department, product_name, unit_price, quantity,
                discount_minor, line_total
         FROM order_lines WHERE id = ?1",
    )?;
    let mut rows = stmt.query([line_id])?;
    match rows.next()? {
        Some(r) => Ok(Some(OrderLine {
            id: r.get(0)?,
            order_id: r.get(1)?,
            product_id: r.get(2)?,
            department: r.get(3)?,
            product_name: r.get(4)?,
            unit_price: r.get(5)?,
            quantity: r.get(6)?,
            discount_minor: r.get(7)?,
            line_total: r.get(8)?,
        })),
        None => Ok(None),
    }
}

pub fn has_wash_lines(conn: &Db, order_id: i64) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM order_lines WHERE order_id = ?1 AND department = 'WASH'",
        [order_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}