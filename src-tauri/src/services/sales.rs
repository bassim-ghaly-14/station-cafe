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

// ---------------------------------------------------------------------------
// MONTHLY TARGET PROGRESS
//
// One read for the Sales page's target section: the month's effective CAFE and
// WASH targets, the revenue actually achieved against each, what is still
// missing, and the day-by-day path there.
//
// WHY IT IS THE CURRENT BUSINESS MONTH ONLY: a target is a MONTHLY target, and
// the page answers "how is this month going". The month is resolved here, in
// Rust, from Station's own clock — never from a browser date and never from the
// page's date picker, which scopes a different question (what happened in an
// arbitrary range).
//
// WHY IT REUSES `sales_analytics::trend`: that is already the canonical daily
// cafe/wash aggregation over the invoice snapshot, grouped by business day, in
// ONE grouped query. Target progress is a different PRESENTATION of the same
// revenue, not a second revenue rule: cafe money comes from `cafe_total`, wash
// money from `wash_total`, service charges are in neither, and a hybrid invoice
// splits exactly as it does everywhere else in the application.

/// The whole month's days in one query — at most 31 rows, never a query per day.
const MONTH_TREND_LIMIT: usize = 31;

/// One business day of the month's progress.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetDayRow {
    /// The business date, `YYYY-MM-DD`.
    pub day_date: String,
    /// That day's CAFE revenue, from the `cafe_total` snapshot.
    pub cafe_revenue: i64,
    /// That day's WASH revenue, from the `wash_total` snapshot.
    pub wash_revenue: i64,
    /// CAFE revenue from the first of the month through this day.
    pub cafe_cumulative: i64,
    /// WASH revenue from the first of the month through this day.
    pub wash_cumulative: i64,
    /// Cumulative CAFE achievement against the FULL monthly target, in
    /// hundredths of a percent. There is no per-day target: the owner set one
    /// number for the month, and each day reports how much of THAT number has
    /// been earned so far. `None` when there is no target to measure against.
    pub cafe_achievement_hundredths: Option<i64>,
    /// The same for WASH.
    pub wash_achievement_hundredths: Option<i64>,
}

/// How one department is doing against its monthly target.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepartmentTargetProgress {
    pub department: String,
    /// The effective target for THIS month, in minor units.
    pub target_minor: i64,
    /// Whether this month overrides the cafe-wide default for this department.
    pub overridden: bool,
    /// Revenue achieved in the month so far, in minor units.
    pub actual_minor: i64,
    /// What is still missing, floored at zero: an over-achieved month has
    /// nothing remaining, and its surplus is visible in `achievement_percent`.
    pub remaining_minor: i64,
    /// `actual / target * 100`, to two decimal places (see
    /// [`percentage_hundredths`]). `None` when the target is zero.
    pub achievement_percent: Option<String>,
    /// Achievement as hundredths of a percent, for callers that need the number
    /// rather than the display. `None` when the target is zero — the ONE place
    /// the "no target" state is represented, so no caller invents its own.
    pub achievement_hundredths: Option<i64>,
}

/// The month's progress, for both departments and every day of it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonthlyTargetProgress {
    /// The business month this describes, `YYYY-MM`.
    pub month: String,
    /// First business date of the month, inclusive.
    pub from: String,
    /// Last business date read: today for the current month, so the series stops
    /// at the last day that has actually happened.
    pub to: String,
    pub cafe: DepartmentTargetProgress,
    pub wash: DepartmentTargetProgress,
    /// Ascending by `day_date`. A day with no business day at all is absent —
    /// there is no trading to report.
    pub daily: Vec<TargetDayRow>,
}
/// Achievement percentage, in hundredths of a percent (`11429` = 114.29%).
///
/// Integer arithmetic throughout, using the canonical `div_round`, so the same
/// revenue and target always produce the same number. A target of zero returns
/// `None`: there is no achievement to report against no target, and inventing
/// `0%` would state that nothing was achieved when in fact nothing was measured.
///
/// `pub(crate)` because a report reads the SAME rule rather than writing a
/// second one: an achievement that the Sales page and a printed report computed
/// differently would be two facts about the same month.
pub(crate) fn achievement_hundredths(actual: i64, target: i64) -> Option<i64> {
    if target <= 0 {
        return None;
    }
    // `actual * 10_000 / target` is `actual / target * 100`, expressed in
    // hundredths of a percent. `div_round` is half-up, so 87,500 against
    // 175,000 reads exactly 50.00%.
    Some(crate::money::div_round(actual * 10_000, target))
}

/// The percent as the UI states it: two decimals and no unit suffix, so an
/// over-achieved month reads `114.29` and is never clamped to `100.00`.
///
/// `pub(crate)` for the same reason as [`achievement_hundredths`]: the printed
/// wording of a percentage is a presentation rule the report shares.
pub(crate) fn percentage_hundredths(hundredths: Option<i64>) -> Option<String> {
    hundredths.map(|value| format!("{}.{:02}", value / 100, value.abs() % 100))
}

/// One department's figures, from its resolved target and its achieved revenue.
fn department_progress(
    target: settings::MonthlyTarget,
    actual: i64,
) -> DepartmentTargetProgress {
    let hundredths = achievement_hundredths(actual, target.target_minor);
    DepartmentTargetProgress {
        department: target.department,
        target_minor: target.target_minor,
        overridden: target.overridden,
        actual_minor: actual,
        // A month that has passed its target has nothing left to earn toward it;
        // reporting a negative "remaining" would read as a shortfall.
        remaining_minor: (target.target_minor - actual).max(0),
        achievement_percent: percentage_hundredths(hundredths),
        achievement_hundredths: hundredths,
    }
}

/// The current business month's target progress. Manager-level, like the rest
/// of the Sales page.
pub fn target_progress(conn: &Db, actor: &User) -> AppResult<MonthlyTargetProgress> {
    auth::require_role(actor, "MANAGER")?;

    // The month identity, resolved by the backend clock. The browser's timezone
    // and the page's date filter are both deliberately not consulted.
    let month = time::current_business_month();
    let (from, month_last_day) = time::business_month_bounds(&month)
        .ok_or_else(|| AppError::internal("current business month is not a real month"))?;
    // The month is read only as far as it has actually happened.
    let today = time::today_business_date();
    let to = if today < month_last_day {
        today
    } else {
        month_last_day
    };

    // Targets come from the ONE resolver, for both departments. They are
    // resolved BEFORE the daily series is built so each day can report its own
    // cumulative achievement against the same effective target.
    let [cafe_target, wash_target] = settings::resolve_monthly_targets(conn, &month)?;

    // The canonical revenue: the existing daily aggregation, scoped to this
    // month's business days, in ONE query.
    let days = sales_analytics::trend(
        conn,
        &SalesFilter {
            from: Some(from.clone()),
            to: Some(to.clone()),
            ..SalesFilter::default()
        },
    )?;
    // A calendar month cannot hold more than 31 days, but the series is bounded
    // anyway so no malformed range can grow the payload without limit.
    let days = days.into_iter().take(MONTH_TREND_LIMIT);

    // Cumulative is a running sum over the days in order — the arithmetic a
    // manager would do, performed once here so no caller repeats it.
    let mut cafe_running = 0;
    let mut wash_running = 0;
    let mut daily = Vec::new();
    for day in days {
        cafe_running += day.cafe_sales;
        wash_running += day.wash_sales;
        daily.push(TargetDayRow {
            day_date: day.day_date,
            cafe_revenue: day.cafe_sales,
            wash_revenue: day.wash_sales,
            cafe_cumulative: cafe_running,
            wash_cumulative: wash_running,
            cafe_achievement_hundredths: achievement_hundredths(cafe_running, cafe_target.target_minor),
            wash_achievement_hundredths: achievement_hundredths(wash_running, wash_target.target_minor),
        });
    }

    Ok(MonthlyTargetProgress {
        cafe: department_progress(cafe_target, cafe_running),
        wash: department_progress(wash_target, wash_running),
        month,
        from,
        to,
        daily,
    })
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
