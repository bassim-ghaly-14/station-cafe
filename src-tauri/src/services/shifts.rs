//! Shift & business-day lifecycle service.
//! NOT_OPEN → OPEN (shift ACTIVE) → CLOSING → CLOSED; day OPEN → CLOSED.
//! All guards enforced here: double-close, close-day-with-open-shifts, etc.

use crate::error::{AppError, AppResult};
use crate::money::Money;
use crate::repositories::expenses;
use crate::repositories::pos::{self as pos_repo, TableCounters};
use crate::repositories::shifts::{
    self, BusinessDay, DayClosingRecord, DayClosingSnapshot, DayTotals, SettlementPreview, ShiftRow,
};
use crate::repositories::Db;
use crate::services::auth::User;
use crate::services::pos as pos_svc;
use crate::services::reconciliation;
use serde::Serialize;

/// Day/shift state snapshot for the POS header.
#[derive(Debug, Serialize)]
pub struct DayShiftState {
    pub day: Option<BusinessDay>,
    pub my_shift: Option<ShiftRow>,
    /// The shift that is open RIGHT NOW, whoever opened it.
    ///
    /// This is the same `shifts::any_active_shift` read that enforces the
    /// one-open-shift rule, so the POS can only ever describe the shift the
    /// backend actually has: there is no second "is a shift open" state to fall
    /// out of step with the database. It is `None` when nothing is open.
    pub open_shift: Option<ShiftRow>,
}

pub fn state(conn: &Db, actor: &User) -> AppResult<DayShiftState> {
    // The caller's ACTIVE shift is returned as a LIVE view: its aggregate
    // columns are hydrated from the transactions booked against it, because
    // those columns are only persisted when the shift closes. Without this the
    // POS closing card would read column defaults forever, and correct totals
    // would only ever appear inside the closing dialog.
    let my_shift = match shifts::active_shift_for(conn, actor.id)? {
        Some(mut shift) => {
            shifts::hydrate_active_totals(conn, &mut shift)?;
            Some(shift)
        }
        None => None,
    };
    Ok(DayShiftState {
        day: shifts::current_day(conn)?,
        my_shift,
        open_shift: shifts::any_active_shift(conn)?,
    })
}

/// The shift open RIGHT NOW as a live view — the same hydrated read the
/// closing dialog needs — for the managerial recovery flow. MANAGER+ only
/// (the command and this service both refuse STAFF).
pub fn open_shift_detail(conn: &Db, actor: &User) -> AppResult<Option<ShiftRow>> {
    require_manager(actor)?;
    match shifts::any_active_shift(conn)? {
        Some(mut shift) => {
            shifts::hydrate_active_totals(conn, &mut shift)?;
            Ok(Some(shift))
        }
        None => Ok(None),
    }
}

fn require_manager(actor: &User) -> AppResult<()> {
    if matches!(actor.role.as_str(), "MANAGER" | "ADMIN") {
        Ok(())
    } else {
        Err(AppError::unauthorized("auth.forbidden"))
    }
}

pub fn open_day(conn: &Db, actor: &User) -> AppResult<i64> {
    require_manager(actor)?;
    let tx = conn.unchecked_transaction()?;
    if shifts::current_day(&tx)?.is_some() {
        return Err(AppError::business("day.already_open"));
    }
    let id =
        shifts::open_day(&tx, actor.id)?.ok_or_else(|| AppError::conflict("day.already_exists"))?;
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "day.opened",
        "business_day",
        Some(&id.to_string()),
        None,
        None,
    )?;
    tx.commit()?;
    Ok(id)
}

pub fn open_shift(conn: &Db, actor: &User, opening_cash: Money) -> AppResult<i64> {
    if opening_cash < 0 {
        return Err(AppError::validation("shift.invalid_opening_cash"));
    }
    let tx = conn.unchecked_transaction()?;
    let day = if let Some(day) = shifts::current_day(&tx)? {
        day
    } else {
        let day_id = match shifts::open_day(&tx, actor.id)
            .map_err(|_| AppError::business("day.open_failed"))?
        {
            Some(id) => id,
            // A concurrent writer may have opened the single permitted open day
            // after our lookup. Reuse it rather than creating or reporting a
            // second business day.
            None => {
                shifts::current_day(&tx)?
                    .ok_or_else(|| AppError::business("day.open_failed"))?
                    .id
            }
        };
        shifts::current_day(&tx)?
            .filter(|day| day.id == day_id)
            .ok_or_else(|| AppError::internal("opened business day was not found"))?
    };
    if shifts::any_active_shift(&tx)?.is_some() {
        return Err(AppError::business("shift.already_open"));
    }
    let id = shifts::open_shift(&tx, day.id, actor.id, opening_cash)?
        .ok_or_else(|| AppError::internal("shift insert failed"))?;
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "shift.opened",
        "shift",
        Some(&id.to_string()),
        None,
        Some(&serde_json::json!({ "opening_cash": opening_cash })),
    )?;
    tx.commit()?;
    Ok(id)
}

#[derive(Debug, Serialize)]
pub struct ShiftClosing {
    pub shift: ShiftRow,
    pub expected_cash: i64,
    pub difference: i64,
    /// The full authoritative reconciliation that was persisted.
    pub report: reconciliation::ShiftReconciliation,
    /// The shift's own table lifecycle, stated by the closing itself: the
    /// sessions it opened and the ones it closed without an order.
    ///
    /// It is read from the persisted `table_sessions` rows the shift owns, so it
    /// is fixed at closing time by the same transaction that fixed the money, and
    /// the next shift starts from a clean zero by itself.
    pub tables: TableCounters,
}

#[derive(Debug, Serialize)]
pub struct ShiftClosingPreview {
    pub shift: ShiftRow,
    pub closing_at: String,
    pub cash_sales: i64,
    pub card_sales: i64,
    pub credit_sales: i64,
    pub invoices_count: i64,
    pub cash_expenses: i64,
    pub expenses: i64,
    pub expected_cash: i64,
    /// The table lifecycle this closing would report, from the same read the
    /// committed closing returns — so the dialog can never quote a different
    /// number than the result it produces.
    pub tables: TableCounters,
    /// Full breakdown so the dialog can show the same document the printer will.
    pub report: reconciliation::ShiftReconciliation,
}

pub fn preview_shift_close(conn: &Db, actor: &User) -> AppResult<ShiftClosingPreview> {
    // Read through the SAME hydration `state()` uses, so the dialog can never
    // quote a different number than the card it was opened from.
    let mut shift = shifts::active_shift_for(conn, actor.id)?
        .ok_or_else(|| AppError::business("shift.not_open"))?;
    shifts::hydrate_active_totals(conn, &mut shift)?;
    let shift_id = shift.id;
    Ok(ShiftClosingPreview {
        expected_cash: shift.expected_cash,
        cash_sales: shift.cash_sales,
        card_sales: shift.card_sales,
        credit_sales: shift.credit_sales,
        invoices_count: shift.invoices_count,
        cash_expenses: shift.cash_expenses,
        expenses: shift.expenses,
        closing_at: shifts::sqlite_now(conn)?,
        // The same read `close_shift` returns, so the figure shown before the
        // confirmation is the figure the committed closing carries.
        tables: pos_svc::shift_lifecycle_counts(conn, actor)?,
        report: reconciliation::shift_report(conn, shift_id)?,
        shift,
    })
}

/// Close the caller's shift. `actual_cash` is the physically counted drawer;
/// the difference is recorded explicitly and NEVER adjusted silently.
pub fn close_shift(conn: &Db, actor: &User, actual_cash: Money) -> AppResult<ShiftClosing> {
    let closed_at = shifts::sqlite_now(conn)?;
    close_shift_at(conn, actor, actual_cash, &closed_at)
}

/// Shared lifecycle implementation. The timestamp is computed by SQLite in
/// production; an exact value may be supplied only by in-crate workflow tests.
pub fn close_shift_at(
    conn: &Db,
    actor: &User,
    actual_cash: Money,
    closed_at: &str,
) -> AppResult<ShiftClosing> {
    let shift = shifts::active_shift_for(conn, actor.id)?
        .ok_or_else(|| AppError::business("shift.not_open"))?;
    close_shift_row(
        conn,
        actor,
        shift.id,
        actual_cash,
        closed_at,
        "shift.closed",
    )
}

/// Managerial close of ANOTHER cashier's open shift (operational recovery).
/// ADMIN/MANAGER only — enforced here, not just in the command layer — and it
/// runs the SAME financial computation as a self-close. The only differences
/// are who may invoke it and how it is recorded (`closed_by` + a distinct
/// audit action). `user_id` (owner) is never rewritten.
pub fn preview_managed_shift_close(
    conn: &Db,
    actor: &User,
    shift_id: i64,
) -> AppResult<ShiftClosingPreview> {
    require_manager(actor)?;
    let mut shift =
        shifts::get_shift(conn, shift_id)?.ok_or_else(|| AppError::not_found("shift.not_found"))?;
    if shift.status != "ACTIVE" {
        return Err(AppError::business("shift.not_closable"));
    }
    shifts::hydrate_active_totals(conn, &mut shift)?;
    Ok(ShiftClosingPreview {
        expected_cash: shift.expected_cash,
        cash_sales: shift.cash_sales,
        card_sales: shift.card_sales,
        credit_sales: shift.credit_sales,
        invoices_count: shift.invoices_count,
        cash_expenses: shift.cash_expenses,
        expenses: shift.expenses,
        closing_at: shifts::sqlite_now(conn)?,
        tables: pos_repo::shift_lifecycle_counts(conn, shift.id)?,
        report: reconciliation::shift_report(conn, shift.id)?,
        shift,
    })
}

/// Managerial close of ANOTHER cashier's open shift. See
/// [`preview_managed_shift_close`] for the authorization contract.
pub fn close_managed_shift(
    conn: &Db,
    actor: &User,
    shift_id: i64,
    actual_cash: Money,
) -> AppResult<ShiftClosing> {
    let closed_at = shifts::sqlite_now(conn)?;
    close_managed_shift_at(conn, actor, shift_id, actual_cash, &closed_at)
}

/// Shared lifecycle implementation. The timestamp is computed by SQLite in
/// production; an exact value may be supplied only by in-crate tests (the same
/// seam `close_shift_at` exposes), so Cairo business-day boundary behaviour is
/// testable without touching the machine clock.
pub fn close_managed_shift_at(
    conn: &Db,
    actor: &User,
    shift_id: i64,
    actual_cash: Money,
    closed_at: &str,
) -> AppResult<ShiftClosing> {
    require_manager(actor)?;
    close_shift_row(
        conn,
        actor,
        shift_id,
        actual_cash,
        closed_at,
        "shift.closed_by_manager",
    )
}

/// The ONE shift-closing writer. Both the self-close and the managerial close
/// funnel through here, so there is exactly one financial implementation and
/// one concurrency rule: the guarded `UPDATE ... WHERE status = 'ACTIVE'`
/// admits a single winner, and the loser observes `shift.not_closable`.
fn close_shift_row(
    conn: &Db,
    actor: &User,
    shift_id: i64,
    actual_cash: Money,
    closed_at: &str,
    audit_action: &str,
) -> AppResult<ShiftClosing> {
    if actual_cash < 0 {
        return Err(AppError::validation("shift.invalid_actual_cash"));
    }
    let tx = conn.unchecked_transaction()?;
    let shift =
        shifts::get_shift(&tx, shift_id)?.ok_or_else(|| AppError::not_found("shift.not_found"))?;
    if shift.status != "ACTIVE" {
        return Err(AppError::business("shift.not_closable"));
    }
    // Open orders still holding this shift's till would make the reconciliation
    // a lie: money could be handed in after the drawer was counted.
    if shifts::open_orders_in_shift(&tx, shift.id)? > 0 {
        return Err(AppError::business("shift.orders_open"));
    }

    let totals = shifts::compute_shift_totals(&tx, shift.id)?;
    let (expenses, cash_expenses) = expenses::shift_totals(&tx, shift.id)?;
    // The category breakdown is resolved NOW and stored with the rest of the
    // closing snapshot, so the document keeps these exact lines — and these
    // exact Arabic labels — forever.
    let breakdown = expenses::breakdown_for_shift(&tx, shift.id)?;
    // THE drawer formula, from the shared reconciliation module, so the figure
    // the manager is shown, the figure persisted and the figure printed are one.
    let cash = reconciliation::CashReconciliation::build(
        shift.opening_cash,
        totals.cash,
        cash_expenses,
        actual_cash,
    );
    if !shifts::save_shift_closing(
        &tx,
        shift.id,
        &totals,
        expenses,
        cash_expenses,
        cash.expected_cash,
        actual_cash,
        closed_at,
        &expenses::encode_breakdown(&breakdown),
        actor.id,
    )? {
        return Err(AppError::business("shift.not_closable"));
    }
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        audit_action,
        "shift",
        Some(&shift.id.to_string()),
        None,
        Some(&serde_json::json!({
            "shift_owner": shift.user_id,
            "closed_by": actor.id,
            "closed_by_role": actor.role,
            "expected_cash": cash.expected_cash, "actual_cash": actual_cash,
            "difference": cash.difference, "status": cash.status,
            "cash_expenses": cash_expenses, "expenses": expenses,
            "invoices_count": totals.invoices_count
        })),
    )?;
    tx.commit()?;
    let report = reconciliation::shift_report(conn, shift.id)?;
    // Read AFTER the commit, and from the same persisted rows, so the result the
    // caller receives is the closing that was actually written. A session cannot
    // change once it is closed, so this is stable from here on.
    let tables = pos_repo::shift_lifecycle_counts(conn, shift.id)?;
    Ok(ShiftClosing {
        shift: report.shift.clone(),
        expected_cash: cash.expected_cash,
        difference: cash.difference,
        tables,
        report,
    })
}

/// Record an incremental settlement checkpoint while the operational Business
/// Day remains OPEN. The unique relationship makes concurrent double inclusion
/// fail and preserves each immutable totals snapshot.
pub fn preview_settlement(conn: &Db, actor: &User) -> AppResult<SettlementPreview> {
    require_manager(actor)?;
    let day = shifts::current_day(conn)?.ok_or_else(|| AppError::business("day.not_open"))?;
    let pending_shifts = shifts::pending_shifts(conn, day.id)?;
    let shift_ids: Vec<i64> = pending_shifts.iter().map(|s| s.id).collect();
    let totals = shifts::settlement_totals(conn, day.id, &shift_ids)?;
    Ok(SettlementPreview {
        business_day_id: day.id,
        pending_shifts,
        totals,
    })
}

pub fn settle_day(conn: &Db, actor: &User) -> AppResult<DayClosingRecord> {
    require_manager(actor)?;
    let tx = conn.unchecked_transaction()?;
    let day = shifts::current_day(&tx)?.ok_or_else(|| AppError::business("day.not_open"))?;
    if shifts::open_orders_in_day(&tx, day.id)? > 0 {
        return Err(AppError::business("day.orders_open"));
    }
    let pending = shifts::pending_shifts(&tx, day.id)?;
    if pending.is_empty() {
        return Err(AppError::business("day.no_pending_shifts"));
    }
    let shift_ids: Vec<i64> = pending.iter().map(|s| s.id).collect();
    let totals = shifts::settlement_totals(&tx, day.id, &shift_ids)?;
    let closing_id = shifts::insert_day_closing(&tx, day.id, actor.id, &shift_ids, &totals)?;
    let record = shifts::settlement_history(&tx, day.id)?
        .into_iter()
        .find(|r| r.id == closing_id)
        .ok_or_else(|| AppError::internal("day closing lost"))?;
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "day.settled",
        "day_closing",
        Some(&closing_id.to_string()),
        None,
        Some(&serde_json::json!({
            "business_day_id": day.id, "shift_ids": shift_ids,
            "total_sales": totals.total_sales, "cash": totals.cash,
            "card": totals.card, "credit": totals.credit, "expenses": totals.expenses
        })),
    )?;
    tx.commit()?;
    Ok(record)
}

pub fn settlement_history(conn: &Db, actor: &User) -> AppResult<Vec<DayClosingRecord>> {
    require_manager(actor)?;
    let day = shifts::current_day(conn)?.ok_or_else(|| AppError::business("day.not_open"))?;
    shifts::settlement_history(conn, day.id)
}

/// Which shifts a day closing is allowed to include, and the authoritative
/// report built from exactly those shifts.
#[derive(Debug, Serialize)]
pub struct DayClosePreview {
    pub report: reconciliation::DayReconciliation,
    /// Empty when the day is fully settled — the UI warns only when it is not.
    pub open_shifts: Vec<OpenShiftInfo>,
    pub open_orders: i64,
}

/// What the manager must be told about a shift that will be EXCLUDED.
#[derive(Debug, Serialize)]
pub struct OpenShiftInfo {
    pub id: i64,
    pub user_name: Option<String>,
    pub opened_at: String,
    pub cash_sales: i64,
    pub expenses: i64,
}

#[derive(Debug, Serialize)]
pub struct DayCloseResult {
    pub totals: DayTotals,
    pub report: reconciliation::DayReconciliation,
}

/// THE INCLUSION RULE, applied in the backend and never in the UI:
///   INCLUDED — every CLOSED (settled) shift belonging to this business day.
///   EXCLUDED — any shift still ACTIVE. Its sales AND its expenses are invisible
///              to this closing; they can only enter a later closing, once that
///              shift is itself settled.
///
/// An open shift is a CONFIRMATION, not an error: it is reported in
/// `open_shifts` so the manager can be warned and choose to continue.
pub fn day_close_preview(conn: &Db, actor: &User) -> AppResult<DayClosePreview> {
    require_manager(actor)?;
    let day = shifts::current_day(conn)?.ok_or_else(|| AppError::business("day.not_open"))?;
    build_day_close_preview(conn, day)
}

fn build_day_close_preview(conn: &Db, day: BusinessDay) -> AppResult<DayClosePreview> {
    let all = shifts::shifts_of_day(conn, day.id)?;
    // Inclusion is decided HERE, by persisted shift status. The client never
    // supplies or filters a shift list, so an open shift cannot leak in.
    let (settled, mut open_shifts): (Vec<ShiftRow>, Vec<ShiftRow>) =
        all.into_iter().partition(|s| s.status == "CLOSED");
    let shift_ids: Vec<i64> = settled.iter().map(|s| s.id).collect();
    let mut report = reconciliation::aggregate_day(conn, day.clone(), &shift_ids, &settled)?;
    report.open_shift_count = open_shifts.len() as i64;
    // An ACTIVE shift has no persisted snapshot, so the figures the manager is
    // warned about would otherwise always read zero. Hydrating them (the same
    // live view the POS card shows) is what makes the warning state the money
    // that is genuinely being excluded.
    for shift in open_shifts.iter_mut() {
        shifts::hydrate_active_totals(conn, shift)?;
    }
    Ok(DayClosePreview {
        report,
        open_shifts: open_shifts
            .into_iter()
            .map(|s| OpenShiftInfo {
                id: s.id,
                user_name: s.user_name,
                opened_at: s.opened_at,
                cash_sales: s.cash_sales,
                expenses: s.expenses,
            })
            .collect(),
        open_orders: shifts::open_orders_in_day(conn, day.id)?,
    })
}

/// Close the business day over its SETTLED shifts only.
///
/// A day that still has an open shift may still be closed: the manager confirms
/// the warning and the closing excludes that shift. What it must never do is
/// silently include unsettled activity — the old `day_totals(day_id)` summed
/// every invoice of the day regardless of shift status, which is exactly the
/// leak this function replaces.
pub fn close_day(conn: &Db, actor: &User) -> AppResult<DayCloseResult> {
    require_manager(actor)?;
    let tx = conn.unchecked_transaction()?;
    let day = shifts::current_day(&tx)?.ok_or_else(|| AppError::business("day.not_open"))?;
    if shifts::open_orders_in_day(&tx, day.id)? > 0 {
        return Err(AppError::business("day.orders_open"));
    }
    let preview = build_day_close_preview(&tx, day.clone())?;
    if preview.report.shifts.is_empty() && !preview.open_shifts.is_empty() {
        // There IS unsettled work and nothing settled to record: closing now
        // would leave a still-open shift with no business day to settle into.
        // Closing it would also freeze an empty report, so it stays blocked —
        // the open shift must be closed first. This is the ONE case an empty
        // closing is not yet a legitimate closing.
        return Err(AppError::business("day.no_settled_shifts"));
    }
    // Otherwise a zero-activity day is a REAL closing and is recorded as one.
    // A day opened and closed without a single invoice, wash ticket, expense
    // or settled shift is a legitimate business fact, not a missing record:
    // it is persisted as an all-zero final snapshot, it counts as a closed
    // business day, and it is listed by the reports exactly like any other.
    // Blocking it used to leave `business_days.status = 'OPEN'` forever, and
    // because only one business day may be open, the next day could then never
    // be opened either. Nothing is invented to make this look like activity —
    // the totals are genuinely zero, and `day_closing_shifts` is legitimately
    // empty because the closing really did include no shift.
    let r = preview.report;
    // The snapshot is written from the INCLUDED shifts' own immutable rows, and
    // `day_closing_shifts` records exactly which shifts those were — so a
    // historical day closing never depends on a shift's later state.
    let totals = DayTotals {
        invoices_count: r.invoices_count,
        cafe_sales: r.cafe_sales,
        wash_sales: r.wash_sales,
        subtotal: r.subtotal,
        discounts: r.discounts,
        service_charges: r.service_charges,
        total_sales: r.total_sales,
        cash: r.cash_sales,
        card: r.card_sales,
        credit: r.credit_sales,
        expenses: r.expenses,
    };
    let closing_id = shifts::insert_final_day_closing(
        &tx,
        day.id,
        actor.id,
        &r.included_shift_ids,
        &totals,
        &DayClosingSnapshot {
            cafe_invoices: r.areas.cafe_invoices,
            wash_invoices: r.areas.wash_invoices,
            hybrid_invoices: r.areas.hybrid_invoices,
            shift_count: r.shift_count,
            opening_cash: r.cash.opening_cash,
            cash_expenses: r.cash_expenses,
            expected_cash: r.cash.expected_cash,
            actual_cash: r.cash.actual_cash,
            shortage: r.cash.shortage,
            surplus: r.cash.surplus,
        },
        &expenses::encode_breakdown(&r.expense_breakdown),
    )?;
    // Day-level expenses belonging to NO shift still belong to this day, and are
    // claimed exactly once so no later settlement can report them again.
    shifts::claim_unassigned_day_expenses(&tx, day.id, closing_id)?;
    shifts::close_day(&tx, day.id, actor.id)?;
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "day.closed",
        "business_day",
        Some(&day.id.to_string()),
        None,
        Some(&serde_json::json!({
            "shift_ids": r.included_shift_ids,
            "excluded_open_shifts": preview.open_shifts.len(),
            "total_sales": totals.total_sales, "cash": totals.cash,
            "card": totals.card, "credit": totals.credit, "expenses": totals.expenses,
            "expected_cash": r.cash.expected_cash, "actual_cash": r.cash.actual_cash,
            "status": r.cash.status
        })),
    )?;
    tx.commit()?;
    Ok(DayCloseResult { totals, report: r })
}
