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
    /// Cash expected in the drawer = shift openings + cash sales − expenses.
    pub expected_drawer_cash: i64,
    pub cash_differences: i64,
    pub stock_alerts: i64,
}

pub fn today_summary(conn: &Db) -> AppResult<TodaySummary> {
    let day = shifts::current_day(conn)?;
    let (totals, shift_list) = match &day {
        Some(d) => (
            shifts::day_totals(conn, d.id)?,
            shifts::shifts_of_day(conn, d.id)?,
        ),
        None => (DayTotals::default(), Vec::new()),
    };
    let openings: i64 = shift_list.iter().map(|s| s.opening_cash).sum();
    let cash_diffs: i64 = shift_list.iter().filter_map(|s| s.cash_difference).sum();
    let cash_expenses: i64 = match &day {
        Some(d) => conn.query_row(
            "SELECT COALESCE(SUM(amount),0) FROM expenses WHERE business_day_id = ?1",
            [d.id],
            |r| r.get(0),
        )?,
        None => 0,
    };
    let stock_alerts: i64 = conn.query_row(
        "SELECT COUNT(*) FROM inventory_items i
         JOIN products p ON p.id = i.product_id
         WHERE p.track_inventory = 1 AND i.quantity <= i.min_quantity",
        [],
        |r| r.get(0),
    )?;
    Ok(TodaySummary {
        expected_drawer_cash: openings + totals.cash - cash_expenses,
        cash_differences: cash_diffs,
        stock_alerts,
        day,
        totals,
        shifts: shift_list,
    })
}

#[derive(Debug, Serialize)]
pub struct ShiftReport {
    pub shift: ShiftRow,
    pub invoices_count: i64,
    pub cash_sales: i64,
    pub card_sales: i64,
    pub credit_sales: i64,
    pub service_charges: i64,
    pub discounts: i64,
    pub expected_cash: i64,
    pub actual_cash: Option<i64>,
    pub difference: Option<i64>,
}

pub fn shift_report(conn: &Db, shift_id: i64) -> AppResult<ShiftReport> {
    let mut s = shifts::get_shift(conn, shift_id)?
        .ok_or_else(|| crate::error::AppError::not_found("shift.not_found"))?;
    // An ACTIVE shift has no persisted closing snapshot yet, so its report is
    // hydrated from live transactions. A CLOSED shift is served straight from
    // the immutable snapshot written at close time and is never recomputed —
    // that is what keeps historical shift reports reproducible.
    shifts::hydrate_active_totals(conn, &mut s)?;
    Ok(ShiftReport {
        invoices_count: s.invoices_count,
        cash_sales: s.cash_sales,
        card_sales: s.card_sales,
        credit_sales: s.credit_sales,
        service_charges: s.service_charges,
        discounts: s.discounts,
        expected_cash: s.expected_cash,
        actual_cash: s.actual_cash,
        difference: s.cash_difference,
        shift: s,
    })
}

#[derive(Debug, Serialize)]
pub struct DayReport {
    pub day: shifts::BusinessDay,
    pub totals: DayTotals,
    pub shifts: Vec<ShiftRow>,
    pub expected_drawer_cash: i64,
    pub cash_differences: i64,
}

pub fn day_report(conn: &Db, day_id: i64) -> AppResult<DayReport> {
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
    let shift_list = shifts::shifts_of_day(conn, day_id)?;
    let totals = if day.status == "CLOSED" {
        shifts::final_day_totals(conn, day_id)?
            .ok_or_else(|| crate::error::AppError::not_found("day.closing_not_found"))?
    } else {
        shifts::day_totals(conn, day_id)?
    };
    let openings: i64 = shift_list.iter().map(|s| s.opening_cash).sum();
    let diffs: i64 = shift_list.iter().filter_map(|s| s.cash_difference).sum();
    Ok(DayReport {
        expected_drawer_cash: openings + totals.cash - totals.expenses,
        cash_differences: diffs,
        day,
        totals,
        shifts: shift_list,
    })
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
