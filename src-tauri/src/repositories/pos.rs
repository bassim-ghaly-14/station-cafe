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
    /// Lifecycle counters for the caller's ACTIVE SHIFT. The historical
    /// `*_today` names are kept for API stability; the values count only the
    /// `table_sessions` rows owned by the active `shift_id` (shift KPI band
    /// scope), and read zero with no active shift.
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
    pub discount_mode: Option<String>,
    pub discount_value: Option<i64>,
    pub opened_at: String,
    pub waiting_no: Option<i64>,
    pub takeaway_no: Option<i64>,
    pub shift_id: Option<i64>,
    /// The WASH_WORKER this job is attributed to, chosen by the cashier while
    /// the order is open. Checked-out invoices SNAPSHOT this value, so a closed
    /// document is never re-read from the order.
    pub wash_employee_id: Option<i64>,
    /// Authoritative table label (joined from `cafe_tables`) for TABLE orders;
    /// `None` for TAKEAWAY — a takeaway never fakes a table.
    pub table_label: Option<String>,
    pub lines: Vec<OrderLine>,
}

/// Compact row that keeps an in-progress TAKEAWAY order discoverable so it
/// can be reopened after leaving the active order view. Pure order data —
/// takeaway rows are never faked as tables.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TakeawayView {
    pub id: i64, // order id
    pub status: String,
    pub opened_at: String,
    pub items_count: i64,
    pub total_minor: i64,
}

/// The canonical business-day predicate for a lifecycle column.
///
/// A `table_sessions` row records an OPENING instant and a CLOSING instant, and
/// `business_day_id` names the day the table was OPENED on. Counting "closes
/// that happened today" therefore cannot filter on `business_day_id`: a session
/// opened late yesterday and closed after midnight belongs to yesterday's
/// counter forever, so its empty close is silently lost.
///
/// The close is dated by its own `closed_at` instant instead, through
/// `station_business_date` — the one function that turns an instant into a
/// Station business day (see `db::register_business_date`). It is joined to the
/// business day the application already owns rather than re-deriving one, so no
/// hardcoded `+03:00` and no second notion of "today" can creep in.
fn closed_on_business_day(session_alias: &str) -> String {
    format!(
        "station_business_date({a}.closed_at) = \
         (SELECT d.day_date FROM business_days d WHERE d.id = ?1)",
        a = session_alias,
    )
}

/// The same rule for the OPENING instant, so both daily counters are scoped by
/// the event they actually count.
fn opened_on_business_day(session_alias: &str) -> String {
    format!(
        "station_business_date({a}.opened_at) = \
         (SELECT d.day_date FROM business_days d WHERE d.id = ?1)",
        a = session_alias,
    )
}

/// The authoritative lifecycle totals of a business day.
///
/// `closed_empty` is THE empty-close count. It is a persisted fact read back
/// from `table_sessions`, never a frontend accumulator, so it is identical on a
/// fresh database and on a heavily used one, and identical before and after a
/// restart.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableCounters {
    /// Sessions opened during the business day.
    pub opens: i64,
    /// Sessions closed during the business day with no order attached.
    pub closed_empty: i64,
}

/// All tables with their live status/total in a single query (fast grid).
/// Lifecycle counters come from `table_sessions`, never from orders, so an
/// opened table that never ordered can never look like a sale.
///
/// The per-table counters are a PRESENTATION of the caller's ACTIVE SHIFT,
/// scoped through `shift_id` — the same scope the shift KPI band and the
/// close-shift dialog report. A new shift owns no sessions yet, so its cards
/// naturally read zero without deleting any historical rows. Field names keep
/// the historical `*_today` suffix for API stability; their semantics are the
/// active shift, not the business day.
/// They are deliberately not the source of truth for the day total: a table
/// deactivated later leaves the grid and would take its history with it. The
/// day's authoritative figures come from `day_lifecycle_counts`.
pub fn list_tables(conn: &Db, shift_id: Option<i64>) -> AppResult<Vec<TableView>> {
    // With no active shift there is no period to describe: every counter reads
    // zero. The `1 = 0` guard matches no row without touching `shift_id`.
    let (scope_os, scope_cs) = match shift_id {
        Some(_) => ("os.shift_id = ?1", "cs.shift_id = ?1"),
        None => ("1 = 0", "1 = 0"),
    };
    let sql = format!(
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
                  WHERE os.table_id = t.id AND {scope_os}),
                (SELECT COUNT(*) FROM table_sessions cs
                  WHERE cs.table_id = t.id
                    AND cs.status = 'CLOSED' AND cs.order_id IS NULL AND {scope_cs})
         FROM cafe_tables t
         LEFT JOIN orders o ON o.table_id = t.id AND o.status IN ('OPEN','READY_TO_PAY')
         LEFT JOIN table_sessions s ON s.table_id = t.id AND s.status = 'OPEN'
         LEFT JOIN order_lines l ON l.order_id = o.id
         WHERE t.is_active = 1
         GROUP BY t.id, o.id, s.id
         ORDER BY t.label",
    );
    let mut stmt = conn.prepare(&sql)?;
    let map_row = |r: &rusqlite::Row<'_>| {
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
    };
    // The no-shift SQL carries no placeholder, so it must be executed without a
    // bound parameter; the shift branch binds the single `shift_id`.
    let rows = match shift_id {
        Some(id) => stmt.query_map([id], map_row)?,
        None => stmt.query_map([], map_row)?,
    };
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// The authoritative lifecycle totals of one business day: how many table
/// sessions were opened, and how many of them were closed with NO order.
///
/// This is the single definition of the empty-close count. It is derived
/// straight from `table_sessions` — the persisted lifecycle — and deliberately
/// does NOT join `cafe_tables`, because an empty close is a historical business
/// event: retiring a table from the active grid must never erase the closes it
/// already recorded, and the count must therefore be identical on a fresh
/// database and on a fully-used one.
///
/// An empty close is a session that reached `CLOSED` while `order_id IS NULL`:
/// opened, closed normally, and no order/invoice/revenue was ever attached. No
/// separate counter is stored, so the figure cannot drift from the rows it
/// summarises.
pub fn day_lifecycle_counts(conn: &Db, business_day_id: Option<i64>) -> AppResult<TableCounters> {
    let sql = format!(
        "SELECT
            (SELECT COUNT(*) FROM table_sessions os WHERE {opened}),
            (SELECT COUNT(*) FROM table_sessions cs
              WHERE cs.status = 'CLOSED' AND cs.order_id IS NULL AND {closed})",
        opened = opened_on_business_day("os"),
        closed = closed_on_business_day("cs"),
    );
    Ok(conn.query_row(&sql, [business_day_id], |r| {
        Ok(TableCounters {
            opens: r.get(0)?,
            closed_empty: r.get(1)?,
        })
    })?)
}

/// The same lifecycle counters scoped to ONE SHIFT instead of the business day.
///
/// A shift is the till's own working period, so the same persisted
/// `table_sessions` rows are read through `shift_id` — the column the session
/// was already stamped with when it opened. Nothing new is stored and nothing
/// new is counted:
///
///   * `opens`         — sessions opened during this shift;
///   * `closed_empty`  — sessions that reached `CLOSED` with no order, the very
///     same "opened, closed, never ordered" event the day counter reports.
///
/// Because the scope is the shift that owns the rows, a shift-scoped figure
/// resets NATURALLY when the next shift opens (it owns no sessions yet), and it
/// survives an application restart because it is a read of persisted rows rather
/// than anything a caller accumulates.
///
/// This is a SCOPE of the one lifecycle definition, not a second definition of
/// it: `closed_empty` carries the identical `status = 'CLOSED' AND order_id IS
/// NULL` rule, so the shift figure and the day figure can never disagree about
/// what an empty close is — only about which period they describe.
pub fn shift_lifecycle_counts(conn: &Db, shift_id: i64) -> AppResult<TableCounters> {
    Ok(conn.query_row(
        "SELECT
            (SELECT COUNT(*) FROM table_sessions os WHERE os.shift_id = ?1),
            (SELECT COUNT(*) FROM table_sessions cs
              WHERE cs.shift_id = ?1 AND cs.status = 'CLOSED' AND cs.order_id IS NULL)",
        [shift_id],
        |r| {
            Ok(TableCounters {
                opens: r.get(0)?,
                closed_empty: r.get(1)?,
            })
        },
    )?)
}
pub fn get_table(conn: &Db, id: i64) -> AppResult<Option<(i64, String)>> {
    let mut stmt =
        conn.prepare("SELECT id, label FROM cafe_tables WHERE id = ?1 AND is_active = 1")?;
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
        "UPDATE table_sessions SET status = 'CLOSED', closed_at = station_now(), closed_by = ?2
         WHERE id = ?1 AND status = 'OPEN'",
        params![session_id, user_id],
    )?;
    Ok(())
}

/// Close the open session of a table (used when its order is settled).
pub fn close_open_session_of_table(conn: &Db, table_id: i64, user_id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE table_sessions SET status = 'CLOSED', closed_at = station_now(), closed_by = ?2
         WHERE table_id = ?1 AND status = 'OPEN'",
        params![table_id, user_id],
    )?;
    Ok(())
}

/// (opens, closed-without-order) for ONE table inside a business day.
///
/// Uses the same business-day rule as `list_tables` and `day_lifecycle_counts`
/// so the three reads can never disagree about what belongs to a day: an open
/// is counted by its opening instant, an empty close by its closing instant.
pub fn session_counts(conn: &Db, table_id: i64, business_day_id: i64) -> AppResult<(i64, i64)> {
    let sql = format!(
        "SELECT
            (SELECT COUNT(*) FROM table_sessions os
              WHERE os.table_id = ?1 AND {opened}),
            (SELECT COUNT(*) FROM table_sessions cs
              WHERE cs.table_id = ?1 AND cs.status = 'CLOSED' AND cs.order_id IS NULL
                AND {closed})",
        opened = opened_on_business_day("os").replace("?1", "?2"),
        closed = closed_on_business_day("cs").replace("?1", "?2"),
    );
    Ok(
        conn.query_row(&sql, params![table_id, business_day_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?,
    )
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

/// Open (unpaid) TAKEAWAY orders owned by `owner_id`. Ownership mirrors the
/// edit path (`require_editable` is owner-only), so every listed row is
/// guaranteed reopenable by the caller. Explicit order-type semantics: this
/// query never touches tables.
pub fn list_open_takeaways(conn: &Db, owner_id: i64) -> AppResult<Vec<TakeawayView>> {
    let mut stmt = conn.prepare(
        "SELECT o.id, o.status, o.opened_at, COUNT(l.id), COALESCE(SUM(l.line_total), 0)
         FROM orders o
         LEFT JOIN order_lines l ON l.order_id = o.id
         WHERE o.order_type = 'TAKEAWAY'
           AND o.status IN ('OPEN','READY_TO_PAY')
           AND o.user_id = ?1
         GROUP BY o.id, o.status, o.opened_at
         ORDER BY o.id",
    )?;
    let rows = stmt.query_map([owner_id], |r| {
        Ok(TakeawayView {
            id: r.get(0)?,
            status: r.get(1)?,
            opened_at: r.get(2)?,
            items_count: r.get(3)?,
            total_minor: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get_order(conn: &Db, order_id: i64) -> AppResult<Option<Order>> {
    let head = conn
        .query_row(
            "SELECT o.id, o.order_type, o.table_id, o.user_id, o.status, o.customer_id, o.discount_mode,
                    o.discount_value, o.opened_at,
                    o.waiting_no, o.takeaway_no, o.shift_id, o.wash_employee_id, t.label
             FROM orders o
             LEFT JOIN cafe_tables t ON t.id = o.table_id
             WHERE o.id = ?1",
            [order_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, Option<i64>>(9)?,
                    r.get::<_, Option<i64>>(10)?,
                    r.get::<_, Option<i64>>(11)?,
                    r.get::<_, Option<i64>>(12)?,
                    r.get::<_, Option<String>>(13)?,
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
        discount_mode,
        discount_value,
        opened_at,
        waiting_no,
        takeaway_no,
        shift_id,
        wash_employee_id,
        table_label,
    ) = head;
    let lines = lines_of(conn, order_id)?;
    Ok(Some(Order {
        id,
        order_type,
        table_id,
        user_id,
        status,
        customer_id,
        discount_mode,
        discount_value,
        opened_at,
        waiting_no,
        takeaway_no,
        shift_id,
        wash_employee_id,
        table_label,
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
            ready_at = CASE WHEN ?2 = 'READY_TO_PAY' THEN station_now() ELSE ready_at END,
            closed_at = CASE WHEN ?2 IN ('CLOSED','CANCELLED') THEN station_now() ELSE closed_at END
         WHERE id = ?1",
        params![order_id, status],
    )?;
    Ok(())
}

// ---- WASH TICKETS ----------------------------------------------------------

/// Has a wash job ticket already been ISSUED for this order?
///
/// `wash_tickets` is the persisted document itself, so its EXISTENCE is the
/// single source of truth for "issued" — never the presence of order lines
/// (those stay editable) and never a client-side flag. The waiting number the
/// cashier handed over is a copy of this fact, not the fact itself.
pub fn has_wash_ticket(conn: &Db, order_id: i64) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM wash_tickets WHERE order_id = ?1)",
        [order_id],
        |r| r.get(0),
    )?;
    Ok(n != 0)
}

/// One issued wash job ticket, as the daily wash-tickets view reads it.
///
/// Every column is an EXISTING persisted fact. There is deliberately no
/// `status`: the domain has no wash-ticket status, and inventing one would be
/// a second source of truth. The operational state a row can honestly show is
/// its ORDER's state (`order_status`) plus the related invoice when one exists.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WashTicketRow {
    /// The ticket's own identifier — the row in `wash_tickets`.
    pub id: i64,
    /// The number the customer is called by, unique per business day.
    pub waiting_no: i64,
    /// The Station BUSINESS date the ticket was issued on.
    pub day_date: String,
    /// Issue instant (UTC), rendered through the shared formatter.
    pub issued_at: String,
    /// The order the ticket was issued for (a NOT NULL foreign key).
    pub order_id: i64,
    /// The order's own status — the only status this domain actually has.
    pub order_status: String,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    /// The customer's most recent car: the same rule the printed ticket uses.
    pub car_plate: Option<String>,
    pub car_model: Option<String>,
    /// The WASH services the ticket was issued for, from the order's own lines.
    pub services: Option<String>,
    /// The related receipt, through the REAL relation `invoices.order_id`.
    /// Absent while the wash job has not been invoiced yet.
    pub invoice_id: Option<i64>,
    pub invoice_no: Option<i64>,
    pub invoice_status: Option<String>,
    pub invoice_total: Option<i64>,
}

pub fn set_order_customer(conn: &Db, order_id: i64, customer_id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE orders SET customer_id = ?2 WHERE id = ?1",
        params![order_id, customer_id],
    )?;
    Ok(())
}

/// Persist the validated order-level discount selection on the order row.
/// Checkout still re-validates it against the global ceiling.
pub fn set_order_discount(
    conn: &Db,
    order_id: i64,
    discount_mode: Option<&str>,
    discount_value: Option<i64>,
) -> AppResult<()> {
    conn.execute(
        "UPDATE orders SET discount_mode = ?2, discount_value = ?3 WHERE id = ?1",
        params![order_id, discount_mode, discount_value],
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

/// Attribute the wash job to a wash worker (`None` clears it).
///
/// Only the ORDER carries the attribution; checkout snapshots it onto the
/// invoice, so a finalized document never depends on this row again.
pub fn set_order_wash_employee(
    conn: &Db,
    order_id: i64,
    wash_employee_id: Option<i64>,
) -> AppResult<()> {
    conn.execute(
        "UPDATE orders SET wash_employee_id = ?2 WHERE id = ?1",
        params![order_id, wash_employee_id],
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

/// The order's existing line for a product, if any. This is the duplicate
/// lookup used when adding an item: the order keeps ONE line per product.
pub fn line_of_product(conn: &Db, order_id: i64, product_id: i64) -> AppResult<Option<OrderLine>> {
    let mut stmt = conn.prepare(
        "SELECT id, order_id, product_id, department, product_name, unit_price, quantity,
                discount_minor, line_total
         FROM order_lines WHERE order_id = ?1 AND product_id = ?2
         ORDER BY id LIMIT 1",
    )?;
    let mut rows = stmt.query(params![order_id, product_id])?;
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

const WASH_TICKET_COLS: &str = "t.id, t.waiting_no, t.day_date, t.issued_at,
    o.id, o.status, c.name, c.phone, car.plate_no, car.car_model,
    (SELECT GROUP_CONCAT(w.product_name, ' · ') FROM (
        SELECT l.product_name FROM order_lines l
        WHERE l.order_id = o.id AND l.department = 'WASH' ORDER BY l.id) w),
    inv.id, inv.invoice_no, inv.status, inv.total";

/// The wash tickets of one business day — or of the whole history when no
/// business day is given, mirroring how `search_invoices` treats فواتير اليوم.
///
/// TWO relationship rules this query must never break:
///
/// 1. **A ticket is never dropped for lacking an invoice.** The receipt is
///    reached with a LEFT JOIN, because the ticket is the EARLIER,
///    authoritative document: a wash job is ticketed when it starts and only
///    invoiced when it leaves the bay. An INNER JOIN here would silently hide
///    every ticket still in progress.
/// 2. **The receipt is matched by the persisted key, never by resemblance.**
///    `invoices.order_id` is the real relation checkout already writes. No
///    customer name, plate, timestamp, amount or row position is ever compared.
///
/// The day filter is `orders.business_day_id` — the same business-day key the
/// invoices page uses. It is deliberately NOT `wash_tickets.day_date`:
/// business days are repeatable and two of them may share one calendar label,
/// so the label is not a day identity.
pub fn daily_wash_tickets(
    conn: &Db,
    business_day_id: Option<i64>,
    query: Option<&str>,
    order_status: Option<&str>,
) -> AppResult<Vec<WashTicketRow>> {
    let mut sql = format!(
        "SELECT {WASH_TICKET_COLS} FROM wash_tickets t
         JOIN orders o ON o.id = t.order_id
         LEFT JOIN customers c ON c.id = o.customer_id
         LEFT JOIN cars car ON car.id = (
             SELECT id FROM cars WHERE customer_id = o.customer_id ORDER BY id DESC LIMIT 1)
         LEFT JOIN invoices inv ON inv.order_id = o.id
         WHERE 1=1"
    );
    let mut args: Vec<String> = Vec::new();
    if let Some(d) = business_day_id {
        args.push(d.to_string());
        sql.push_str(&format!(" AND o.business_day_id = ?{}", args.len()));
    }
    if let Some(qq) = query {
        args.push(format!("%{qq}%"));
        sql.push_str(&format!(
            " AND (CAST(t.waiting_no AS TEXT) LIKE ?{n}
                  OR CAST(o.id AS TEXT) LIKE ?{n}
                  OR c.name LIKE ?{n} OR c.phone LIKE ?{n} OR car.plate_no LIKE ?{n}
                  OR CAST(inv.invoice_no AS TEXT) LIKE ?{n})",
            n = args.len()
        ));
    }
    if let Some(s) = order_status {
        args.push(s.to_string());
        sql.push_str(&format!(" AND o.status = ?{}", args.len()));
    }
    // The same newest-first ordering as فواتير اليوم, so the twins read alike.
    // Bounded to the latest 200 rows: when no business day is open this query
    // is the whole history, and history must never be unbounded.
    sql.push_str(" ORDER BY t.id DESC LIMIT 200");
    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(refs.as_slice(), |r| {
        Ok(WashTicketRow {
            id: r.get(0)?,
            waiting_no: r.get(1)?,
            day_date: r.get(2)?,
            issued_at: r.get(3)?,
            order_id: r.get(4)?,
            order_status: r.get(5)?,
            customer_name: r.get(6)?,
            customer_phone: r.get(7)?,
            car_plate: r.get(8)?,
            car_model: r.get(9)?,
            services: r.get(10)?,
            invoice_id: r.get(11)?,
            invoice_no: r.get(12)?,
            invoice_status: r.get(13)?,
            invoice_total: r.get(14)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}
