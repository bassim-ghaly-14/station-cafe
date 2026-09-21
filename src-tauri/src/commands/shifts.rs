// Tauri commands — shift & business-day lifecycle, plus closing reports.

use super::common::authorized;
use crate::error::AppResult;
use crate::repositories::shifts::{DayTotals, ShiftRow};
use crate::services::reports::{self, DayReport, ShiftReport};
use crate::services::shifts::{self as shift_svc, DayShiftState, ShiftClosing};
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn day_shift_state(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<DayShiftState> {
    authorized(&state, &token, "STAFF", |conn, actor| shift_svc::state(conn, actor))
}

#[tauri::command]
pub fn open_business_day(state: State<'_, AppState>, token: String) -> AppResult<i64> {
    authorized(&state, &token, "MANAGER", |conn, actor| {
        shift_svc::open_day(conn, actor)
    })
}

#[tauri::command]
pub fn open_shift(
    state: State<'_, AppState>,
    token: String,
    opening_cash: i64,
) -> AppResult<i64> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        shift_svc::open_shift(conn, actor, opening_cash)
    })
}

/// Closing returns expected vs actual and the explicit difference.
#[tauri::command]
pub fn close_shift(
    state: State<'_, AppState>,
    token: String,
    actual_cash: i64,
) -> AppResult<ShiftClosing> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        shift_svc::close_shift(conn, actor, actual_cash)
    })
}

#[tauri::command]
pub fn close_business_day(state: State<'_, AppState>, token: String) -> AppResult<DayTotals> {
    authorized(&state, &token, "MANAGER", |conn, actor| {
        shift_svc::close_day(conn, actor)
    })
}

#[tauri::command]
pub fn list_shifts(state: State<'_, AppState>, token: String, day_id: i64) -> AppResult<Vec<ShiftRow>> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        crate::repositories::shifts::shifts_of_day(conn, day_id)
    })
}

#[tauri::command]
pub fn shift_report(state: State<'_, AppState>, token: String, shift_id: i64) -> AppResult<ShiftReport> {
    authorized(&state, &token, "STAFF", move |conn, _| reports::shift_report(conn, shift_id))
}

#[tauri::command]
pub fn day_report(state: State<'_, AppState>, token: String, day_id: i64) -> AppResult<DayReport> {
    authorized(&state, &token, "MANAGER", move |conn, _| reports::day_report(conn, day_id))
}