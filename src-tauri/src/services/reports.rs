//! Core reporting service — ONE source of truth for UI (and Phase 3 exports).
//! Numbers here must reconcile exactly with shift/day closing totals.
//!
//! SCOPE: this module owns the operational closings (today, shift, day) and the
//! audit log. Sales aggregation is NOT here — `sales_by_day` and `product_sales`
//! used to live in this file and were moved to `repositories::sales_analytics`,
//! which is now the single authoritative sales read for the whole application.
//! They are deliberately not re-implemented here: two sales aggregations would
//! be two sets of financial rules.

use crate::error::AppResult;
use crate::repositories::analytics::AnalyticsCharts;
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
