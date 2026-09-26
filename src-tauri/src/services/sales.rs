//! Sales management service — the authorization and validation boundary.
//!
//! The Sales page is a management surface, so EVERY read here is gated by the
//! existing `MANAGER` role check (the same one the reports commands and the
//! customers analytics use). No new permission system is introduced and the gate
//! lives here, in the service, not in the UI: hiding a navigation entry is not
//! authorization.
//!
//! It also owns input validation. A malformed period or an unknown method is
//! rejected before it can reach a report query, so the SQL layer only ever sees
//! values from a closed set.

use crate::error::{AppError, AppResult};
use crate::repositories::sales_analytics::{
    self, ItemSort, SalesCashier, SalesFilter, SalesInvoiceRow, SalesOverview,
};
use crate::repositories::users::User;
use crate::repositories::Db;
use crate::services::auth;

/// Payment methods Station can record on a sale.
const METHODS: [&str; 3] = ["CASH", "CARD", "CREDIT"];
/// Invoice statuses a manager may narrow the page to.
const STATUSES: [&str; 4] = ["PENDING_PAYMENT", "PAID", "PARTIALLY_PAID", "CREDIT"];

/// The page payload: KPIs, trend and item analysis from one filtered read.
pub fn overview(
    conn: &Db,
    actor: &User,
    filter: &SalesFilter,
    sort: ItemSort,
) -> AppResult<SalesOverview> {
    auth::require_role(actor, "MANAGER")?;
    validate(filter)?;
    Ok(SalesOverview {
        summary: sales_analytics::summary(conn, filter)?,
        trend: sales_analytics::trend(conn, filter)?,
        items: sales_analytics::items(conn, filter, sort, None)?,
    })
}

/// The invoices behind the numbers, for drill-down and for a filtered list.
pub fn invoices(conn: &Db, actor: &User, filter: &SalesFilter) -> AppResult<Vec<SalesInvoiceRow>> {
    auth::require_role(actor, "MANAGER")?;
    validate(filter)?;
    sales_analytics::invoices(conn, filter)
}

/// The cashier options of the filter. Manager-level, like the rest of the page.
pub fn cashiers(conn: &Db, actor: &User) -> AppResult<Vec<SalesCashier>> {
    auth::require_role(actor, "MANAGER")?;
    sales_analytics::cashiers(conn)
}

/// Reject anything outside the closed sets the domain actually stores.
pub fn validate(filter: &SalesFilter) -> AppResult<()> {
    for value in [filter.from(), filter.to()].into_iter().flatten() {
        if !is_iso_date(value) {
            return Err(AppError::validation("sales.invalid_period"));
        }
    }
    if let (Some(from), Some(to)) = (filter.from(), filter.to()) {
        if from > to {
            return Err(AppError::validation("sales.invalid_period"));
        }
    }
    if let Some(method) = filter.method() {
        if !METHODS.contains(&method) {
            return Err(AppError::validation("payment.invalid_method"));
        }
    }
    if let Some(status) = filter.status() {
        if !STATUSES.contains(&status) {
            return Err(AppError::validation("sales.invalid_status"));
        }
    }
    if filter.user_id.is_some_and(|id| id <= 0) {
        return Err(AppError::validation("sales.invalid_cashier"));
    }
    Ok(())
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| matches!(i, 4 | 7) || b.is_ascii_digit())
}
