//! Core reporting service — ONE source of truth for UI (and Phase 3 exports).
//! Numbers here must reconcile exactly with shift/day closing totals.
//!
//! SCOPE: this module owns the operational closings (today, shift, day) and the
//! audit log. Sales aggregation is NOT here — `sales_by_day` and `product_sales`
//! used to live in this file and were moved to `repositories::sales_analytics`,
//! which is now the single authoritative sales read for the whole application.
//! They are deliberately not re-implemented here: two sales aggregations would
//! be two sets of financial rules.

use crate::error::{AppError, AppResult};
use crate::repositories::analytics::AnalyticsCharts;
use crate::repositories::expenses;
use crate::repositories::sales_analytics;
use crate::repositories::shifts::{self, DayTotals, ShiftRow};
use crate::repositories::Db;
use serde::Serialize;

pub fn analytics_charts(
    conn: &Db,
    from: Option<&str>,
    to: Option<&str>,
) -> AppResult<AnalyticsCharts> {
    crate::repositories::analytics::analytics_charts(conn, from, to)
}

#[derive(Debug, Serialize)]
pub struct TodaySummary {
    pub day: Option<shifts::BusinessDay>,
    pub totals: DayTotals,
    pub shifts: Vec<ShiftRow>,
    /// Cash expected in the drawer = shift openings + cash sales − cash expenses.
    ///
    /// Computed from the shifts' OWN expense rows, so an expense is only counted
    /// once and never against a shift it was not booked to. This is the live
    /// operational view; the closing documents use the persisted snapshot.
    pub expected_drawer_cash: i64,
    /// Signed sum of the shifts' recorded differences.
    pub cash_differences: i64,
    pub stock_alerts: i64,
}

pub fn today_summary(conn: &Db) -> AppResult<TodaySummary> {
    let day = shifts::current_day(conn)?;
    let (totals, mut shift_list) = match &day {
        Some(d) => (
            shifts::day_totals(conn, d.id)?,
            shifts::shifts_of_day(conn, d.id)?,
        ),
        None => (DayTotals::default(), Vec::new()),
    };
    // An ACTIVE shift has no persisted snapshot yet, so its aggregate columns are
    // still defaults. Hydrating it here is what makes this live header state the
    // same drawer the POS card and the closing dialog show — including the cash
    // expenses booked to that shift. A CLOSED shift is left untouched.
    for shift in shift_list.iter_mut() {
        shifts::hydrate_active_totals(conn, shift)?;
    }
    // Each shift resolves the drawer through the ONE shared formula, so the day
    // figure is the sum of the shifts' own expected cash rather than a second,
    // independently written expression of the same arithmetic.
    let expected_drawer_cash: i64 = shift_list.iter().map(|s| s.expected_cash).sum();
    let cash_differences: i64 = shift_list
        .iter()
        .map(|s| s.cash_difference.unwrap_or(0))
        .sum();
    let stock_alerts: i64 = conn.query_row(
        "SELECT COUNT(*) FROM inventory_items i
         JOIN products p ON p.id = i.product_id
         WHERE p.track_inventory = 1
           AND p.deleted_at IS NULL
           AND i.quantity <= i.min_quantity",
        [],
        |r| r.get(0),
    )?;
    Ok(TodaySummary {
        expected_drawer_cash,
        cash_differences,
        stock_alerts,
        day,
        totals,
        shifts: shift_list,
    })
}

/// The shift-closing report. This is a thin ALIAS of the reconciliation
/// module's struct: there is exactly one report type, so the screen, the
/// preview and the printer cannot drift apart.
pub type ShiftReport = crate::services::reconciliation::ShiftReconciliation;
pub type DayReport = crate::services::reconciliation::DayReconciliation;

pub fn shift_report(
    conn: &Db,
    shift_id: i64,
) -> AppResult<crate::services::reconciliation::ShiftReconciliation> {
    crate::services::reconciliation::shift_report(conn, shift_id)
}

/// The day-closing report.
///
/// A CLOSED day is served from its immutable persisted final snapshot, so the
/// document always states the figures that were true at closing time even if
/// configuration changes later. An OPEN day is reported LIVE from the settled
/// shifts the inclusion rule selects, with any open shifts explicitly excluded.
pub fn day_report(
    conn: &Db,
    day_id: i64,
) -> AppResult<crate::services::reconciliation::DayReconciliation> {
    let day: shifts::BusinessDay = conn
        .query_row(
            "SELECT id, day_date, status, opened_at, closed_at FROM business_days WHERE id = ?1",
            [day_id],
            |r| {
                Ok(shifts::BusinessDay {
                    id: r.get(0)?,
                    day_date: r.get(1)?,
                    status: r.get(2)?,
                    opened_at: r.get(3)?,
                    closed_at: r.get(4)?,
                })
            },
        )
        .map_err(|_| crate::error::AppError::not_found("day.not_found"))?;
    if day.status == "CLOSED" {
        return shifts::final_day_report(conn, day);
    }
    // An open day: aggregate exactly its settled shifts, using the SAME
    // inclusion rule `close_day` will apply.
    let all = shifts::shifts_of_day(conn, day_id)?;
    let (settled, open): (Vec<ShiftRow>, Vec<ShiftRow>) =
        all.into_iter().partition(|s| s.status == "CLOSED");
    let ids: Vec<i64> = settled.iter().map(|s| s.id).collect();
    let mut report =
        crate::services::reconciliation::aggregate_day(conn, day.clone(), &ids, &settled)?;
    report.open_shift_count = open.len() as i64;
    Ok(report)
}

#[derive(Debug, Serialize)]
pub struct AuditEntry {
    pub id: i64,
    pub actor_id: Option<i64>,
    pub actor_name: Option<String>,
    pub actor_role: Option<String>,
    pub action: String,
    pub entity_type: String,
    pub entity_id: Option<String>,
    pub after_json: Option<String>,
    pub created_at: String,
}

pub fn list_audit(conn: &Db, limit: i64, action_like: Option<&str>) -> AppResult<Vec<AuditEntry>> {
    let mut sql = String::from(
        "SELECT a.id, a.actor_id, u.name, a.actor_role, a.action, a.entity_type, a.entity_id,
                a.after_json, a.created_at
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE 1=1",
    );
    let mut args: Vec<String> = Vec::new();
    if let Some(like) = action_like {
        args.push(format!("%{like}%"));
        sql.push_str(" AND a.action LIKE ?1");
    }
    args.push(limit.clamp(1, 500).to_string());
    sql.push_str(&format!(" ORDER BY a.id DESC LIMIT ?{}", args.len()));
    let mut stmt = conn.prepare(&sql)?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(refs.as_slice(), |r| {
        Ok(AuditEntry {
            id: r.get(0)?,
            actor_id: r.get(1)?,
            actor_name: r.get(2)?,
            actor_role: r.get(3)?,
            action: r.get(4)?,
            entity_type: r.get(5)?,
            entity_id: r.get(6)?,
            after_json: r.get(7)?,
            created_at: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

// ---------------------------------------------------------------------------
// MONTHLY EXECUTIVE REPORT
//
// A COMPOSITION, not a calculation. Every figure below is read whole from the
// module that already owns it:
//
//   - revenue, cafe revenue, wash revenue → `sales_analytics::monthly` (the
//     invoice snapshot, grouped by Cairo business month);
//   - expenses                             → `expenses::total` (the same period
//     total the Expenses KPI band prints);
//   - the two targets                      → `settings::resolve_monthly_target`,
//     so a month's override applies here exactly as it does on the Sales page;
//   - the achievement percentages          → `sales::achievement_hundredths`.
//
// It deliberately defines NO rule of its own. If a figure is not already
// produced by one of those, this module does not invent it — which is why the
// payload carries no chart series, no category ranking and no payment split:
// those already exist elsewhere, and repeating them here would only be a second
// set of numbers free to drift.
//
// # Why there is no single "overall target"
//
// Station has two INDEPENDENT monthly targets and no global one. Cafe and Wash
// are reported separately and are never summed, averaged or weighted into a
// combined achievement: a fabricated global percentage is the single most
// misleading figure this report could print, so it is not printed at all.

/// One department's month: what it earned, what it was aimed at, and how far
/// along it is.
#[derive(Debug, Clone, Serialize)]
pub struct MonthlyPerformance {
    /// The department's revenue for the month, from the invoice snapshot.
    pub actual_minor: i64,
    /// The month's EFFECTIVE target, override applied — never the bare default.
    pub target_minor: i64,
    /// Whether this month overrides the cafe-wide default for this department.
    pub overridden: bool,
    /// `actual / target * 100` to two decimals; `None` when there is no target,
    /// which is the ONE representation of "no target" in Station.
    pub achievement_percent: Option<String>,
}

/// One month's money, in piastres.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct MonthlyMoney {
    pub revenue_minor: i64,
    pub expenses_minor: i64,
    /// `revenue_minor - expenses_minor`. Station derives no profit, margin or
    /// tax anywhere, so this is the plain difference of the two figures above
    /// and nothing else — no service-charge or deduction rule is introduced.
    pub net_minor: i64,
}

/// The whole executive summary of ONE business month.
#[derive(Debug, Clone, Serialize)]
pub struct MonthlyExecutiveReport {
    /// The business month, `YYYY-MM`.
    pub month: String,
    /// First business date of the month, inclusive.
    pub from: String,
    /// Last business date actually READ: today while the month is in progress,
    /// so a part-month is never presented as a whole one.
    pub to: String,
    /// The month immediately before this one — the movement comparison.
    pub previous_month: String,
    pub cafe: MonthlyPerformance,
    pub wash: MonthlyPerformance,
    pub money: MonthlyMoney,
    /// The same three figures for `previous_month`.
    pub previous: MonthlyMoney,
}

/// The month's revenue split by department, exactly as the monthly aggregation
/// reports it (`cafe_total` and `wash_total` on the invoice snapshot).
#[derive(Debug, Clone, Copy, Default)]
struct DepartmentSplit {
    cafe_minor: i64,
    wash_minor: i64,
}

/// The month as it is read: its business dates, capped at today while it is
/// still in progress — the same cut-off `sales::target_progress` applies, so a
/// report and the Sales page always stop reading on the same day.
fn month_read_window(month: &str) -> AppResult<(String, String)> {
    let (from, month_last_day) = crate::time::business_month_bounds(month)
        .ok_or_else(|| AppError::validation("settings.invalid_month"))?;
    let today = crate::time::today_business_date();
    let to = if today < month_last_day {
        today
    } else {
        month_last_day
    };
    Ok((from, to))
}

/// One business month's money and department split, through the EXISTING reads.
///
/// A month that never traded reads as zeroes rather than failing: a quiet month
/// is a fact, not an error, and the monthly aggregation already keeps a trading
/// month with no invoices as a zero row.
fn month_money(conn: &Db, month: &str) -> AppResult<(MonthlyMoney, DepartmentSplit)> {
    let (from, to) = month_read_window(month)?;
    // ONE grouped query over the invoice snapshot yields both the month's totals
    // and its cafe/wash split, so the two can never describe different invoices.
    let row = sales_analytics::monthly(conn, &from, &to)?
        .into_iter()
        .find(|row| row.month == month);
    let revenue_minor = row.as_ref().map(|row| row.total_sales).unwrap_or(0);
    // The existing expense period total — the same aggregation the Expenses
    // workspace prints, so the two can never state different spend.
    let expenses_minor = expenses::total(conn, Some(&from), Some(&to), false)?;
    Ok((
        MonthlyMoney {
            revenue_minor,
            expenses_minor,
            net_minor: revenue_minor - expenses_minor,
        },
        DepartmentSplit {
            cafe_minor: row.as_ref().map(|row| row.cafe_sales).unwrap_or(0),
            wash_minor: row.as_ref().map(|row| row.wash_sales).unwrap_or(0),
        },
    ))
}

/// One department's performance, from the RESOLVED target for that month and the
/// revenue actually earned — the same two inputs, and the same rounding, the
/// Sales page's target progress uses.
fn department_performance(
    conn: &Db,
    month: &str,
    department: crate::services::settings::RevenueDepartment,
    actual_minor: i64,
) -> AppResult<MonthlyPerformance> {
    let target = crate::services::settings::resolve_monthly_target(conn, month, department)?;
    let hundredths =
        crate::services::sales::achievement_hundredths(actual_minor, target.target_minor);
    Ok(MonthlyPerformance {
        actual_minor,
        target_minor: target.target_minor,
        overridden: target.overridden,
        achievement_percent: crate::services::sales::percentage_hundredths(hundredths),
    })
}

/// The whole executive summary of ONE business month.
///
/// `month` absent means the current business month, resolved by Station's own
/// clock — never from the browser and never from a page date picker, which
/// scopes a different question.
///
/// Manager-level, like every other read on this page: these are the same
/// financial figures `analytics_charts` and the Sales workspace already expose
/// to a manager, so the existing gate applies and no new permission is invented.
pub fn monthly_executive(
    conn: &Db,
    actor: &crate::repositories::users::User,
    month: Option<&str>,
) -> AppResult<MonthlyExecutiveReport> {
    crate::services::auth::require_role(actor, "MANAGER")?;
    let month = match month {
        Some(value) => value.trim().to_string(),
        None => crate::time::current_business_month(),
    };
    let (from, to) = month_read_window(&month)?;
    let previous_month = crate::time::previous_business_month(&month)
        .ok_or_else(|| AppError::validation("settings.invalid_month"))?;

    let (money, split) = month_money(conn, &month)?;
    // The previous month is read only for its money: the targets belong to the
    // month being reported, and comparing two targets would be the "overall
    // achievement" this module refuses to invent.
    let (previous, _) = month_money(conn, &previous_month)?;

    Ok(MonthlyExecutiveReport {
        cafe: department_performance(
            conn,
            &month,
            crate::services::settings::RevenueDepartment::Cafe,
            split.cafe_minor,
        )?,
        wash: department_performance(
            conn,
            &month,
            crate::services::settings::RevenueDepartment::Wash,
            split.wash_minor,
        )?,
        money,
        previous,
        month,
        from,
        to,
        previous_month,
    })
}
