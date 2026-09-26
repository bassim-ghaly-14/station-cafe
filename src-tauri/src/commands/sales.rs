// Tauri commands — the Sales management surface.
//
// Two reads cover the whole page: the overview (KPIs + trend + items) and the
// invoice list behind them. Both are thin: session resolution, the existing
// MANAGER gate, then delegation to the service. All aggregation lives in the
// repository, all rules in the service.

use super::common::authorized;
use crate::error::AppResult;
use crate::repositories::sales_analytics::{ItemSort, SalesFilter, SalesInvoiceRow, SalesOverview};
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
