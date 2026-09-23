//! Tables & orders repository — the operational core of the POS.

use crate::error::AppResult;
use crate::repositories::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// Operational table state shown in the POS grid — derived from the live
/// session + live order, never stored twice:
/// EMPTY (no session) | OPEN (session, no order yet) | OCCUPIED (order, not
/// ready) | READY_TO_PAY (order marked for payment).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableView {
    pub id: i64,
    pub label: String,
    pub status: String,
    pub order_id: Option<i64>,
    pub session_id: Option<i64>,
    pub items_count: i64,
    pub total_minor: i64,
    pub opened_at: Option<String>,
    /// Lifecycle counters for the current business day (audit foundation).
    pub opens_today: i64,
    pub closed_empty_today: i64,
}

/// Per-table open/close ledger. At most ONE OPEN session per table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableSession {
    pub id: i64,
    pub table_id: i64,
    pub business_day_id: Option<i64>,
    pub shift_id: Option<i64>,
    pub opened_by: i64,
    pub opened_at: String,
    pub order_id: Option<i64>,
    pub closed_by: Option<i64>,
    pub closed_at: Option<String>,
    pub status: String,
}

const SESSION_COLS: &str = "id, table_id, business_day_id, shift_id, opened_by, opened_at,
    order_id, closed_by, closed_at, status";

fn session_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TableSession> {
    Ok(TableSession {
        id: r.get(0)?,
        table_id: r.get(1)?,
        business_day_id: r.get(2)?,
        shift_id: r.get(3)?,
        opened_by: r.get(4)?,
        opened_at: r.get(5)?,
        order_id: r.get(6)?,
        closed_by: r.get(7)?,
        closed_at: r.get(8)?,
        status: r.get(9)?,
    })
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
    pub order_type: String, // TABLE | TAKEAWAY
    pub table_id: Option<i64>,
    pub user_id: i64,
    pub status: String,
    pub customer_id: Option<i64>,
    pub opened_at: String,
    pub waiting_no: Option<i64>,
    pub takeaway_no: Option<i64>,
    pub shift_id: Option<i64>,
    pub lines: Vec<OrderLine>,
}

/// All tables with their live status/total in a single query (fast grid).
/// Lifecycle counters come from `table_sessions`, never from orders, so an
/// opened table that never ordered can never look like a sale.
pub fn list_tables(conn: &Db, business_day_id: Option<i64>) -> AppResult<Vec<TableView>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.label,
                CASE
                    WHEN o.id IS NULL AND s.id IS NULL THEN 'EMPTY'
                    WHEN o.id IS NULL THEN 'OPEN'
                    WHEN o.status = 'READY_TO_PAY' THEN 'READY_TO_PAY'
                    ELSE 'OCCUPIED'
                END,
                o.id, s.id, COUNT(l.id), COALESCE(SUM(l.line_total), 0),
                COALESCE(o.opened_at, s.opened_at),
                (SELECT COUNT(*) FROM table_sessions os
                  WHERE os.table_id = t.id AND os.business_day_id = ?1),
                (SELECT COUNT(*) FROM table_sessions cs
                  WHERE cs.table_id = t.id AND cs.business_day_id = ?1
                    AND cs.status = 'CLOSED' AND cs.order_id IS NULL)
         FROM cafe_tables t
         LEFT JOIN orders o ON o.table_id = t.id AND o.status IN ('OPEN','READY_TO_PAY')
         LEFT JOIN table_sessions s ON s.table_id = t.id AND s.status = 'OPEN'
         LEFT JOIN order_lines l ON l.order_id = o.id
         WHERE t.is_active = 1
         GROUP BY t.id, o.id, s.id
         ORDER BY t.label",
    )?;
    let rows = stmt.query_map([business_day_id], |r| {
        Ok(TableView {
            id: r.get(0)?,
            label: r.get(1)?,
            status: r.get(2)?,
            order_id: r.get(3)?,
            session_id: r.get(4)?,
            items_count: r.get(5)?,
            total_minor: r.get(6)?,
            opened_at: r.get(7)?,
            opens_today: r.get(8)?,
            closed_empty_today: r.get(9)?,
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

// ---- TABLE SESSIONS --------------------------------------------------------

/// Start a table lifecycle. The partial unique index guarantees at most one
/// live session per table even under concurrent attempts.
pub fn open_session(
    conn: &Db,
    table_id: i64,
    user_id: i64,
    business_day_id: i64,
    shift_id: i64,
) -> AppResult<Option<i64>> {
    let n = conn.execute(
        "INSERT INTO table_sessions (table_id, opened_by, business_day_id, shift_id)
         VALUES (?1, ?2, ?3, ?4)",
        params![table_id, user_id, business_day_id, shift_id],
    )?;
    if n == 0 {
        return Ok(None);
    }
    Ok(Some(conn.last_insert_rowid()))
}

pub fn open_session_of_table(conn: &Db, table_id: i64) -> AppResult<Option<TableSession>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SESSION_COLS} FROM table_sessions WHERE table_id = ?1 AND status = 'OPEN'"
    ))?;
    let mut rows = stmt.query([table_id])?;
    match rows.next()? {
        Some(r) => Ok(Some(session_row(r)?)),
        None => Ok(None),
    }
}

pub fn get_session(conn: &Db, session_id: i64) -> AppResult<Option<TableSession>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SESSION_COLS} FROM table_sessions WHERE id = ?1"
    ))?;
    let mut rows = stmt.query([session_id])?;
    match rows.next()? {
        Some(r) => Ok(Some(session_row(r)?)),
        None => Ok(None),
    }
}

/// Link the order created inside a session (the first order wins).
pub fn set_session_order(conn: &Db, session_id: i64, order_id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE table_sessions SET order_id = COALESCE(order_id, ?2) WHERE id = ?1",
        params![session_id, order_id],
    )?;
    Ok(())
}

/// Close a session. `order_id IS NULL` on a closed session IS the recorded
/// "opened and closed without an order" event.
pub fn close_session(conn: &Db, session_id: i64, user_id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE table_sessions SET status = 'CLOSED', closed_at = datetime('now'), closed_by = ?2
         WHERE id = ?1 AND status = 'OPEN'",
        params![session_id, user_id],
    )?;
    Ok(())
}

/// Close the open session of a table (used when its order is settled).
pub fn close_open_session_of_table(conn: &Db, table_id: i64, user_id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE table_sessions SET status = 'CLOSED', closed_at = datetime('now'), closed_by = ?2
         WHERE table_id = ?1 AND status = 'OPEN'",
        params![table_id, user_id],
    )?;
    Ok(())
}

/// (opens, closed-without-order) for one table inside a business day.
pub fn session_counts(conn: &Db, table_id: i64, business_day_id: i64) -> AppResult<(i64, i64)> {
    Ok(conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN status = 'CLOSED' AND order_id IS NULL THEN 1 ELSE 0 END), 0)
         FROM table_sessions WHERE table_id = ?1 AND business_day_id = ?2",
        params![table_id, business_day_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

pub fn open_order(
    conn: &Db,
    order_type: &str,
    table_id: Option<i64>,
    user_id: i64,
    business_day_id: i64,
    shift_id: i64,
) -> AppResult<Option<i64>> {
    let n = conn.execute(
        "INSERT INTO orders (order_type, table_id, user_id, business_day_id, shift_id)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![order_type, table_id, user_id, business_day_id, shift_id],
    )?;
    if n == 0 {
        return Ok(None);
    }
    Ok(Some(conn.last_insert_rowid()))
}

/// Next takeaway number of the business day. Called inside the checkout
/// transaction; the UNIQUE index on (business_day_id, takeaway_no) is the hard
/// guarantee against duplicates.
pub fn next_takeaway_no(conn: &Db, business_day_id: i64) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(takeaway_no), 0) + 1 FROM orders WHERE business_day_id = ?1",
        [business_day_id],
        |r| r.get(0),
    )?)
}

pub fn set_takeaway_no(conn: &Db, order_id: i64, takeaway_no: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE orders SET takeaway_no = ?2 WHERE id = ?1",
        params![order_id, takeaway_no],
    )?;
    Ok(())
}

pub fn get_order(conn: &Db, order_id: i64) -> AppResult<Option<Order>> {
    let head = conn
        .query_row(
            "SELECT id, order_type, table_id, user_id, status, customer_id, opened_at,
                    waiting_no, takeaway_no, shift_id
             FROM orders WHERE id = ?1",
            [order_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                    r.get::<_, Option<i64>>(9)?,
                ))
            },
        )
        .ok();
    let head = match head {
        Some(v) => v,
        None => return Ok(None),
    };
    let (
        id,
        order_type,
        table_id,
        user_id,
        status,
        customer_id,
        opened_at,
        waiting_no,
        takeaway_no,
        shift_id,
    ) = head;
    let lines = lines_of(conn, order_id)?;
    Ok(Some(Order {
        id,
        order_type,
        table_id,
        user_id,
        status,
        customer_id,
        opened_at,
        waiting_no,
        takeaway_no,
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
    conn.execute(
        "UPDATE orders SET customer_id = ?2 WHERE id = ?1",
        params![order_id, customer_id],
    )?;
    Ok(())
}

pub fn set_waiting_no(conn: &Db, order_id: i64, waiting_no: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE orders SET waiting_no = ?2 WHERE id = ?1",
        params![order_id, waiting_no],
    )?;
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
