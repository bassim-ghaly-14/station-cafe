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
    pub user_role: Option<String>,
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

const SHIFT_COLS: &str = "s.id, s.business_day_id, s.user_id, u.name, u.role, s.status, s.opened_at,
    s.opening_cash, s.closed_at, s.cash_sales, s.card_sales, s.credit_sales,
    s.service_charges, s.discounts, s.invoices_count, s.expected_cash, s.actual_cash, s.cash_difference";

fn shift_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ShiftRow> {
    Ok(ShiftRow {
        id: r.get(0)?,
        business_day_id: r.get(1)?,
        user_id: r.get(2)?,
        user_name: r.get(3)?,
        user_role: r.get(4)?,
        status: r.get(5)?,
        opened_at: r.get(6)?,
        opening_cash: r.get(7)?,
        closed_at: r.get(8)?,
        cash_sales: r.get(9)?,
        card_sales: r.get(10)?,
        credit_sales: r.get(11)?,
        service_charges: r.get(12)?,
        discounts: r.get(13)?,
        invoices_count: r.get(14)?,
        expected_cash: r.get(15)?,
        actual_cash: r.get(16)?,
        cash_difference: r.get(17)?,
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
    // A closed day must not prevent opening a new operational day with the
    // same calendar label.
    //
    // `day_date` is a Station BUSINESS date, so it comes from the canonical
    // business timezone — not from SQLite's UTC `date('now')`. Using the UTC
    // date would file a 00:30 Cairo transaction under the previous day.
    // `opened_at` is an INSTANT, so it stays an explicit UTC instant.
    let n = conn.execute(
        "INSERT INTO business_days (day_date, opened_at, opened_by)
         VALUES (station_today(), station_now(), ?1)",
        params![user_id],
    )?;
    if n == 0 {
        return Ok(None);
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
        "UPDATE business_days SET status = 'CLOSED', closed_at = station_now(), closed_by = ?2
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

pub fn sqlite_now(conn: &Db) -> AppResult<String> {
    Ok(conn.query_row("SELECT station_now()", [], |r| r.get(0))?)
}

pub fn open_shift(
    conn: &Db,
    day_id: i64,
    user_id: i64,
    opening_cash: i64,
) -> AppResult<Option<i64>> {
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

/// The caller's latest shift (used for post-close preview/print of the final
/// closed-shift snapshot once no ACTIVE shift remains).
pub fn latest_shift_for(conn: &Db, user_id: i64) -> AppResult<Option<ShiftRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SHIFT_COLS} FROM shifts s JOIN users u ON u.id = s.user_id
         WHERE s.user_id = ?1 ORDER BY s.id DESC LIMIT 1"
    ))?;
    let mut rows = stmt.query([user_id])?;
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

/// Recompute the aggregate columns of an ACTIVE shift from its live
/// transactions.
///
/// The aggregate columns on `shifts` are the immutable CLOSING SNAPSHOT: they
/// are written exactly once by `save_shift_closing` and are what every
/// historical shift report is reproduced from. While a shift is still ACTIVE
/// that snapshot does not exist yet, so a row read straight from `shifts`
/// carries only column defaults and can never show the shift's sales.
///
/// This hydrates the LIVE VIEW of an ACTIVE shift using the very same
/// authoritative helpers `close_shift` persists from, so the POS card, the
/// closing dialog and the persisted closing snapshot can never disagree.
/// A CLOSED shift is returned untouched — historical data is never recomputed.
pub fn hydrate_active_totals(conn: &Db, shift: &mut ShiftRow) -> AppResult<()> {
    if shift.status != "ACTIVE" {
        return Ok(());
    }
    let (cash, card, service_charges, discounts, invoices_count) =
        compute_shift_totals(conn, shift.id)?;
    shift.cash_sales = cash;
    shift.card_sales = card;
    shift.credit_sales = shift_credit_sales(conn, shift.id)?;
    shift.service_charges = service_charges;
    shift.discounts = discounts;
    shift.invoices_count = invoices_count;
    // Cash expenses are tracked at day level, so expected drawer cash for a
    // shift is its opening float plus the cash it actually took — the exact
    // expression `close_shift` persists.
    shift.expected_cash = shift.opening_cash + cash;
    Ok(())
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
    closed_at: &str,
) -> AppResult<()> {
    conn.execute(
        "UPDATE shifts SET status = 'CLOSED', closed_at = ?10,
            cash_sales = ?2, card_sales = ?3, credit_sales = ?4, service_charges = ?5,
            discounts = ?6, invoices_count = ?7, expected_cash = ?8,
            actual_cash = ?9, cash_difference = ?9 - ?8
         WHERE id = ?1",
        params![
            shift_id,
            cash_sales,
            card_sales,
            credit_sales,
            service_charges,
            discounts,
            invoices_count,
            expected_cash,
            actual_cash,
            closed_at
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayClosingRecord {
    pub id: i64,
    pub business_day_id: i64,
    pub closed_by: i64,
    pub closed_at: String,
    pub shift_ids: Vec<i64>,
    pub totals: DayTotals,
    pub final_snapshot: bool,
}

/// One historical (closed) business day as the reports screen consumes it.
///
/// The shape is FLAT on purpose: `business_day_id` / `day_date` / `status` /
/// `opened_at` / `closed_at` describe the business day itself, while
/// `closing_id` / `closed_by` / `shift_count` / `totals` describe the immutable
/// final closing snapshot the row is read from. The reports list addresses a
/// day by `business_day_id` to open its report preview, so that identifier must
/// exist on the row itself — a nested `day` object left it `undefined` on the
/// client and every preview request was rejected at the IPC boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClosedBusinessDayReport {
    pub business_day_id: i64,
    pub day_date: String,
    pub status: String,
    pub opened_at: String,
    pub closed_at: String,
    pub closing_id: i64,
    pub closed_by: i64,
    pub shift_count: i64,
    pub totals: DayTotals,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettlementPreview {
    pub business_day_id: i64,
    pub pending_shifts: Vec<ShiftRow>,
    pub totals: DayTotals,
}

/// Closed shifts in a day that have not been associated with any prior
/// settlement. Ordering is the authoritative operational sequence.
pub fn pending_shifts(conn: &Db, day_id: i64) -> AppResult<Vec<ShiftRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SHIFT_COLS} FROM shifts s JOIN users u ON u.id = s.user_id
         WHERE s.business_day_id = ?1 AND s.status = 'CLOSED'
           AND NOT EXISTS (SELECT 1 FROM day_closing_shifts dcs WHERE dcs.shift_id = s.id)
         ORDER BY s.opened_at, s.id"
    ))?;
    let rows = stmt.query_map([day_id], shift_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Settlement totals for exactly the supplied shift ids. Day expenses are
/// assigned only to the first settlement for that operational day.
pub fn settlement_totals(conn: &Db, day_id: i64, shift_ids: &[i64]) -> AppResult<DayTotals> {
    if shift_ids.is_empty() {
        return Ok(DayTotals::default());
    }
    let placeholders = std::iter::repeat("?")
        .take(shift_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT
          COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN 1 ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.cafe_total ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.wash_total ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.subtotal ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.discount_minor ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.service_charge ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.total ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN p.method = 'CASH' THEN p.amount ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN p.method = 'CARD' THEN p.amount ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN i.status = 'CREDIT' THEN i.total - i.paid_amount ELSE 0 END), 0),
          (SELECT COALESCE(SUM(e.amount), 0) FROM expenses e
             WHERE e.business_day_id = ?1
               AND NOT EXISTS (SELECT 1 FROM day_closing_expenses dce WHERE dce.expense_id = e.id))
         FROM invoices i LEFT JOIN payments p ON p.invoice_id = i.id
         WHERE i.shift_id IN ({placeholders})"
    );
    let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(day_id)];
    values.extend(
        shift_ids
            .iter()
            .map(|id| Box::new(*id) as Box<dyn rusqlite::ToSql>),
    );
    let values: Vec<&dyn rusqlite::ToSql> = values.iter().map(|v| v.as_ref()).collect();
    Ok(conn.query_row(&sql, values.as_slice(), |r| {
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
    })?)
}

/// Insert a settlement snapshot and relationships in the caller's transaction.
pub fn insert_day_closing(
    conn: &Db,
    business_day_id: i64,
    closed_by: i64,
    shift_ids: &[i64],
    totals: &DayTotals,
) -> AppResult<i64> {
    insert_day_closing_snapshot(conn, business_day_id, closed_by, shift_ids, totals, false)
}

/// Insert the one final, immutable report snapshot for a business day. The
/// settlement relationships remain one-per-shift in the incremental table;
/// this final row is a complete day report and is identified by `final_snapshot`.
pub fn insert_final_day_closing(
    conn: &Db,
    business_day_id: i64,
    closed_by: i64,
    shift_ids: &[i64],
    totals: &DayTotals,
) -> AppResult<i64> {
    insert_day_closing_snapshot(conn, business_day_id, closed_by, shift_ids, totals, true)
}

fn insert_day_closing_snapshot(
    conn: &Db,
    business_day_id: i64,
    closed_by: i64,
    shift_ids: &[i64],
    totals: &DayTotals,
    final_snapshot: bool,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO day_closings
          (business_day_id, closed_by, invoices_count, cafe_sales, wash_sales, subtotal,
           discounts, service_charges, total_sales, cash, card, credit, expenses, final_snapshot)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            business_day_id,
            closed_by,
            totals.invoices_count,
            totals.cafe_sales,
            totals.wash_sales,
            totals.subtotal,
            totals.discounts,
            totals.service_charges,
            totals.total_sales,
            totals.cash,
            totals.card,
            totals.credit,
            totals.expenses,
            if final_snapshot { 1 } else { 0 }
        ],
    )?;
    let closing_id = conn.last_insert_rowid();
    for shift_id in shift_ids {
        conn.execute(
            "INSERT INTO day_closing_shifts (day_closing_id, shift_id) VALUES (?1,?2)",
            params![closing_id, shift_id],
        )?;
    }
    let mut stmt = conn.prepare(
        "INSERT INTO day_closing_expenses (day_closing_id, expense_id)
         SELECT ?1, id FROM expenses WHERE business_day_id = ?2
           AND NOT EXISTS (SELECT 1 FROM day_closing_expenses dce WHERE dce.expense_id = expenses.id)",
    )?;
    stmt.execute(params![closing_id, business_day_id])?;
    Ok(closing_id)
}

pub fn settlement_history(conn: &Db, business_day_id: i64) -> AppResult<Vec<DayClosingRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, business_day_id, closed_by, closed_at, invoices_count, cafe_sales,
                wash_sales, subtotal, discounts, service_charges, total_sales, cash, card, credit, expenses
         FROM day_closings WHERE business_day_id = ?1 ORDER BY id",
    )?;
    let records = stmt
        .query_map([business_day_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                DayTotals {
                    invoices_count: r.get(4)?,
                    cafe_sales: r.get(5)?,
                    wash_sales: r.get(6)?,
                    subtotal: r.get(7)?,
                    discounts: r.get(8)?,
                    service_charges: r.get(9)?,
                    total_sales: r.get(10)?,
                    cash: r.get(11)?,
                    card: r.get(12)?,
                    credit: r.get(13)?,
                    expenses: r.get(14)?,
                },
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = Vec::with_capacity(records.len());
    for (id, business_day_id, closed_by, closed_at, totals) in records {
        let final_snapshot: bool = conn.query_row(
            "SELECT final_snapshot FROM day_closings WHERE id = ?1",
            [id],
            |r| r.get(0),
        )?;
        let mut ids = conn.prepare(
            "SELECT shift_id FROM day_closing_shifts WHERE day_closing_id = ?1 ORDER BY shift_id",
        )?;
        let shift_ids = ids
            .query_map([id], |r| r.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        out.push(DayClosingRecord {
            id,
            business_day_id,
            closed_by,
            closed_at,
            shift_ids,
            totals,
            final_snapshot,
        });
    }
    Ok(out)
}

/// Historical closed days are read from the final immutable snapshot, not
/// recalculated from mutable live expenses or orders.
pub fn closed_business_days(
    conn: &Db,
    from: Option<&str>,
    to: Option<&str>,
) -> AppResult<Vec<ClosedBusinessDayReport>> {
    let mut sql = String::from(
        "SELECT d.id, d.day_date, d.status, d.opened_at, d.closed_at,
                c.id, c.closed_by,
                (SELECT COUNT(*) FROM shifts s WHERE s.business_day_id = d.id),
                c.invoices_count, c.cafe_sales, c.wash_sales, c.subtotal,
                c.discounts, c.service_charges, c.total_sales, c.cash, c.card,
                c.credit, c.expenses
         FROM business_days d JOIN day_closings c ON c.business_day_id = d.id
          AND c.final_snapshot = 1
         WHERE d.status = 'CLOSED'",
    );
    if from.is_some() {
        sql.push_str(" AND d.day_date >= ?1");
    }
    if to.is_some() {
        sql.push_str(" AND d.day_date <= ?2");
    }
    sql.push_str(" ORDER BY d.id DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        rusqlite::params_from_iter([from, to].into_iter().flatten()),
        |r| {
            Ok(ClosedBusinessDayReport {
                business_day_id: r.get(0)?,
                day_date: r.get(1)?,
                status: r.get(2)?,
                opened_at: r.get(3)?,
                closed_at: r.get(4)?,
                closing_id: r.get(5)?,
                closed_by: r.get(6)?,
                shift_count: r.get(7)?,
                totals: DayTotals {
                    invoices_count: r.get(8)?,
                    cafe_sales: r.get(9)?,
                    wash_sales: r.get(10)?,
                    subtotal: r.get(11)?,
                    discounts: r.get(12)?,
                    service_charges: r.get(13)?,
                    total_sales: r.get(14)?,
                    cash: r.get(15)?,
                    card: r.get(16)?,
                    credit: r.get(17)?,
                    expenses: r.get(18)?,
                },
            })
        },
    )?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn closed_shifts(conn: &Db, from: Option<&str>, to: Option<&str>) -> AppResult<Vec<ShiftRow>> {
    // `from`/`to` are Station BUSINESS dates, but `closed_at` is an instant. The
    // filter is therefore resolved to a half-open range of instants in the
    // business timezone. Previously this compared `date(s.closed_at)` — the UTC
    // date — against a Cairo business date, which misfiled any shift that
    // closed either side of midnight.
    let span = crate::time::business_date_span(from, to);
    let mut sql = format!("SELECT {SHIFT_COLS} FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.status = 'CLOSED'");
    let mut args: Vec<String> = Vec::new();
    if let Some(span) = span.as_ref() {
        if !span.start_inclusive.is_empty() {
            args.push(span.start_inclusive.clone());
            sql.push_str(&format!(" AND s.closed_at >= ?{}", args.len()));
        }
        if let Some(end) = span.end_exclusive.as_ref() {
            args.push(end.clone());
            sql.push_str(&format!(" AND s.closed_at < ?{}", args.len()));
        }
    }
    sql.push_str(" ORDER BY s.closed_at DESC, s.id DESC");
    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(refs.as_slice(), shift_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn final_day_totals(conn: &Db, day_id: i64) -> AppResult<Option<DayTotals>> {
    Ok(conn.query_row("SELECT invoices_count, cafe_sales, wash_sales, subtotal, discounts, service_charges, total_sales, cash, card, credit, expenses FROM day_closings WHERE business_day_id = ?1 AND final_snapshot = 1", [day_id], |r| Ok(DayTotals { invoices_count: r.get(0)?, cafe_sales: r.get(1)?, wash_sales: r.get(2)?, subtotal: r.get(3)?, discounts: r.get(4)?, service_charges: r.get(5)?, total_sales: r.get(6)?, cash: r.get(7)?, card: r.get(8)?, credit: r.get(9)?, expenses: r.get(10)? })).ok())
}
