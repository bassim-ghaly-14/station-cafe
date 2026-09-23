// Tauri commands — inventory, expenses, reports, audit and printing.

use super::common::authorized;
use crate::error::AppResult;
use crate::printing::{self, PrintConfig, PrintJobRow, PrintOutcome};
use crate::repositories::ops::{Expense, MovementRow, StockRow};
use crate::services::ops::{self as ops_svc, NewExpense};
use crate::services::reports::{self, AuditEntry, ProductSales, SalesByDay, TodaySummary};
use crate::AppState;
use tauri::State;

// ---- inventory -------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub fn list_stock(state: State<'_, AppState>, token: String) -> AppResult<Vec<StockRow>> {
    authorized(&state, &token, "STAFF", |conn, _| ops_svc::list_stock(conn))
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_stock_movements(
    state: State<'_, AppState>,
    token: String,
    limit: i64,
) -> AppResult<Vec<MovementRow>> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        ops_svc::list_movements(conn, limit)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn adjust_stock(
    state: State<'_, AppState>,
    token: String,
    product_id: i64,
    change: i64,
    reason: String,
    note: Option<String>,
) -> AppResult<()> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        ops_svc::adjust_stock(conn, actor, product_id, change, &reason, note.as_deref())
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_stock_minimum(
    state: State<'_, AppState>,
    token: String,
    product_id: i64,
    min_quantity: i64,
) -> AppResult<()> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        ops_svc::set_min_quantity(conn, actor, product_id, min_quantity)
    })
}

// ---- expenses --------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub fn list_expenses(
    state: State<'_, AppState>,
    token: String,
    from: Option<String>,
    to: Option<String>,
    recurring_only: bool,
) -> AppResult<Vec<Expense>> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        ops_svc::list_expenses(conn, from, to, recurring_only)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn create_expense(
    state: State<'_, AppState>,
    token: String,
    input: NewExpense,
) -> AppResult<i64> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        ops_svc::create_expense(conn, actor, &input)
    })
}

// ---- reports & audit -------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub fn today_summary(state: State<'_, AppState>, token: String) -> AppResult<TodaySummary> {
    authorized(&state, &token, "STAFF", |conn, _| {
        reports::today_summary(conn)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn sales_by_day(
    state: State<'_, AppState>,
    token: String,
    from: String,
    to: String,
) -> AppResult<Vec<SalesByDay>> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        reports::sales_by_day(conn, &from, &to)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn product_sales(
    state: State<'_, AppState>,
    token: String,
    from: String,
    to: String,
) -> AppResult<Vec<ProductSales>> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        reports::product_sales(conn, &from, &to)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_audit(
    state: State<'_, AppState>,
    token: String,
    limit: i64,
    action_like: Option<String>,
) -> AppResult<Vec<AuditEntry>> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        reports::list_audit(conn, limit, action_like.as_deref())
    })
}

// ---- printing --------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub fn get_print_config(state: State<'_, AppState>, token: String) -> AppResult<PrintConfig> {
    authorized(&state, &token, "MANAGER", |conn, _| {
        printing::get_config(conn)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_print_config(
    state: State<'_, AppState>,
    token: String,
    config: PrintConfig,
) -> AppResult<()> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        printing::set_config(conn, &config)?;
        crate::services::audit::record(
            conn,
            Some(actor.id),
            Some(&actor.role),
            "settings.printer_changed",
            "settings",
            Some("printer"),
            None,
            Some(&serde_json::json!({
                "target": config.target, "arabic_mode": config.arabic_mode,
                "codepage": config.codepage, "logo": config.logo
            })),
        )
    })
}

/// Test print — explicit user action, so duplicate protection is bypassed.
#[tauri::command(rename_all = "snake_case")]
pub fn print_test(state: State<'_, AppState>, token: String) -> AppResult<PrintOutcome> {
    authorized(&state, &token, "MANAGER", |conn, _| {
        printing::print_test(conn, true)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn print_invoice(
    state: State<'_, AppState>,
    token: String,
    invoice_id: i64,
    force: Option<bool>,
) -> AppResult<PrintOutcome> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        printing::print_invoice(conn, invoice_id, force.unwrap_or(false))
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn print_wash_ticket(
    state: State<'_, AppState>,
    token: String,
    order_id: i64,
    force: Option<bool>,
) -> AppResult<PrintOutcome> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        printing::print_wash_ticket(conn, order_id, force.unwrap_or(false))
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn print_shift_report(
    state: State<'_, AppState>,
    token: String,
    shift_id: i64,
    force: Option<bool>,
) -> AppResult<PrintOutcome> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        printing::print_shift_closing(conn, shift_id, force.unwrap_or(false))
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn print_day_report_cmd(
    state: State<'_, AppState>,
    token: String,
    day_id: i64,
    force: Option<bool>,
) -> AppResult<PrintOutcome> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        printing::print_day_report(conn, day_id, force.unwrap_or(false))
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_print_jobs(
    state: State<'_, AppState>,
    token: String,
    limit: i64,
) -> AppResult<Vec<PrintJobRow>> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        printing::recent_jobs(conn, limit)
    })
}
