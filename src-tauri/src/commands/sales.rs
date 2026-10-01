// Tauri commands — the Sales management surface.
//
// Two reads cover the whole page: the overview (KPIs + trend + items) and the
// invoice list behind them. Both are thin: session resolution, the existing
// MANAGER gate, then delegation to the service. All aggregation lives in the
// repository, all rules in the service.

use super::common::authorized;
use crate::error::AppResult;
use crate::repositories::sales_analytics::{ItemSort, SalesFilter, SalesInvoiceRow, SalesOverview};
use crate::services::sales::SalesMonthlyReport;
use crate::AppState;
use tauri::State;

/// KPIs, daily trend and top items for one period and filter set.
#[tauri::command(rename_all = "snake_case")]
pub fn sales_overview(
    state: State<'_, AppState>,
    token: String,
    filter: Option<SalesFilter>,
    sort: Option<ItemSort>,
) -> AppResult<SalesOverview> {
    let filter = filter.unwrap_or_default();
    let sort = sort.unwrap_or(ItemSort::Revenue);
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        crate::services::sales::overview(conn, actor, &filter, sort)
    })
}

/// The invoices of the same period and filter set, newest first.
#[tauri::command(rename_all = "snake_case")]
pub fn sales_invoices(
    state: State<'_, AppState>,
    token: String,
    filter: Option<SalesFilter>,
) -> AppResult<Vec<SalesInvoiceRow>> {
    let filter = filter.unwrap_or_default();
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        crate::services::sales::invoices(conn, actor, &filter)
    })
}

/// The monthly Cafe-vs-Wash revenue series.
///
/// Carries its OWN trailing window and no `filter` argument at all — that absence
/// is the contract: this calendar series is never narrowed by the Sales page's
/// date picker, so the command physically cannot be handed one.
#[tauri::command(rename_all = "snake_case")]
pub fn sales_monthly(
    state: State<'_, AppState>,
    token: String,
    months: Option<i64>,
) -> AppResult<SalesMonthlyReport> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        crate::services::sales::monthly(conn, actor, months)
    })
}

/// The cashier options of the filter.
#[tauri::command(rename_all = "snake_case")]
pub fn sales_cashiers(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<Vec<crate::repositories::sales_analytics::SalesCashier>> {
    authorized(&state, &token, "MANAGER", |conn, actor| {
        crate::services::sales::cashiers(conn, actor)
    })
}

/// The current business month's revenue-target progress for CAFE and WASH.
///
/// Takes no period argument at all: a target is a MONTHLY target, and this
/// command answers for the current Cairo business month, resolved by the backend
/// clock. The absence of a `filter` is the same contract `sales_monthly` keeps —
/// this figure cannot be pointed at an arbitrary range by a caller.
#[tauri::command(rename_all = "snake_case")]
pub fn sales_target_progress(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<crate::services::sales::MonthlyTargetProgress> {
    authorized(&state, &token, "MANAGER", |conn, actor| {
        crate::services::sales::target_progress(conn, actor)
    })
}
