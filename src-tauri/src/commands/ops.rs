// Tauri commands — inventory, expenses, reports, audit and printing.

use super::common::authorized;
use crate::error::{AppError, AppResult};
use crate::printing::{self, PrintConfig, PrintJobRow, PrintOutcome, PrintPreview};
use crate::repositories::analytics::AnalyticsCharts;
use crate::repositories::expenses::{
    Expense, ExpenseCategory, ExpenseMonthlyWindow, ExpenseOverview,
};
use crate::repositories::ops::{MovementRow, StockRow};
use crate::services::ops::{self as ops_svc, NewExpense};
use crate::services::reports::{self, AuditEntry, TodaySummary};
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

/// Categories come from the backend table, so the UI can never offer a
/// category the database does not accept.
#[tauri::command(rename_all = "snake_case")]
pub fn list_expense_categories(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<Vec<ExpenseCategory>> {
    authorized(&state, &token, "STAFF", |conn, _| {
        ops_svc::list_categories(conn)
    })
}

/// MANAGER+ creation of an expense category. The Arabic name is all the user
/// supplies; the service owns the code, the validation and the audit entry, so
/// the same guarantee holds for every caller and not only for this command.
#[tauri::command(rename_all = "snake_case")]
pub fn create_expense_category(
    state: State<'_, AppState>,
    token: String,
    name: String,
) -> AppResult<String> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        ops_svc::create_category(conn, actor, &name)
    })
}

/// MANAGER+ rename of an expense category — a normal edit, not a privileged one.
#[tauri::command(rename_all = "snake_case")]
pub fn rename_expense_category(
    state: State<'_, AppState>,
    token: String,
    code: String,
    name: String,
) -> AppResult<()> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        ops_svc::rename_category(conn, actor, &code, &name)
    })
}

/// ADMIN-only delete of an expense category — narrower than renaming it, exactly
/// as deleting a product is narrower than editing one.
///
/// The command requires ADMIN at the boundary AND the service re-checks the role
/// and the category's own rules, so a MANAGER that bypasses this UI entirely —
/// invoking the command directly — still cannot remove a category.
#[tauri::command(rename_all = "snake_case")]
pub fn delete_expense_category(
    state: State<'_, AppState>,
    token: String,
    code: String,
) -> AppResult<()> {
    authorized(&state, &token, "ADMIN", move |conn, actor| {
        ops_svc::delete_category(conn, actor, &code)
    })
}

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

/// The period's expense analytics — KPIs, daily trend and category ranking in
/// ONE read, so the whole workspace describes a single window.
#[tauri::command(rename_all = "snake_case")]
pub fn expenses_overview(
    state: State<'_, AppState>,
    token: String,
    from: Option<String>,
    to: Option<String>,
) -> AppResult<ExpenseOverview> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        ops_svc::expenses_overview(conn, from, to)
    })
}

/// The monthly expenses comparison, over the window configured in Dev Settings.
///
/// It takes NO `from`/`to`: the window is the persisted monthly-period setting,
/// exactly like the sales monthly report, so the Expenses page's own date range
/// can never re-shape these bars.
#[tauri::command(rename_all = "snake_case")]
pub fn expenses_monthly(
    state: State<'_, AppState>,
    token: String,
    months: Option<i64>,
) -> AppResult<ExpenseMonthlyWindow> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        ops_svc::expenses_monthly(conn, actor, months)
    })
}

/// Record an expense. STAFF is the floor: a cashier may book a spend against
/// their own open shift. The service decides which shift it belongs to and
/// refuses a cashier with no open shift, so this command adds no rule of its own.
#[tauri::command(rename_all = "snake_case")]
pub fn create_expense(
    state: State<'_, AppState>,
    token: String,
    input: NewExpense,
) -> AppResult<i64> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        ops_svc::create_expense(conn, actor, &input)
    })
}

/// The caller's own open-shift expenses.
#[tauri::command(rename_all = "snake_case")]
pub fn list_shift_expenses(state: State<'_, AppState>, token: String) -> AppResult<Vec<Expense>> {
    authorized(&state, &token, "STAFF", |conn, actor| {
        ops_svc::shift_expenses(conn, actor)
    })
}

/// The expenses of ANY shift — MANAGER+ only, for reviewing a cashier's open
/// shift before a managerial close. The cashier's own `list_shift_expenses`
/// keeps exactly the STAFF-level access it always had.
#[tauri::command(rename_all = "snake_case")]
pub fn list_expenses_of_shift(
    state: State<'_, AppState>,
    token: String,
    shift_id: i64,
) -> AppResult<Vec<Expense>> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        ops_svc::expenses_of_shift(conn, actor, shift_id)
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
pub fn analytics_charts(
    state: State<'_, AppState>,
    token: String,
    from: Option<String>,
    to: Option<String>,
) -> AppResult<AnalyticsCharts> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        reports::analytics_charts(conn, from.as_deref(), to.as_deref())
    })
}

/// The monthly executive summary for one business month — the one-page figures
/// the owner reads: both departments against their own targets, the month's
/// money, and the month before it for comparison.
///
/// It takes an optional `month` (`YYYY-MM`) and nothing else. No `from`/`to`
/// pair, no filter, no category list: a monthly target is a statement about a
/// calendar month, so this command physically cannot be pointed at an arbitrary
/// range the way a range report can. An absent month means the current Cairo
/// business month, decided by the backend clock.
#[tauri::command(rename_all = "snake_case")]
pub fn monthly_executive_report(
    state: State<'_, AppState>,
    token: String,
    month: Option<String>,
) -> AppResult<crate::services::reports::MonthlyExecutiveReport> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        reports::monthly_executive(conn, actor, month.as_deref())
    })
}

/// Opens the platform print dialog for the monthly executive sheet.
///
/// WHY THIS EXISTS AT ALL: the sheet has always been produced by the WebView's
/// own print pipeline (`@page { size: A4 }` in `index.css`), and it still is —
/// nothing about the document changed. What was broken was the TRIGGER. The UI
/// called `window.print()`, which WKWebView on macOS does not implement: the
/// click was a silent no-op, so no dialog and no PDF. `WebviewWindow::print()`
/// is wry's own entry point, which on macOS drives
/// `WKWebView.printOperationWithPrintInfo:` (the same native panel a user would
/// reach through the browser menu, including "Save as PDF") and on Windows
/// evaluates `window.print()` in WebView2, where it does work.
///
/// It therefore prints whatever the page currently shows, which is exactly why
/// the caller keeps the `printing-monthly` body class set across the call: the
/// `@media print` rules are what reduce the page to the single A4 sheet.
///
/// No report data crosses this boundary — the figures were already authorized
/// and delivered by `monthly_executive_report`. This command only opens a
/// dialog on the manager's own machine, which is why it is deliberately NOT
/// registered on the LAN bridge: a phone must not be able to make the till
/// print.
#[tauri::command]
pub fn print_monthly_report(window: tauri::WebviewWindow) -> AppResult<()> {
    window.print().map_err(|error| {
        // The technical detail stays on the machine that owns the panel; the
        // caller receives the same stable key every other failure uses.
        log::error!("monthly report print dialog failed: {error}");
        AppError::printer("reports.monthly.print_failed")
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

/// Read-only printable representation of the current order and selected
/// discount. No invoice, payment, stock movement, print job, order transition,
/// or wash waiting number is created.
#[tauri::command(rename_all = "snake_case")]
pub fn preview_order_document(
    state: State<'_, AppState>,
    token: String,
    order_id: i64,
    discount_mode: Option<String>,
    discount_value: Option<i64>,
    service_charge_minor: Option<i64>,
) -> AppResult<PrintPreview> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        printing::preview_order(
            conn,
            order_id,
            discount_mode.as_deref(),
            discount_value,
            service_charge_minor,
        )
    })
}

/// Read-only print preview of a persisted invoice. Same authorization and the
/// same template/data as `print_invoice` — it only differs by not sending the
/// document to the printer and not recording a print job.
#[tauri::command(rename_all = "snake_case")]
pub fn preview_invoice(
    state: State<'_, AppState>,
    token: String,
    invoice_id: i64,
) -> AppResult<PrintPreview> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        printing::preview_invoice(conn, invoice_id)
    })
}

/// Read-only print preview of an issued wash ticket (never allocates a number).
#[tauri::command(rename_all = "snake_case")]
pub fn preview_wash_ticket(
    state: State<'_, AppState>,
    token: String,
    order_id: i64,
) -> AppResult<PrintPreview> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        printing::preview_wash_ticket(conn, order_id)
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

/// Read-only shift-closing preview (same template/report as printing).
#[tauri::command(rename_all = "snake_case")]
pub fn preview_shift_report(
    state: State<'_, AppState>,
    token: String,
    shift_id: Option<i64>,
) -> AppResult<PrintPreview> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        let id = match shift_id {
            Some(v) => v,
            None => crate::repositories::shifts::active_shift_for(conn, actor.id)?
                .map(|s| s.id)
                .or_else(|| {
                    // After a successful close there is no ACTIVE shift; preview
                    // the caller's latest closed shift so the post-close print
                    // dialog can re-print the same final snapshot.
                    crate::repositories::shifts::latest_shift_for(conn, actor.id)
                        .ok()
                        .flatten()
                        .map(|s| s.id)
                })
                .ok_or_else(|| crate::error::AppError::not_found("shift.not_found"))?,
        };
        printing::preview_shift_closing(conn, id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn preview_day_report_cmd(
    state: State<'_, AppState>,
    token: String,
    day_id: i64,
) -> AppResult<PrintPreview> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        printing::preview_day_report(conn, day_id)
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
