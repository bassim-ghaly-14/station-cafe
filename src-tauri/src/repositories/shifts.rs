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
    // Closing-snapshot extensions: invoice counts per business area and the
    // money totals the reconciliation document shows.
    pub cafe_invoices: i64,
    pub wash_invoices: i64,
    pub hybrid_invoices: i64,
    pub subtotal: i64,
    pub total_sales: i64,
    /// Money of the CAFE lines on this shift's invoices.
    pub cafe_sales: i64,
    /// Money of the WASH lines on this shift's invoices.
    pub wash_sales: i64,
    /// Every expense booked to this shift.
    pub expenses: i64,
    /// The part of those expenses physically paid from the drawer.
    pub cash_expenses: i64,
    /// The authenticated user who closed the shift (`users.id`).
    /// `user_id` stays the owner (cashier); this is the actor.
    /// `None` for shifts closed before migration 36.
    pub closed_by: Option<i64>,
    /// Display name of the closer, if known.
    pub closed_by_name: Option<String>,
}

const SHIFT_COLS: &str = "s.id, s.business_day_id, s.user_id, u.name, u.role, s.status, s.opened_at,
    s.opening_cash, s.closed_at, s.cash_sales, s.card_sales, s.credit_sales,
    s.service_charges, s.discounts, s.invoices_count, s.expected_cash, s.actual_cash, s.cash_difference,
    s.cafe_invoices, s.wash_invoices, s.hybrid_invoices, s.subtotal, s.total_sales,
    s.cafe_sales, s.wash_sales, s.expenses, s.cash_expenses, s.closed_by, cb.name";

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
        cafe_invoices: r.get(18)?,
        wash_invoices: r.get(19)?,
        hybrid_invoices: r.get(20)?,
        subtotal: r.get(21)?,
        total_sales: r.get(22)?,
        cafe_sales: r.get(23)?,
        wash_sales: r.get(24)?,
        expenses: r.get(25)?,
        cash_expenses: r.get(26)?,
        closed_by: r.get(27)?,
        closed_by_name: r.get(28)?,
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

/// Whole-day aggregation for the LIVE operational view.
///
/// THIS IS NOT A CLOSING FUNCTION. It deliberately counts the WHOLE business
/// day regardless of shift status, so an open shift's invoices are included.
/// Using it to build a day closing is exactly the leak that
/// `services::shifts::close_day` no longer commits: a closing must aggregate
/// only the settled shifts, which is what `settlement_totals` and
/// `aggregate_day` do.
///
/// It survives for the read-only `today_summary` header, which is a glance at
/// today's activity rather than a financial result.
///
/// Every per-method figure — cash, card AND credit — comes from the PAYMENT
/// ROWS, the same single rule the shift and day closings persist. An earlier
/// version derived credit from `invoices.status = 'CREDIT'` instead, which was
/// a second expression of the same business fact living beside the first: the
/// two coincide only while `paid_amount` is never touched for a credit invoice.
/// One rule, one place.
pub fn day_totals(conn: &Db, day_id: i64) -> AppResult<DayTotals> {
    Ok(conn.query_row(
        "SELECT
            COUNT(*),
            COALESCE(SUM(i.cafe_total), 0),
            COALESCE(SUM(i.wash_total), 0),
            COALESCE(SUM(i.subtotal), 0),
            COALESCE(SUM(i.discount_minor), 0),
            COALESCE(SUM(i.service_charge), 0),
            COALESCE(SUM(i.total), 0),
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN invoices i2 ON i2.id = p.invoice_id
              WHERE i2.business_day_id = ?1 AND p.method = 'CASH'),
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN invoices i2 ON i2.id = p.invoice_id
              WHERE i2.business_day_id = ?1 AND p.method = 'CARD'),
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN invoices i2 ON i2.id = p.invoice_id
              WHERE i2.business_day_id = ?1 AND p.method = 'CREDIT'),
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
        "SELECT {SHIFT_COLS} FROM shifts s JOIN users u ON u.id = s.user_id LEFT JOIN users cb ON cb.id = s.closed_by
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
        "SELECT {SHIFT_COLS} FROM shifts s JOIN users u ON u.id = s.user_id LEFT JOIN users cb ON cb.id = s.closed_by
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
        "SELECT {SHIFT_COLS} FROM shifts s JOIN users u ON u.id = s.user_id LEFT JOIN users cb ON cb.id = s.closed_by
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
        "SELECT {SHIFT_COLS} FROM shifts s JOIN users u ON u.id = s.user_id LEFT JOIN users cb ON cb.id = s.closed_by WHERE s.id = ?1"
    ))?;
    let mut rows = stmt.query([shift_id])?;
    match rows.next()? {
        Some(r) => Ok(Some(shift_row(r)?)),
        None => Ok(None),
    }
}

/// Compute one shift's closing aggregates from its invoices + payments.
///
/// INVOICES and PAYMENTS are aggregated in SEPARATE subqueries. The previous
/// version joined them in one pass, so an invoice carrying more than one payment
/// row was counted once per payment: the invoice COUNT, the service charge, the
/// discount and the subtotal were all silently multiplied. Money per method
/// still comes from `payments`; everything that is a property of the INVOICE
/// comes from `invoices`.
///
pub fn compute_shift_totals(conn: &Db, shift_id: i64) -> AppResult<ShiftTotals> {
    Ok(conn.query_row(
        "SELECT
            (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
               JOIN invoices i ON i.id = p.invoice_id
              WHERE i.shift_id = ?1 AND p.method = 'CASH'),
            (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
               JOIN invoices i ON i.id = p.invoice_id
              WHERE i.shift_id = ?1 AND p.method = 'CARD'),
            (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
               JOIN invoices i ON i.id = p.invoice_id
              WHERE i.shift_id = ?1 AND p.method = 'CREDIT'),
            (SELECT COALESCE(SUM(i.service_charge), 0) FROM invoices i
              WHERE i.shift_id = ?1),
            (SELECT COALESCE(SUM(i.discount_minor), 0) FROM invoices i
              WHERE i.shift_id = ?1),
            (SELECT COALESCE(SUM(i.subtotal), 0) FROM invoices i
              WHERE i.shift_id = ?1),
            (SELECT COALESCE(SUM(i.total), 0) FROM invoices i
              WHERE i.shift_id = ?1),
            (SELECT COUNT(*) FROM invoices i
              WHERE i.shift_id = ?1),
            -- Area counts are MUTUALLY EXCLUSIVE, derived from the DEPARTMENTS the
            -- invoice actually carries (its persisted lines), not from money. A
            -- free (zero-priced) cafe line therefore still makes the document a
            -- cafe invoice, and a service-charge-only invoice can never fall out
            -- of all three buckets. With `cafe` = has-a-CAFE-line and
            -- `wash` = has-a-WASH-line, the three buckets partition every
            -- invoice that has at least one line:
            --     hybrid = cafe ∧ wash
            --     cafe   = cafe ∧ ¬wash
            --     wash   = ¬cafe
            -- so `cafe + wash + hybrid = invoices_count` holds for every dataset
            -- and a hybrid document is still counted exactly once.
            (SELECT COUNT(*) FROM invoices i
              WHERE i.shift_id = ?1
                AND EXISTS (SELECT 1 FROM invoice_lines l
                             WHERE l.invoice_id = i.id AND l.department = 'CAFE')
                AND EXISTS (SELECT 1 FROM invoice_lines l
                             WHERE l.invoice_id = i.id AND l.department = 'WASH')),
            (SELECT COUNT(*) FROM invoices i
              WHERE i.shift_id = ?1
                AND EXISTS (SELECT 1 FROM invoice_lines l
                             WHERE l.invoice_id = i.id AND l.department = 'CAFE')
                AND NOT EXISTS (SELECT 1 FROM invoice_lines l
                                 WHERE l.invoice_id = i.id AND l.department = 'WASH')),
            (SELECT COUNT(*) FROM invoices i
              WHERE i.shift_id = ?1
                AND NOT EXISTS (SELECT 1 FROM invoice_lines l
                                 WHERE l.invoice_id = i.id AND l.department = 'CAFE')),
            -- The money itself still splits per department exactly as before:
            -- a hybrid invoice contributes to BOTH cafe_sales and wash_sales,
            -- because those are sums of line totals, not counts.
            (SELECT COALESCE(SUM(i.cafe_total), 0) FROM invoices i
              WHERE i.shift_id = ?1),
            (SELECT COALESCE(SUM(i.wash_total), 0) FROM invoices i
              WHERE i.shift_id = ?1)",
        [shift_id],
        |r| {
            Ok(ShiftTotals {
                cash: r.get(0)?,
                card: r.get(1)?,
                credit: r.get(2)?,
                service_charges: r.get(3)?,
                discounts: r.get(4)?,
                subtotal: r.get(5)?,
                total_sales: r.get(6)?,
                invoices_count: r.get(7)?,
                hybrid_invoices: r.get(8)?,
                cafe_invoices: r.get(9)?,
                wash_invoices: r.get(10)?,
                cafe_sales: r.get(11)?,
                wash_sales: r.get(12)?,
            })
        },
    )?)
}

/// Every aggregate a shift closing persists, computed in one pass.
#[derive(Debug, Clone, Copy, Default)]
pub struct ShiftTotals {
    pub cash: i64,
    pub card: i64,
    pub credit: i64,
    pub service_charges: i64,
    pub discounts: i64,
    pub subtotal: i64,
    pub total_sales: i64,
    pub invoices_count: i64,
    pub hybrid_invoices: i64,
    pub cafe_invoices: i64,
    pub wash_invoices: i64,
    pub cafe_sales: i64,
    pub wash_sales: i64,
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
    let t = compute_shift_totals(conn, shift.id)?;
    shift.cash_sales = t.cash;
    shift.card_sales = t.card;
    shift.credit_sales = t.credit;
    shift.service_charges = t.service_charges;
    shift.discounts = t.discounts;
    shift.invoices_count = t.invoices_count;
    shift.cafe_invoices = t.cafe_invoices;
    shift.wash_invoices = t.wash_invoices;
    shift.hybrid_invoices = t.hybrid_invoices;
    shift.subtotal = t.subtotal;
    shift.total_sales = t.total_sales;
    shift.cafe_sales = t.cafe_sales;
    shift.wash_sales = t.wash_sales;
    // Cash expenses booked to THIS shift reduce THIS shift's drawer.
    let (expenses, cash_expenses) = crate::repositories::expenses::shift_totals(conn, shift.id)?;
    shift.expenses = expenses;
    shift.cash_expenses = cash_expenses;
    // The drawer formula comes from the ONE shared definition, so the live POS
    // card can never state a different expected cash than the closing dialog
    // and the persisted snapshot produced from the same inputs.
    shift.expected_cash =
        crate::services::reconciliation::expected_cash(shift.opening_cash, t.cash, cash_expenses);
    Ok(())
}

/// Persist the closing snapshot. This is the ONLY writer of a shift's
/// aggregates, and it is called once, inside the closing transaction, so the
/// figures a closed shift reports are fixed for good.
///
/// `closed_by` is the authenticated actor performing the close — the owner
/// for a self-close, the ADMIN/MANAGER for a managerial close. The UPDATE is
/// guarded on `status = 'ACTIVE'` and returns whether it won the race, so a
/// concurrent close of the same shift yields exactly one winner.
#[allow(clippy::too_many_arguments)]
pub fn save_shift_closing(
    conn: &Db,
    shift_id: i64,
    totals: &ShiftTotals,
    expenses: i64,
    cash_expenses: i64,
    expected_cash: i64,
    actual_cash: i64,
    closed_at: &str,
    expense_breakdown: &str,
    closed_by: i64,
) -> AppResult<bool> {
    let n = conn.execute(
        "UPDATE shifts SET status = 'CLOSED', closed_at = ?10,
            cash_sales = ?2, card_sales = ?3, credit_sales = ?4, service_charges = ?5,
            discounts = ?6, invoices_count = ?7, expected_cash = ?8,
            actual_cash = ?9, cash_difference = ?9 - ?8,
            cafe_invoices = ?11, wash_invoices = ?12, hybrid_invoices = ?13,
            subtotal = ?14, total_sales = ?15, cafe_sales = ?18, wash_sales = ?19,
            expenses = ?16, cash_expenses = ?17, expense_breakdown = ?20,
            closed_by = ?21
         WHERE id = ?1 AND status = 'ACTIVE'",
        params![
            shift_id,
            totals.cash,
            totals.card,
            totals.credit,
            totals.service_charges,
            totals.discounts,
            totals.invoices_count,
            expected_cash,
            actual_cash,
            closed_at,
            totals.cafe_invoices,
            totals.wash_invoices,
            totals.hybrid_invoices,
            totals.subtotal,
            totals.total_sales,
            expenses,
            cash_expenses,
            totals.cafe_sales,
            totals.wash_sales,
            expense_breakdown,
            closed_by
        ],
    )?;
    Ok(n == 1)
}

/// The CLOSING SNAPSHOT of one shift's per-category expense lines.
///
/// A closed shift is reported from this stored value, never from a live query
/// over `expenses`: the document a cashier signed must not change if anything
/// happens to an expense row afterwards.
pub fn shift_breakdown(
    conn: &Db,
    shift_id: i64,
) -> AppResult<Vec<crate::repositories::expenses::BreakdownRow>> {
    let raw: String = conn.query_row(
        "SELECT expense_breakdown FROM shifts WHERE id = ?1",
        [shift_id],
        |r| r.get(0),
    )?;
    Ok(crate::repositories::expenses::decode_breakdown(&raw))
}

pub fn shifts_of_day(conn: &Db, day_id: i64) -> AppResult<Vec<ShiftRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SHIFT_COLS} FROM shifts s JOIN users u ON u.id = s.user_id LEFT JOIN users cb ON cb.id = s.closed_by
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

/// Unsettled orders still attached to one shift. A shift cannot be closed while
/// these exist: money could still be taken against a drawer that was counted.
pub fn open_orders_in_shift(conn: &Db, shift_id: i64) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM orders WHERE shift_id = ?1 AND status IN ('OPEN','READY_TO_PAY')",
        [shift_id],
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
        "SELECT {SHIFT_COLS} FROM shifts s JOIN users u ON u.id = s.user_id LEFT JOIN users cb ON cb.id = s.closed_by
         WHERE s.business_day_id = ?1 AND s.status = 'CLOSED'
           AND NOT EXISTS (SELECT 1 FROM day_closing_shifts dcs WHERE dcs.shift_id = s.id)
         ORDER BY s.opened_at, s.id"
    ))?;
    let rows = stmt.query_map([day_id], shift_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Settlement totals for exactly the supplied shift ids.
///
/// EXPENSES ARE ATTRIBUTED BY SHIFT, not by day. The previous version summed
/// every day expense that had not yet been claimed by a checkpoint, so an
/// expense booked during shift 1 could be reported by a settlement covering only
/// shift 2. Now an expense enters a settlement through its own shift's snapshot,
/// which is what makes "included exactly once" true by construction. Day-level
/// expenses that belong to no shift are deliberately NOT included here: they are
/// not part of any drawer's reconciliation and are claimed once at day close.
pub fn settlement_totals(conn: &Db, _day_id: i64, shift_ids: &[i64]) -> AppResult<DayTotals> {
    if shift_ids.is_empty() {
        return Ok(DayTotals::default());
    }
    let placeholders = std::iter::repeat("?")
        .take(shift_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    // INVOICES and PAYMENTS are aggregated in SEPARATE subqueries for the same
    // reason as `compute_shift_totals`: a joined pass multiplies every
    // invoice-level figure by the number of payment rows.
    let sql = format!(
        "SELECT
          (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN invoices i ON i.id = p.invoice_id
            WHERE i.shift_id IN ({placeholders}) AND p.method = 'CASH'),
          (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN invoices i ON i.id = p.invoice_id
            WHERE i.shift_id IN ({placeholders}) AND p.method = 'CARD'),
          (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN invoices i ON i.id = p.invoice_id
            WHERE i.shift_id IN ({placeholders}) AND p.method = 'CREDIT'),
          (SELECT COALESCE(SUM(i.cafe_total),0) FROM invoices i
            WHERE i.shift_id IN ({placeholders})),
          (SELECT COALESCE(SUM(i.wash_total),0) FROM invoices i
            WHERE i.shift_id IN ({placeholders})),
          (SELECT COALESCE(SUM(i.subtotal),0) FROM invoices i
            WHERE i.shift_id IN ({placeholders})),
          (SELECT COALESCE(SUM(i.discount_minor),0) FROM invoices i
            WHERE i.shift_id IN ({placeholders})),
          (SELECT COALESCE(SUM(i.service_charge),0) FROM invoices i
            WHERE i.shift_id IN ({placeholders})),
          (SELECT COALESCE(SUM(i.total),0) FROM invoices i
            WHERE i.shift_id IN ({placeholders})),
          (SELECT COUNT(*) FROM invoices i
            WHERE i.shift_id IN ({placeholders})),
          (SELECT COALESCE(SUM(e.amount),0) FROM expenses e WHERE e.shift_id IN ({placeholders}))"
    );
    // Each placeholder group repeats the id list, so bind it once per group.
    let values: Vec<&dyn rusqlite::ToSql> = shift_ids
        .iter()
        .map(|id| id as &dyn rusqlite::ToSql)
        .collect();
    let mut bound: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(values.len() * 11);
    for _ in 0..11 {
        bound.extend_from_slice(&values);
    }
    Ok(conn.query_row(&sql, bound.as_slice(), |r| {
        Ok(DayTotals {
            cash: r.get(0)?,
            card: r.get(1)?,
            credit: r.get(2)?,
            cafe_sales: r.get(3)?,
            wash_sales: r.get(4)?,
            subtotal: r.get(5)?,
            discounts: r.get(6)?,
            service_charges: r.get(7)?,
            total_sales: r.get(8)?,
            invoices_count: r.get(9)?,
            expenses: r.get(10)?,
        })
    })?)
}

/// The extra reconciliation columns persisted on the immutable day closing.
///
/// These are stored (not recomputed) so a closed business day always reports
/// the figures that were true at closing time, whatever happens to the
/// underlying expenses or configuration afterwards.
#[derive(Debug, Clone, Copy, Default)]
pub struct DayClosingSnapshot {
    pub cafe_invoices: i64,
    pub wash_invoices: i64,
    pub hybrid_invoices: i64,
    pub shift_count: i64,
    pub opening_cash: i64,
    pub cash_expenses: i64,
    pub expected_cash: i64,
    pub actual_cash: i64,
    pub shortage: i64,
    pub surplus: i64,
}

/// Insert a settlement snapshot and relationships in the caller's transaction.
pub fn insert_day_closing(
    conn: &Db,
    business_day_id: i64,
    closed_by: i64,
    shift_ids: &[i64],
    totals: &DayTotals,
) -> AppResult<i64> {
    insert_day_closing_snapshot(
        conn,
        business_day_id,
        closed_by,
        shift_ids,
        totals,
        &DayClosingSnapshot::default(),
        "[]",
        false,
    )
}

/// Insert the one final, immutable report snapshot for a business day. The
/// settlement relationships remain one-per-shift in the incremental table;
/// this final row is a complete day report and is identified by `final_snapshot`.
#[allow(clippy::too_many_arguments)]
pub fn insert_final_day_closing(
    conn: &Db,
    business_day_id: i64,
    closed_by: i64,
    shift_ids: &[i64],
    totals: &DayTotals,
    snapshot: &DayClosingSnapshot,
    expense_breakdown: &str,
) -> AppResult<i64> {
    insert_day_closing_snapshot(
        conn,
        business_day_id,
        closed_by,
        shift_ids,
        totals,
        snapshot,
        expense_breakdown,
        true,
    )
}

#[allow(clippy::too_many_arguments)]
fn insert_day_closing_snapshot(
    conn: &Db,
    business_day_id: i64,
    closed_by: i64,
    shift_ids: &[i64],
    totals: &DayTotals,
    snapshot: &DayClosingSnapshot,
    expense_breakdown: &str,
    final_snapshot: bool,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO day_closings
          (business_day_id, closed_by, invoices_count, cafe_sales, wash_sales, subtotal,
           discounts, service_charges, total_sales, cash, card, credit, expenses, final_snapshot,
           cafe_invoices, wash_invoices, hybrid_invoices, shift_count, opening_cash,
           cash_expenses, expected_cash, actual_cash, shortage, surplus, expense_breakdown)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)",
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
            if final_snapshot { 1 } else { 0 },
            snapshot.cafe_invoices,
            snapshot.wash_invoices,
            snapshot.hybrid_invoices,
            snapshot.shift_count,
            snapshot.opening_cash,
            snapshot.cash_expenses,
            snapshot.expected_cash,
            snapshot.actual_cash,
            snapshot.shortage,
            snapshot.surplus,
            expense_breakdown
        ],
    )?;
    let closing_id = conn.last_insert_rowid();
    for shift_id in shift_ids {
        // `day_closing_shifts.shift_id` is UNIQUE on purpose: a shift may be
        // settled exactly once in the whole application. The FINAL closing
        // therefore re-lists shifts that an earlier checkpoint already claimed,
        // and those links are simply kept rather than duplicated. Reading a
        // day's included shifts is the union of its closings' links, which is
        // exactly the set of shifts settled on that day.
        conn.execute(
            "INSERT OR IGNORE INTO day_closing_shifts (day_closing_id, shift_id)
             VALUES (?1,?2)",
            params![closing_id, shift_id],
        )?;
    }
    // Day-level expenses that belong to no shift are claimed by the first
    // checkpoint that sees them, so a later checkpoint cannot report them again.
    claim_unassigned_day_expenses(conn, business_day_id, closing_id)?;
    Ok(closing_id)
}

/// Associate a business day's shift-less expenses with one closing, exactly
/// once. `day_closing_expenses.expense_id` is UNIQUE, so the NOT EXISTS guard
/// makes this idempotent: re-running it can never double-count an expense.
pub fn claim_unassigned_day_expenses(
    conn: &Db,
    business_day_id: i64,
    closing_id: i64,
) -> AppResult<()> {
    let mut stmt = conn.prepare(
        "INSERT INTO day_closing_expenses (day_closing_id, expense_id)
         SELECT ?1, id FROM expenses WHERE business_day_id = ?2 AND shift_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM day_closing_expenses dce WHERE dce.expense_id = expenses.id)",
    )?;
    stmt.execute(params![closing_id, business_day_id])?;
    Ok(())
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
                -- The shifts this closing ACTUALLY included, not every shift the
                -- day ever had: an open shift was excluded by the inclusion rule
                -- and must not inflate the reported shift count.
                c.shift_count,
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
    let mut sql = format!("SELECT {SHIFT_COLS} FROM shifts s JOIN users u ON u.id = s.user_id LEFT JOIN users cb ON cb.id = s.closed_by WHERE s.status = 'CLOSED'");
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

/// Rebuild a CLOSED day's report from its immutable final snapshot.
///
/// Every figure is READ from the stored closing row — nothing is recalculated
/// from invoices, expenses or settings. This is what makes a historical day
/// report immune to later configuration or data changes. The shift list is the
/// set the closing explicitly included (`day_closing_shifts`), not "whatever
/// shifts the day has now".
pub fn final_day_report(
    conn: &Db,
    day: BusinessDay,
) -> AppResult<crate::services::reconciliation::DayReconciliation> {
    let row = conn
        .query_row(
            "SELECT c.invoices_count, c.cafe_sales, c.wash_sales, c.subtotal,
                    c.discounts, c.service_charges, c.total_sales, c.cash, c.card,
                    c.credit, c.expenses, c.cafe_invoices, c.wash_invoices,
                    c.hybrid_invoices, c.shift_count, c.opening_cash, c.cash_expenses,
                    c.expected_cash, c.actual_cash, c.shortage, c.surplus, c.expense_breakdown
             FROM day_closings c
             WHERE c.business_day_id = ?1 AND c.final_snapshot = 1",
            [day.id],
            |r| {
                Ok((
                    DayTotals {
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
                    },
                    DayClosingSnapshot {
                        cafe_invoices: r.get(11)?,
                        wash_invoices: r.get(12)?,
                        hybrid_invoices: r.get(13)?,
                        shift_count: r.get(14)?,
                        opening_cash: r.get(15)?,
                        cash_expenses: r.get(16)?,
                        expected_cash: r.get(17)?,
                        actual_cash: r.get(18)?,
                        shortage: r.get(19)?,
                        surplus: r.get(20)?,
                    },
                    // The breakdown is part of the SNAPSHOT, not a live query: a
                    // closed day's category lines are the ones that were true
                    // when it closed, with the labels they had at that moment.
                    r.get::<_, String>(21)?,
                ))
            },
        )
        .map_err(|_| crate::error::AppError::not_found("day.closing_not_found"))?;
    let (totals, snap, breakdown_json) = row;

    // The included shifts are the union of the links of ALL this day's
    // closings: an incremental checkpoint may have claimed a shift earlier, and
    // the final closing re-lists it. Because a shift can be linked to exactly
    // one closing, this union is the settled set of the day, fixed at close
    // time and independent of any later shift state.
    let mut stmt = conn.prepare(
        "SELECT shift_id FROM day_closing_shifts dcs
         JOIN day_closings c ON c.id = dcs.day_closing_id
         WHERE c.business_day_id = ?1 ORDER BY shift_id",
    )?;
    let included_shift_ids = stmt
        .query_map([day.id], |r| r.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let shift_rows: Vec<ShiftRow> = included_shift_ids
        .iter()
        .filter_map(|id| get_shift(conn, *id).ok().flatten())
        .collect();
    // Anything the day still owns that the closing did not include.
    let open_shift_count =
        (shifts_of_day(conn, day.id)?.len() as i64) - included_shift_ids.len() as i64;

    // The cash block is rebuilt through the SAME `CashReconciliation::build`
    // used at close time, from the persisted inputs, so the historical document
    // and the live one can never express the arithmetic differently.
    let cash = crate::services::reconciliation::CashReconciliation::build(
        snap.opening_cash,
        totals.cash,
        snap.cash_expenses,
        snap.actual_cash,
    );
    // The category breakdown comes from the closing snapshot for the same reason
    // every other figure does: a document that was already issued must keep
    // reporting the same lines, whatever happens to `expenses` or to the category
    // table afterwards.
    let expense_breakdown = crate::repositories::expenses::decode_breakdown(&breakdown_json);

    Ok(crate::services::reconciliation::DayReconciliation {
        areas: crate::services::reconciliation::AreaBreakdown {
            cafe_invoices: snap.cafe_invoices,
            wash_invoices: snap.wash_invoices,
            hybrid_invoices: snap.hybrid_invoices,
        },
        shift_count: snap.shift_count,
        open_shift_count,
        invoices_count: totals.invoices_count,
        cafe_sales: totals.cafe_sales,
        wash_sales: totals.wash_sales,
        subtotal: totals.subtotal,
        discounts: totals.discounts,
        service_charges: totals.service_charges,
        total_sales: totals.total_sales,
        cash_sales: totals.cash,
        card_sales: totals.card,
        credit_sales: totals.credit,
        expenses: totals.expenses,
        cash_expenses: snap.cash_expenses,
        expense_breakdown,
        cash,
        included_shift_ids,
        shifts: shift_rows,
        day,
    })
}
