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
    self, ItemSort, SalesCashier, SalesFilter, SalesInvoiceRow, SalesMonthRow, SalesOverview,
};
use crate::repositories::users::User;
use crate::repositories::Db;
use crate::services::auth;
use crate::services::settings::{self, MonthlySalesPeriodConfig};
use crate::time;
use serde::{Deserialize, Serialize};

/// Payment methods Station can record on a sale.
const METHODS: [&str; 3] = ["CASH", "CARD", "CREDIT"];
/// Invoice statuses a manager may narrow the page to.
const STATUSES: [&str; 4] = ["PENDING_PAYMENT", "PAID", "PARTIALLY_PAID", "CREDIT"];

/// The monthly Cafe-vs-Wash revenue series, with the period it describes.
///
/// The period is a TRAILING CALENDAR WINDOW, derived here from Station's own
/// business clock, and it travels with the data so the chart can label what it
/// is showing without inventing a period of its own.
///
/// WHY THIS IGNORES `SalesFilter` (and therefore the Sales page date picker):
/// this report is a monthly comparison between two business lines. Slicing a
/// calendar series by an arbitrary business-day range produces half-months and
/// an unreadable comparison, and wiring it to the page filter would silently
/// change the meaning of every bar. The page's date picker scopes the KPIs, the
/// daily trend, the item analysis and the invoice list — this series states its
/// own period instead, and says so on screen.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SalesMonthlyReport {
    /// First business date of the window, inclusive.
    pub from: String,
    /// Last business date of the window, inclusive (today).
    pub to: String,
    /// Ascending by `month` (`YYYY-MM`).
    pub months: Vec<SalesMonthRow>,
}

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

/// The monthly Cafe-vs-Wash series over the window configured in Dev Settings.
///
/// Manager-level, like the rest of the page.
///
/// The month count is NOT a rule of this service: it is the persisted
/// `monthly_sales_period` setting, read through the same typed accessor as every
/// other Station setting. `months` lets a caller state it explicitly (the UI does,
/// so the screen and the query always agree); when it is absent the stored
/// setting is used, and an installation that never configured it reads the
/// default — a full trading year — exactly as before.
///
/// The count is INCLUSIVE of the current month, so the window is
/// `business_date_months_ago(months - 1) .. today`: 6 covers the current month
/// and the five before it, 12 covers a trading year. It is re-validated here, so
/// an out-of-range value is refused by the server no matter where it came from.
pub fn monthly(conn: &Db, actor: &User, months: Option<i64>) -> AppResult<SalesMonthlyReport> {
    auth::require_role(actor, "MANAGER")?;
    let config = match months {
        Some(value) => MonthlySalesPeriodConfig { months: value },
        None => settings::get_monthly_sales_period(conn)?,
    };
    config.validate()?;
    // The window is inclusive on both ends: the first day of the month
    // `months - 1` back, through today.
    let from = time::business_date_months_ago(config.months - 1);
    let to = time::today_business_date();
    Ok(SalesMonthlyReport {
        months: sales_analytics::monthly(conn, &from, &to)?,
        from,
        to,
    })
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
