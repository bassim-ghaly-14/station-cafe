//! Shift & business-day repository, including closing aggregations.
//! Aggregation SQL lives here; the service validates lifecycle + wraps in a
//! transaction + writes audit rows.

use crate::error::AppResult;
use crate::repositories::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShiftRow {
    pub id: i64,
    pub business_day_id: i64,
    pub user_id: i64,
    pub user_name: Option<String>,
    pub status: String,
    pub opened_at: String,
    pub opening_cash: i64,
    pub closed_at: Option<String>,
    pub cash_sales: i64,
    pub card_sales: i64,
    pub credit_sales: i64,
    pub service_charges: i64,
    pub discounts: i64,
    pub invoices_count: i64,
    pub expected_cash: i64,
    pub actual_cash: Option<i64>,
    pub cash_difference: Option<i64>,
}

const SHIFT_COLS: &str = "s.id, s.business_day_id, s.user_id, u.name, s.status, s.opened_at,
    s.opening_cash, s.closed_at, s.cash_sales, s.card_sales, s.credit_sales,
    s.service_charges, s.discounts, s.invoices_count, s.expected_cash, s.actual_cash, s.cash_difference";

fn shift_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ShiftRow> {
    Ok(ShiftRow {
        id: r.get(0)?,
        business_day_id: r.get(1)?,
        user_id: r.get(2)?,
        user_name: r.get(3)?,
        status: r.get(4)?,
        opened_at: r.get(5)?,
        opening_cash: r.get(6)?,
        closed_at: r.get(7)?,
        cash_sales: r.get(8)?,
        card_sales: r.get(9)?,
        credit_sales: r.get(10)?,
        service_charges: r.get(11)?,
        discounts: r.get(12)?,
        invoices_count: r.get(13)?,
        expected_cash: r.get(14)?,
        actual_cash: r.get(15)?,
        cash_difference: r.get(16)?,
    })
}

// ---- BUSINESS DAY ----------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusinessDay {
    pub id: i64,
    pub day_date: String,
    pub status: String,
    pub opened_at: String,
    pub closed_at: Option<String>,
}

pub fn open_day(conn: &Db, user_id: i64) -> AppResult<Option<i64>> {
    // Explicit business-day entity; the calendar date is only its label.
    let n = conn.execute(
        "INSERT INTO business_days (day_date, opened_at, opened_by)
         VALUES (date('now'), datetime('now'), ?1)
         ON CONFLICT(day_date) DO NOTHING",
        params![user_id],
    )?;
    if n == 0 {
        return Ok(None); // a day already exists for this date
    }
    Ok(Some(conn.last_insert_rowid()))
}

/// The current OPEN business day, if any.
pub fn current_day(conn: &Db) -> AppResult<Option<BusinessDay>> {
    let mut stmt = conn.prepare(
        "SELECT id, day_date, status, opened_at, closed_at FROM business_days
         WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1",
    )?;
    let mut rows = stmt.query([])?;
    match rows.next()? {
        Some(r) => Ok(Some(BusinessDay {
            id: r.get(0)?,
            day_date: r.get(1)?,
            status: r.get(2)?,
            opened_at: r.get(3)?,
            closed_at: r.get(4)?,
        })),
        None => Ok(None),
    }
}

pub fn close_day(conn: &Db, day_id: i64, user_id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE business_days SET status = 'CLOSED', closed_at = datetime('now'), closed_by = ?2
         WHERE id = ?1 AND status = 'OPEN'",
        params![day_id, user_id],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DayTotals {
    pub invoices_count: i64,
    pub cafe_sales: i64,
    pub wash_sales: i64,
    pub subtotal: i64,
    pub discounts: i64,
    pub service_charges: i64,
    pub total_sales: i64,
    pub cash: i64,
    pub card: i64,
    pub credit: i64,
    pub expenses: i64,
}

/// Day-level aggregation computed from invoices + expenses (excl. cancelled).
pub fn day_totals(conn: &Db, day_id: i64) -> AppResult<DayTotals> {
    Ok(conn.query_row(
        "SELECT
            COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.cafe_total ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.wash_total ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.subtotal ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.discount_minor ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.service_charge ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.total ELSE 0 END), 0),
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN invoices i2 ON i2.id = p.invoice_id
              WHERE i2.business_day_id = ?1 AND p.method = 'CASH'),
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN invoices i2 ON i2.id = p.invoice_id
              WHERE i2.business_day_id = ?1 AND p.method = 'CARD'),
            COALESCE(SUM(CASE WHEN i.status = 'CREDIT' THEN i.total - i.paid_amount ELSE 0 END), 0),
            (SELECT COALESCE(SUM(e.amount),0) FROM expenses e WHERE e.business_day_id = ?1)
         FROM invoices i WHERE i.business_day_id = ?1",
        [day_id],
        |r| {
            Ok(DayTotals {
                invoices_count: r.get(0)?,
                cafe_sales: r.get(1)?,
                wash_sales: r.get(2)?,
                subtotal: r.get(3)?,
                discounts: r.get(4)?,
                service_charges: r.get(5)?,
                total_sales: r.get(6)?,
                cash: r.get(7)?,
                card: r.get(8)?,
                credit: r.get(9)?,
                expenses: r.get(10)?,
            })
        },
    )?)
}

// ---- SHIFTS ----------------------------------------------------------------

pub fn open_shift(conn: &Db, day_id: i64, user_id: i64, opening_cash: i64) -> AppResult<Option<i64>> {
    let n = conn.execute(
        "INSERT INTO shifts (business_day_id, user_id, opening_cash) VALUES (?1, ?2, ?3)",
        params![day_id, user_id, opening_cash],
    )?;
    if n == 0 {
        return Ok(None);
    }
    Ok(Some(conn.last_insert_rowid()))
}

/// The caller's own ACTIVE shift, if any.
pub fn active_shift_for(conn: &Db, user_id: i64) -> AppResult<Option<ShiftRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SHIFT_COLS} FROM shifts s JOIN users u ON u.id = s.user_id
         WHERE s.user_id = ?1 AND s.status = 'ACTIVE' ORDER BY s.id DESC LIMIT 1"
    ))?;
    let mut rows = stmt.query([user_id])?;
    match rows.next()? {
        Some(r) => Ok(Some(shift_row(r)?)),
        None => Ok(None),
    }
}

/// Any ACTIVE shift (used for shift-gating rules).
pub fn any_active_shift(conn: &Db) -> AppResult<Option<ShiftRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SHIFT_COLS} FROM shifts s JOIN users u ON u.id = s.user_id
         WHERE s.status = 'ACTIVE' ORDER BY s.id DESC LIMIT 1"
    ))?;
    let mut rows = stmt.query([])?;
    match rows.next()? {
        Some(r) => Ok(Some(shift_row(r)?)),
        None => Ok(None),
    }
}

pub fn get_shift(conn: &Db, shift_id: i64) -> AppResult<Option<ShiftRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SHIFT_COLS} FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.id = ?1"
    ))?;
    let mut rows = stmt.query([shift_id])?;
    match rows.next()? {
        Some(r) => Ok(Some(shift_row(r)?)),
        None => Ok(None),
    }
}

/// Compute one shift's closing aggregates from its invoices + payments.
/// Returns (cash_sales, card_sales, service_charges, discounts, invoices_count).
pub fn compute_shift_totals(conn: &Db, shift_id: i64) -> AppResult<(i64, i64, i64, i64, i64)> {
    Ok(conn.query_row(
        "SELECT
            COALESCE(SUM(CASE WHEN p.method = 'CASH' THEN p.amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN p.method = 'CARD' THEN p.amount ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.service_charge ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.discount_minor ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN 1 ELSE 0 END), 0)
         FROM invoices i
         LEFT JOIN payments p ON p.invoice_id = i.id
         WHERE i.shift_id = ?1",
        [shift_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?)
}

/// Credit issued during the shift (payments with method CREDIT).
pub fn shift_credit_sales(conn: &Db, shift_id: i64) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(p.amount), 0) FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
         WHERE i.shift_id = ?1 AND p.method = 'CREDIT'",
        [shift_id],
        |r| r.get(0),
    )?)
}

/// Persist computed closing aggregates + expected cash.
pub fn save_shift_closing(
    conn: &Db,
    shift_id: i64,
    cash_sales: i64,
    card_sales: i64,
    credit_sales: i64,
    service_charges: i64,
    discounts: i64,
    invoices_count: i64,
    expected_cash: i64,
    actual_cash: i64,
) -> AppResult<()> {
    conn.execute(
        "UPDATE shifts SET status = 'CLOSED', closed_at = datetime('now'),
            cash_sales = ?2, card_sales = ?3, credit_sales = ?4, service_charges = ?5,
            discounts = ?6, invoices_count = ?7, expected_cash = ?8,
            actual_cash = ?9, cash_difference = ?9 - ?8
         WHERE id = ?1",
        params![
            shift_id, cash_sales, card_sales, credit_sales, service_charges, discounts,
            invoices_count, expected_cash, actual_cash
        ],
    )?;
    Ok(())
}

pub fn shifts_of_day(conn: &Db, day_id: i64) -> AppResult<Vec<ShiftRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SHIFT_COLS} FROM shifts s JOIN users u ON u.id = s.user_id
         WHERE s.business_day_id = ?1 ORDER BY s.id"
    ))?;
    let rows = stmt.query_map([day_id], shift_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn open_orders_in_day(conn: &Db, day_id: i64) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM orders WHERE business_day_id = ?1 AND status IN ('OPEN','READY_TO_PAY')",
        [day_id],
        |r| r.get(0),
    )?)
}