//! Analytics chart aggregations for the Reports → Charts tab.
//!
//! Every number is computed from persisted production tables (invoices,
//! payments, business_days, expenses) with the same revenue rules the day/
//! shift closings use: cash/card revenue comes from the `payments` ledger, and
//! credit never counts as settled cash/card.

use crate::error::AppResult;
use crate::repositories::Db;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsCategoryValue {
    pub id: String,
    pub value: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsChartValue {
    pub id: String,
    pub total: i64,
    pub has_data: bool,
    pub categories: Vec<AnalyticsCategoryValue>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsCharts {
    pub charts: Vec<AnalyticsChartValue>,
}

pub fn analytics_charts(
    conn: &Db,
    from: Option<&str>,
    to: Option<&str>,
) -> AppResult<AnalyticsCharts> {
    let laundry = department_sales(conn, from, to, "wash_total")?;
    let cafe = department_sales(conn, from, to, "cafe_total")?;
    let cash = payment_sum(conn, from, to, "CASH")?;
    let card = payment_sum(conn, from, to, "CARD")?;
    let sales = sales_total(conn, from, to)?;
    let expenses = expenses_total(conn, from, to)?;
    Ok(AnalyticsCharts {
        charts: vec![
            chart("laundry-cafe", vec![("laundry", laundry), ("cafe", cafe)]),
            chart("cash-visa", vec![("cash", cash), ("visa", card)]),
            chart(
                "sales-expenses",
                vec![("sales", sales), ("expenses", expenses)],
            ),
        ],
    })
}

fn chart(id: &str, values: Vec<(&str, i64)>) -> AnalyticsChartValue {
    let total = values.iter().map(|(_, value)| *value).sum();
    AnalyticsChartValue {
        id: id.to_string(),
        total,
        has_data: total > 0,
        categories: values
            .into_iter()
            .map(|(id, value)| AnalyticsCategoryValue {
                id: id.to_string(),
                value,
            })
            .collect(),
    }
}

/// Business-day range predicate; `from`/`to` are ISO dates, empty means unbounded.
/// `offset` reserves placeholders that the caller prefixes (e.g. a payment method).
fn day_range(
    alias: &str,
    from: Option<&str>,
    to: Option<&str>,
    offset: usize,
) -> (String, Vec<String>) {
    let mut sql = String::new();
    let mut args = Vec::new();
    if let Some(value) = from.filter(|value| !value.is_empty()) {
        args.push(value.to_string());
        sql.push_str(&format!(
            " AND {alias}.day_date >= ?{}",
            offset + args.len()
        ));
    }
    if let Some(value) = to.filter(|value| !value.is_empty()) {
        args.push(value.to_string());
        sql.push_str(&format!(
            " AND {alias}.day_date <= ?{}",
            offset + args.len()
        ));
    }
    (sql, args)
}

fn expense_range(from: Option<&str>, to: Option<&str>) -> (String, Vec<String>) {
    let mut sql = String::new();
    let mut args = Vec::new();
    if let Some(value) = from.filter(|value| !value.is_empty()) {
        args.push(value.to_string());
        sql.push_str(&format!(" AND e.expense_date >= ?{}", args.len()));
    }
    if let Some(value) = to.filter(|value| !value.is_empty()) {
        args.push(value.to_string());
        sql.push_str(&format!(" AND e.expense_date <= ?{}", args.len()));
    }
    (sql, args)
}

fn query_total(conn: &Db, sql: &str, args: &[String]) -> AppResult<i64> {
    let refs: Vec<&dyn rusqlite::ToSql> = args
        .iter()
        .map(|value| value as &dyn rusqlite::ToSql)
        .collect();
    Ok(conn.query_row(sql, refs.as_slice(), |r| r.get(0))?)
}

/// Cafe/wash split from the immutable invoice snapshot totals.
fn department_sales(
    conn: &Db,
    from: Option<&str>,
    to: Option<&str>,
    column: &str,
) -> AppResult<i64> {
    debug_assert!(matches!(column, "cafe_total" | "wash_total"));
    let (filter, args) = day_range("d", from, to, 0);
    query_total(
        conn,
        &format!(
            "SELECT COALESCE(SUM(i.{column}), 0)
             FROM invoices i JOIN business_days d ON d.id = i.business_day_id WHERE 1=1{filter}"
        ),
        &args,
    )
}

/// Cash/card revenue from the payment ledger.
fn payment_sum(conn: &Db, from: Option<&str>, to: Option<&str>, method: &str) -> AppResult<i64> {
    debug_assert!(matches!(method, "CASH" | "CARD"));
    let (filter, mut args) = day_range("d", from, to, 1);
    args.insert(0, method.to_string());
    query_total(
        conn,
        &format!(
            "SELECT COALESCE(SUM(p.amount), 0)
             FROM payments p JOIN invoices i ON i.id = p.invoice_id
             JOIN business_days d ON d.id = i.business_day_id
             WHERE p.method = ?1{filter}"
        ),
        &args,
    )
}

fn sales_total(conn: &Db, from: Option<&str>, to: Option<&str>) -> AppResult<i64> {
    let (filter, args) = day_range("d", from, to, 0);
    query_total(
        conn,
        &format!(
            "SELECT COALESCE(SUM(i.total), 0)
             FROM invoices i JOIN business_days d ON d.id = i.business_day_id WHERE 1=1{filter}"
        ),
        &args,
    )
}

fn expenses_total(conn: &Db, from: Option<&str>, to: Option<&str>) -> AppResult<i64> {
    let (filter, args) = expense_range(from, to);
    query_total(
        conn,
        &format!("SELECT COALESCE(SUM(e.amount), 0) FROM expenses e WHERE 1=1{filter}"),
        &args,
    )
}
