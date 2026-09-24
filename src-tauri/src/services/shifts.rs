//! Shift & business-day lifecycle service.
//! NOT_OPEN → OPEN (shift ACTIVE) → CLOSING → CLOSED; day OPEN → CLOSED.
//! All guards enforced here: double-close, close-day-with-open-shifts, etc.

use crate::error::{AppError, AppResult};
use crate::money::Money;
use crate::repositories::shifts::{
    self, BusinessDay, DayClosingRecord, DayTotals, SettlementPreview, ShiftRow,
};
use crate::repositories::Db;
use crate::services::auth::User;
use serde::Serialize;

/// Day/shift state snapshot for the POS header.
#[derive(Debug, Serialize)]
pub struct DayShiftState {
    pub day: Option<BusinessDay>,
    pub my_shift: Option<ShiftRow>,
    pub any_active_shift: bool,
}

pub fn state(conn: &Db, actor: &User) -> AppResult<DayShiftState> {
    Ok(DayShiftState {
        day: shifts::current_day(conn)?,
        my_shift: shifts::active_shift_for(conn, actor.id)?,
        any_active_shift: shifts::any_active_shift(conn)?.is_some(),
    })
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
}

#[derive(Debug, Serialize)]
pub struct ShiftClosingPreview {
    pub shift: ShiftRow,
    pub closing_at: String,
    pub cash_sales: i64,
    pub card_sales: i64,
    pub credit_sales: i64,
    pub invoices_count: i64,
    pub expected_cash: i64,
}

pub fn preview_shift_close(conn: &Db, actor: &User) -> AppResult<ShiftClosingPreview> {
    let shift = shifts::active_shift_for(conn, actor.id)?
        .ok_or_else(|| AppError::business("shift.not_open"))?;
    let (cash, card, _, _, count) = shifts::compute_shift_totals(conn, shift.id)?;
    let credit = shifts::shift_credit_sales(conn, shift.id)?;
    Ok(ShiftClosingPreview {
        expected_cash: shift.opening_cash + cash,
        cash_sales: cash,
        card_sales: card,
        credit_sales: credit,
        invoices_count: count,
        closing_at: shifts::sqlite_now(conn)?,
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
    if actual_cash < 0 {
        return Err(AppError::validation("shift.invalid_actual_cash"));
    }
    let tx = conn.unchecked_transaction()?;
    let shift = shifts::active_shift_for(&tx, actor.id)?
        .ok_or_else(|| AppError::business("shift.not_open"))?;
    if shift.status != "ACTIVE" {
        return Err(AppError::business("shift.not_closable"));
    }

    let (cash, card, sc, disc, count) = shifts::compute_shift_totals(&tx, shift.id)?;
    let credit = shifts::shift_credit_sales(&tx, shift.id)?;
    let expected = shift.opening_cash + cash; // cash expenses tracked at day level
    shifts::save_shift_closing(
        &tx,
        shift.id,
        cash,
        card,
        credit,
        sc,
        disc,
        count,
        expected,
        actual_cash,
        closed_at,
    )?;
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "shift.closed",
        "shift",
        Some(&shift.id.to_string()),
        None,
        Some(&serde_json::json!({
            "expected_cash": expected, "actual_cash": actual_cash,
            "difference": actual_cash - expected
        })),
    )?;
    tx.commit()?;
    Ok(ShiftClosing {
        shift: shifts::get_shift(conn, shift.id)?
            .ok_or_else(|| AppError::internal("shift lost"))?,
        expected_cash: expected,
        difference: actual_cash - expected,
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
    if shifts::any_active_shift(&tx)?.is_some() {
        return Err(AppError::business("day.shifts_open"));
    }
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

/// Close the business day: requires every shift CLOSED and no open orders.
pub fn close_day(conn: &Db, actor: &User) -> AppResult<DayTotals> {
    require_manager(actor)?;
    let tx = conn.unchecked_transaction()?;
    let day = shifts::current_day(&tx)?.ok_or_else(|| AppError::business("day.not_open"))?;
    let open_shifts: Vec<ShiftRow> = shifts::shifts_of_day(&tx, day.id)?
        .into_iter()
        .filter(|s| s.status == "ACTIVE")
        .collect();
    if !open_shifts.is_empty() {
        return Err(AppError::business("day.shifts_open"));
    }
    if shifts::open_orders_in_day(&tx, day.id)? > 0 {
        return Err(AppError::business("day.orders_open"));
    }
    let pending = shifts::pending_shifts(&tx, day.id)?;
    let pending_ids: Vec<i64> = pending.iter().map(|s| s.id).collect();
    let totals = shifts::day_totals(&tx, day.id)?;
    shifts::insert_final_day_closing(&tx, day.id, actor.id, &pending_ids, &totals)?;
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
            "total_sales": totals.total_sales, "cash": totals.cash,
            "card": totals.card, "credit": totals.credit, "expenses": totals.expenses
        })),
    )?;
    tx.commit()?;
    Ok(totals)
}
