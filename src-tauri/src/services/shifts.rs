//! Shift & business-day lifecycle service.
//! NOT_OPEN → OPEN (shift ACTIVE) → CLOSING → CLOSED; day OPEN → CLOSED.
//! All guards enforced here: double-close, close-day-with-open-shifts, etc.

use crate::error::{AppError, AppResult};
use crate::money::Money;
use crate::repositories::shifts::{self, BusinessDay, DayTotals, ShiftRow};
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

pub fn open_day(conn: &Db, actor: &User) -> AppResult<i64> {
    let tx = conn.unchecked_transaction()?;
    if shifts::current_day(&tx)?.is_some() {
        return Err(AppError::business("day.already_open"));
    }
    let id = shifts::open_day(&tx, actor.id)?
        .ok_or_else(|| AppError::conflict("day.already_exists"))?;
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
    let day = shifts::current_day(&tx)?.ok_or_else(|| AppError::business("day.not_open"))?;
    if shifts::active_shift_for(&tx, actor.id)?.is_some() {
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

/// Close the caller's shift. `actual_cash` is the physically counted drawer;
/// the difference is recorded explicitly and NEVER adjusted silently.
pub fn close_shift(conn: &Db, actor: &User, actual_cash: Money) -> AppResult<ShiftClosing> {
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
        &tx, shift.id, cash, card, credit, sc, disc, count, expected, actual_cash,
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
        shift: shifts::get_shift(conn, shift.id)?.ok_or_else(|| AppError::internal("shift lost"))?,
        expected_cash: expected,
        difference: actual_cash - expected,
    })
}

/// Close the business day: requires every shift CLOSED and no open orders.
pub fn close_day(conn: &Db, actor: &User) -> AppResult<DayTotals> {
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
    let totals = shifts::day_totals(&tx, day.id)?;
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