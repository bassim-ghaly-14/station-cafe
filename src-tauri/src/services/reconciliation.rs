//! THE authoritative financial report for closing documents.
//!
//! Every number a shift-closing or day-closing document shows is computed here,
//! once, from the persisted closing snapshot. The POS screen, the print preview
//! and the ESC/POS output all read THIS struct, so a figure can never be
//! calculated one way on screen and another way on paper.
//!
//! Nothing in `repositories` or in React recomputes a total that appears here.

use crate::error::AppResult;
use crate::repositories::expenses::{self, BreakdownRow};
use crate::repositories::shifts::{self, ShiftRow};
use crate::repositories::Db;
use serde::Serialize;

/// Semantic result of comparing handed-over cash with expected cash.
///
/// This is deliberately a three-way state, not a signed number: a shortage and a
/// surplus are different business facts and the document must never label one
/// as the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CashStatus {
    Balanced,
    Shortage,
    Surplus,
}

impl CashStatus {
    /// Classify `actual - expected`: equal is balanced, negative is a shortage,
    /// positive is a surplus.
    pub fn of(difference: i64) -> Self {
        match difference.cmp(&0) {
            std::cmp::Ordering::Equal => CashStatus::Balanced,
            std::cmp::Ordering::Less => CashStatus::Shortage,
            std::cmp::Ordering::Greater => CashStatus::Surplus,
        }
    }
}

/// The cash-drawer reconciliation block, shared verbatim by the shift and the
/// day document so the two can never disagree about the arithmetic.
#[derive(Debug, Clone, Serialize)]
pub struct CashReconciliation {
    /// Cash the drawer started with.
    pub opening_cash: i64,
    /// Cash that physically came in (CASH payments only).
    pub cash_inflows: i64,
    /// Cash expenses that physically left the drawer.
    pub cash_outflows: i64,
    /// `opening_cash + cash_inflows - cash_outflows`.
    pub expected_cash: i64,
    /// Cash the cashier actually handed over.
    pub actual_cash: i64,
    /// `actual_cash - expected_cash` (signed).
    pub difference: i64,
    /// `expected_cash - actual_cash`, zero when there is no shortage.
    pub shortage: i64,
    /// `actual_cash - expected_cash`, zero when there is no surplus.
    pub surplus: i64,
    pub status: CashStatus,
}

/// The drawer formula, in one place: `opening + cash in − cash out`.
///
/// Exposed as a free function so the live POS hydration and the closing write
/// both resolve the same expression, instead of each restating it.
pub fn expected_cash(opening_cash: i64, cash_inflows: i64, cash_outflows: i64) -> i64 {
    opening_cash + cash_inflows - cash_outflows
}

impl CashReconciliation {
    /// THE single drawer formula. Every caller — shift close, day close and the
    /// live preview — goes through here, so there is exactly one definition:
    ///
    ///   expected = opening cash + CASH inflows − CASH outflows
    ///
    /// Card and credit never appear here: they never touch the till, so
    /// counting them would inflate the expected drawer.
    pub fn build(opening_cash: i64, cash_inflows: i64, cash_outflows: i64, actual: i64) -> Self {
        let expected_cash = expected_cash(opening_cash, cash_inflows, cash_outflows);
        let difference = actual - expected_cash;
        Self {
            opening_cash,
            cash_inflows,
            cash_outflows,
            expected_cash,
            actual_cash: actual,
            difference,
            shortage: (-difference).max(0),
            surplus: difference.max(0),
            status: CashStatus::of(difference),
        }
    }
}

/// Invoice counts by business area. The three counts are mutually exclusive, so
/// `cafe + wash + hybrid == invoices_count` always holds.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct AreaBreakdown {
    pub cafe_invoices: i64,
    pub wash_invoices: i64,
    pub hybrid_invoices: i64,
}

/// The full shift-closing report: sales, services & discounts, expenses, and the
/// handover reconciliation.
#[derive(Debug, Clone, Serialize)]
pub struct ShiftReconciliation {
    pub shift: ShiftRow,
    pub areas: AreaBreakdown,
    pub invoices_count: i64,
    pub cafe_sales: i64,
    pub wash_sales: i64,
    pub subtotal: i64,
    pub discounts: i64,
    /// The invoice-level service charge (`invoices.service_charge`), which is
    /// NOT the same thing as services sold as catalog items.
    pub service_charges: i64,
    pub total_sales: i64,
    pub cash_sales: i64,
    pub card_sales: i64,
    pub credit_sales: i64,
    pub expenses: i64,
    pub cash_expenses: i64,
    pub expense_breakdown: Vec<BreakdownRow>,
    /// The shift's own table lifecycle: sessions opened during it, and the ones
    /// closed without an order.
    ///
    /// It is a read of the persisted `table_sessions` rows through their
    /// `shift_id`, so it is reproducible for a shift that has already closed and
    /// needs no column of its own on `shifts`.
    pub tables: crate::repositories::pos::TableCounters,
    pub cash: CashReconciliation,
}

/// Build the shift report.
///
/// A CLOSED shift is served from its immutable persisted snapshot and is never
/// recomputed, which is what keeps historical documents reproducible — including
/// its expense figures and its category breakdown. An ACTIVE shift has no
/// snapshot yet, so the same figures are hydrated live by
/// `hydrate_active_totals` — the very helpers `close_shift` persists from.
pub fn shift_report(conn: &Db, shift_id: i64) -> AppResult<ShiftReconciliation> {
    let mut shift = shifts::get_shift(conn, shift_id)?
        .ok_or_else(|| crate::error::AppError::not_found("shift.not_found"))?;
    shifts::hydrate_active_totals(conn, &mut shift)?;
    // There is exactly ONE source for a shift's expenses: the closing snapshot
    // once the shift is closed, and the shift's own live rows while it is still
    // open. Reading a closed shift's expenses with a live query would be a
    // SECOND implementation of the same figure, and it would let a later change
    // to an expense row move a document that was already issued.
    let (expenses, cash_expenses, expense_breakdown) = if shift.status == "ACTIVE" {
        let (total, cash) = expenses::shift_totals(conn, shift_id)?;
        (total, cash, expenses::breakdown_for_shift(conn, shift_id)?)
    } else {
        (
            shift.expenses,
            shift.cash_expenses,
            shifts::shift_breakdown(conn, shift_id)?,
        )
    };
    Ok(ShiftReconciliation {
        areas: AreaBreakdown {
            cafe_invoices: shift.cafe_invoices,
            wash_invoices: shift.wash_invoices,
            hybrid_invoices: shift.hybrid_invoices,
        },
        // The table lifecycle is read for BOTH shift states from the same
        // persisted rows: those rows are immutable once a session closes, so an
        // ACTIVE shift's live read and a CLOSED shift's replay return the same
        // numbers. There is deliberately no second, snapshot copy of them.
        tables: crate::repositories::pos::shift_lifecycle_counts(conn, shift_id)?,
        invoices_count: shift.invoices_count,
        cafe_sales: shift.cafe_sales,
        wash_sales: shift.wash_sales,
        subtotal: shift.subtotal,
        discounts: shift.discounts,
        service_charges: shift.service_charges,
        total_sales: shift.total_sales,
        cash_sales: shift.cash_sales,
        card_sales: shift.card_sales,
        credit_sales: shift.credit_sales,
        expenses,
        cash_expenses,
        expense_breakdown,
        cash: CashReconciliation::build(
            shift.opening_cash,
            shift.cash_sales,
            cash_expenses,
            shift.actual_cash.unwrap_or(0),
        ),
        shift,
    })
}

/// The day-closing report, aggregated from the INCLUDED settled shifts only.
#[derive(Debug, Clone, Serialize)]
pub struct DayReconciliation {
    pub day: shifts::BusinessDay,
    pub areas: AreaBreakdown,
    pub shift_count: i64,
    /// Shifts that were still open and therefore excluded from this closing.
    pub open_shift_count: i64,
    pub invoices_count: i64,
    pub cafe_sales: i64,
    pub wash_sales: i64,
    pub subtotal: i64,
    pub discounts: i64,
    pub service_charges: i64,
    pub total_sales: i64,
    pub cash_sales: i64,
    pub card_sales: i64,
    pub credit_sales: i64,
    pub expenses: i64,
    pub cash_expenses: i64,
    pub expense_breakdown: Vec<BreakdownRow>,
    pub cash: CashReconciliation,
    /// The shifts this closing was built from, in operational order.
    pub included_shift_ids: Vec<i64>,
    pub shifts: Vec<ShiftRow>,
}

/// Aggregate a day closing from exactly the shifts the caller included.
///
/// The caller is the SERVICE, which has already applied the inclusion rule
/// (settled shifts of this business day only). This function therefore trusts
/// `shift_ids` completely and sums only those rows' immutable snapshots, which
/// is what makes an open shift impossible to leak in and an expense impossible
/// to count twice: an expense belongs to one shift, and one shift is in the
/// list at most once.
///
/// Every shift passed here is CLOSED — both callers (`day_close_preview` and
/// `close_day`) select on `status = 'CLOSED'` — so each row's `expenses` and
/// `cash_expenses` columns and its stored breakdown ARE its closing snapshot.
/// Summing those is what keeps the day report reproduced from exactly the
/// numbers the individual shift documents show.
pub fn aggregate_day(
    conn: &Db,
    day: shifts::BusinessDay,
    shift_ids: &[i64],
    rows: &[ShiftRow],
) -> AppResult<DayReconciliation> {
    let sum = |f: fn(&ShiftRow) -> i64| rows.iter().map(f).sum::<i64>();
    // The day's own (shift-less) expenses belong to the DAY, so they are part of
    // the day's expense total and its breakdown — but they belong to no drawer,
    // so they deliberately do NOT enter `cash_expenses` and can never change a
    // drawer's expected cash. Without this they were claimed by the closing and
    // then silently dropped from its report.
    let (day_expenses, _day_cash) = expenses::day_level_totals(conn, day.id)?;
    let shift_expenses = sum(|s| s.expenses);
    let cash_expenses = sum(|s| s.cash_expenses);
    let expenses_total = shift_expenses + day_expenses;
    // One set per INCLUDED shift, plus the day's own shift-less expenses. The
    // sets are disjoint by construction, so a category can never be summed twice.
    let mut sets: Vec<Vec<BreakdownRow>> = Vec::with_capacity(rows.len() + 1);
    for shift in rows {
        sets.push(shifts::shift_breakdown(conn, shift.id)?);
    }
    sets.push(expenses::day_level_breakdown(conn, day.id)?);
    let expense_breakdown = expenses::merge_breakdown_sets(sets);
    let opening_cash = sum(|s| s.opening_cash);
    let cash_inflows = sum(|s| s.cash_sales);
    let actual_cash = sum(|s| s.actual_cash.unwrap_or(0));
    Ok(DayReconciliation {
        areas: AreaBreakdown {
            cafe_invoices: sum(|s| s.cafe_invoices),
            wash_invoices: sum(|s| s.wash_invoices),
            hybrid_invoices: sum(|s| s.hybrid_invoices),
        },
        shift_count: rows.len() as i64,
        open_shift_count: 0,
        invoices_count: sum(|s| s.invoices_count),
        cafe_sales: sum(|s| s.cafe_sales),
        wash_sales: sum(|s| s.wash_sales),
        subtotal: sum(|s| s.subtotal),
        discounts: sum(|s| s.discounts),
        service_charges: sum(|s| s.service_charges),
        total_sales: sum(|s| s.total_sales),
        cash_sales: cash_inflows,
        card_sales: sum(|s| s.card_sales),
        credit_sales: sum(|s| s.credit_sales),
        expenses: expenses_total,
        cash_expenses,
        expense_breakdown,
        cash: CashReconciliation::build(opening_cash, cash_inflows, cash_expenses, actual_cash),
        included_shift_ids: shift_ids.to_vec(),
        shifts: rows.to_vec(),
        day,
    })
}
