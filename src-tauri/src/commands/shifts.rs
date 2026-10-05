// Tauri commands — shift & business-day lifecycle, plus closing reports.

use super::common::authorized;
use crate::error::AppResult;
use crate::repositories::shifts::{
    ClosedBusinessDayReport, DayClosingRecord, SettlementPreview, ShiftRow,
};
use crate::services::reconciliation::{DayReconciliation, ShiftReconciliation};
use crate::services::shifts::{
    self as shift_svc, DayClosePreview, DayCloseResult, DayShiftState, ShiftClosing,
    ShiftClosingPreview,
};
use crate::AppState;
use tauri::State;

#[tauri::command(rename_all = "snake_case")]
pub fn day_shift_state(state: State<'_, AppState>, token: String) -> AppResult<DayShiftState> {
    authorized(&state, &token, "STAFF", |conn, actor| {
        shift_svc::state(conn, actor)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn open_business_day(state: State<'_, AppState>, token: String) -> AppResult<i64> {
    authorized(&state, &token, "MANAGER", |conn, actor| {
        shift_svc::open_day(conn, actor)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn open_shift(state: State<'_, AppState>, token: String, opening_cash: i64) -> AppResult<i64> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        shift_svc::open_shift(conn, actor, opening_cash)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn preview_shift_close(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<ShiftClosingPreview> {
    authorized(&state, &token, "STAFF", |conn, actor| {
        shift_svc::preview_shift_close(conn, actor)
    })
}

/// Closing returns expected vs actual and the explicit difference.
#[tauri::command(rename_all = "snake_case")]
pub fn close_shift(
    state: State<'_, AppState>,
    token: String,
    actual_cash: i64,
) -> AppResult<ShiftClosing> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        shift_svc::close_shift(conn, actor, actual_cash)
    })
}

/// The single open shift (whoever owns it), for the managerial recovery flow.
/// MANAGER-gated: STAFF continue to see only their own shift via `state()`.
#[tauri::command(rename_all = "snake_case")]
pub fn open_shift_detail(state: State<'_, AppState>, token: String) -> AppResult<Option<ShiftRow>> {
    authorized(&state, &token, "MANAGER", |conn, actor| {
        shift_svc::open_shift_detail(conn, actor)
    })
}

/// Managerial preview of another cashier's open shift. MANAGER-gated.
#[tauri::command(rename_all = "snake_case")]
pub fn preview_managed_shift_close(
    state: State<'_, AppState>,
    token: String,
    shift_id: i64,
) -> AppResult<ShiftClosingPreview> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        shift_svc::preview_managed_shift_close(conn, actor, shift_id)
    })
}

/// Managerial close of another cashier's open shift. MANAGER-gated in the
/// command AND in the service, so a STAFF caller invoking this command
/// directly is rejected by the backend.
#[tauri::command(rename_all = "snake_case")]
pub fn close_managed_shift(
    state: State<'_, AppState>,
    token: String,
    shift_id: i64,
    actual_cash: i64,
) -> AppResult<ShiftClosing> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        shift_svc::close_managed_shift(conn, actor, shift_id, actual_cash)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn preview_day_settlement(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<SettlementPreview> {
    authorized(&state, &token, "MANAGER", |conn, actor| {
        shift_svc::preview_settlement(conn, actor)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn settle_day(state: State<'_, AppState>, token: String) -> AppResult<DayClosingRecord> {
    authorized(&state, &token, "MANAGER", |conn, actor| {
        shift_svc::settle_day(conn, actor)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn day_settlement_history(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<Vec<DayClosingRecord>> {
    authorized(&state, &token, "MANAGER", |conn, actor| {
        shift_svc::settlement_history(conn, actor)
    })
}

/// The manager's day-closing preview: the exact totals the closing will record,
/// plus the open shifts that will be EXCLUDED. The UI renders its open-shift
/// warning from this, so the warning can never disagree with the closing.
#[tauri::command(rename_all = "snake_case")]
pub fn preview_day_close(state: State<'_, AppState>, token: String) -> AppResult<DayClosePreview> {
    authorized(&state, &token, "MANAGER", |conn, actor| {
        shift_svc::day_close_preview(conn, actor)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn close_business_day(state: State<'_, AppState>, token: String) -> AppResult<DayCloseResult> {
    authorized(&state, &token, "MANAGER", |conn, actor| {
        shift_svc::close_day(conn, actor)
    })
}
#[tauri::command(rename_all = "snake_case")]
pub fn list_closed_shifts(
    state: State<'_, AppState>,
    token: String,
    from: Option<String>,
    to: Option<String>,
) -> AppResult<Vec<ShiftRow>> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        crate::repositories::shifts::closed_shifts(conn, from.as_deref(), to.as_deref())
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_closed_business_days(
    state: State<'_, AppState>,
    token: String,
    from: Option<String>,
    to: Option<String>,
) -> AppResult<Vec<ClosedBusinessDayReport>> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        crate::repositories::shifts::closed_business_days(conn, from.as_deref(), to.as_deref())
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_shifts(
    state: State<'_, AppState>,
    token: String,
    day_id: i64,
) -> AppResult<Vec<ShiftRow>> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        crate::repositories::shifts::shifts_of_day(conn, day_id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn shift_report(
    state: State<'_, AppState>,
    token: String,
    shift_id: i64,
) -> AppResult<ShiftReconciliation> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        crate::services::reconciliation::shift_report(conn, shift_id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn day_report(
    state: State<'_, AppState>,
    token: String,
    day_id: i64,
) -> AppResult<DayReconciliation> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        crate::services::reports::day_report(conn, day_id)
    })
}
