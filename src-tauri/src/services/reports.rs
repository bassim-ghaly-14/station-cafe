//! Core reporting service — ONE source of truth for UI (and Phase 3 exports).
//! Numbers here must reconcile exactly with shift/day closing totals.

use crate::error::AppResult;
use crate::repositories::shifts::{self, DayTotals, ShiftRow};
use crate::repositories::Db;
use rusqlite::params;
use serde::Serialize;

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
        "SELECT COUNT(*) FROM inventory_items WHERE quantity <= min_quantity",
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
pub struct SalesByDay {
    pub day_id: i64,
    pub day_date: String,
    pub invoices_count: i64,
    pub cafe_sales: i64,
    pub wash_sales: i64,
    pub total_sales: i64,
    pub cash: i64,
    pub card: i64,
    pub credit: i64,
    pub service_charges: i64,
    pub discounts: i64,
    pub expenses: i64,
}

pub fn sales_by_day(conn: &Db, from: &str, to: &str) -> AppResult<Vec<SalesByDay>> {
    let mut stmt = conn.prepare(
        "SELECT d.id, d.day_date,
            COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.cafe_total ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.wash_total ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.total ELSE 0 END), 0),
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN invoices i2 ON i2.id = p.invoice_id
              WHERE i2.business_day_id = d.id AND p.method = 'CASH'),
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN invoices i2 ON i2.id = p.invoice_id
              WHERE i2.business_day_id = d.id AND p.method = 'CARD'),
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN invoices i2 ON i2.id = p.invoice_id
              WHERE i2.business_day_id = d.id AND p.method = 'CREDIT'),
            COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.service_charge ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN i.status != 'CANCELLED' THEN i.discount_minor ELSE 0 END), 0),
            (SELECT COALESCE(SUM(e.amount),0) FROM expenses e WHERE e.business_day_id = d.id)
         FROM business_days d
         LEFT JOIN invoices i ON i.business_day_id = d.id
         WHERE d.day_date BETWEEN ?1 AND ?2
         GROUP BY d.id ORDER BY d.day_date",
    )?;
    let rows = stmt.query_map(params![from, to], |r| {
        Ok(SalesByDay {
            day_id: r.get(0)?,
            day_date: r.get(1)?,
            invoices_count: r.get(2)?,
            cafe_sales: r.get(3)?,
            wash_sales: r.get(4)?,
            total_sales: r.get(5)?,
            cash: r.get(6)?,
            card: r.get(7)?,
            credit: r.get(8)?,
            service_charges: r.get(9)?,
            discounts: r.get(10)?,
            expenses: r.get(11)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[derive(Debug, Serialize)]
pub struct ProductSales {
    pub product_name: String,
    pub department: String,
    pub quantity: i64,
    pub total: i64,
}

/// Product/service sales from IMMUTABLE invoice snapshots (never from the
/// mutable catalog), so historical reports cannot drift.
pub fn product_sales(conn: &Db, from: &str, to: &str) -> AppResult<Vec<ProductSales>> {
    let mut stmt = conn.prepare(
        "SELECT l.product_name, l.department, SUM(l.quantity), SUM(l.line_total)
         FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
         WHERE i.status != 'CANCELLED' AND date(i.created_at) BETWEEN ?1 AND ?2
         GROUP BY l.product_name, l.department
         ORDER BY SUM(l.line_total) DESC LIMIT 100",
    )?;
    let rows = stmt.query_map(params![from, to], |r| {
        Ok(ProductSales {
            product_name: r.get(0)?,
            department: r.get(1)?,
            quantity: r.get(2)?,
            total: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
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
    let s = shifts::get_shift(conn, shift_id)?
        .ok_or_else(|| crate::error::AppError::not_found("shift.not_found"))?;
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
    let totals = shifts::day_totals(conn, day_id)?;
    let shift_list = shifts::shifts_of_day(conn, day_id)?;
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
