//! Sales management aggregations — the single source of truth for the Sales page.
//!
//! Every figure is a SQL aggregate over the persisted production tables. The
//! rules below are the ones already established by `repositories::analytics` and
//! `repositories::shifts`, restated here because a sales report is historical
//! financial data and must not drift:
//!
//! - **Every invoice counts.** Station has no cancelled invoice: the lifecycle
//!   is raised, then settled in full, in part, or on credit, and there is no
//!   other outcome. Every persisted invoice is therefore a real document and
//!   belongs in every figure below — there is no defensive exclusion to apply.
//! - **Money is the immutable invoice snapshot** (`subtotal`, `discount_minor`,
//!   `service_charge`, `total`, `cafe_total`, `wash_total`). Nothing is
//!   recomputed from the mutable catalog, the customer row or the shift.
//! - **`total` is the authoritative revenue.** Checkout persists
//!   `total = subtotal - discount + service_charge`, so `total` is already net
//!   of discounts and inclusive of service charges. Station stores no cost data,
//!   so no margin, profit or COGS is derived anywhere in this module.
//! - **Cash / card / credit come from the `payments` ledger**, so settled money
//!   and invoiced-but-unsettled money are never mixed. A `CREDIT` invoice keeps
//!   `paid_amount = 0`, so credit is reported as invoiced credit and never as
//!   collected cash.
//! - **A period is a business-day range** (`business_days.day_date`) — the same
//!   filter the reports and the closing services use, never a range over the UTC
//!   `created_at` instant.
//!
//! Every read is built from ONE predicate ([`SalesFilter`]), so the KPI band,
//! the trend, the item analysis and the invoice list can never describe
//! different sets of invoices. All values travel as bound parameters.

use crate::error::AppResult;
use crate::repositories::Db;
use serde::{Deserialize, Serialize};

/// Row cap of the invoice activity list, mirroring the invoice search cap.
const INVOICE_LIMIT: i64 = 200;
/// Row cap of the item analysis.
const ITEM_LIMIT: i64 = 50;

/// How the item analysis is ordered. Chosen by the caller, never free SQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemSort {
    /// Highest revenue first — what a manager means by "top selling".
    Revenue,
    /// Highest quantity first — what sold most often, regardless of price.
    Quantity,
}

/// The narrowing inputs of the whole Sales page.
///
/// Every field is optional and every field is resolved in SQL. The same filter
/// is applied to every read, so the page is internally consistent.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SalesFilter {
    /// Inclusive business-date bound, `YYYY-MM-DD`. Absent = unbounded.
    pub from: Option<String>,
    /// Inclusive business-date bound, `YYYY-MM-DD`. Absent = unbounded.
    pub to: Option<String>,
    /// `CASH` | `CARD` | `CREDIT`.
    pub method: Option<String>,
    /// Invoice status (`PENDING_PAYMENT`, `PAID`, `PARTIALLY_PAID`, `CREDIT`).
    pub status: Option<String>,
    /// Cashier / user who issued the invoice.
    pub user_id: Option<i64>,
    /// Free-text match against the snapshotted customer name.
    pub customer: Option<String>,
}

impl SalesFilter {
    /// Trimmed, empty-means-absent accessors: a cleared field is `None`, never
    /// an empty string that would silently degrade into a match-everything.
    pub fn from(&self) -> Option<&str> {
        clean(self.from.as_deref())
    }

    pub fn to(&self) -> Option<&str> {
        clean(self.to.as_deref())
    }

    pub fn method(&self) -> Option<&str> {
        clean(self.method.as_deref())
    }

    pub fn status(&self) -> Option<&str> {
        clean(self.status.as_deref())
    }

    pub fn customer(&self) -> Option<&str> {
        clean(self.customer.as_deref())
    }

    /// Whether the filter narrows the set at all beyond the date range. Used by
    /// the tests that prove an emptied field is "no filter", never a match-all.
    pub fn is_empty(&self) -> bool {
        self.from().is_none()
            && self.to().is_none()
            && self.method().is_none()
            && self.status().is_none()
            && self.user_id.is_none()
            && self.customer().is_none()
    }
}

fn clean(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn to_sql_refs(args: &[String]) -> Vec<&dyn rusqlite::ToSql> {
    args.iter()
        .map(|value| value as &dyn rusqlite::ToSql)
        .collect()
}

/// Aggregate SQL fragment plus its bound arguments, in placeholder order.
///
/// `offset` reserves the placeholder numbers a caller has already consumed, so
/// the fragment can be embedded in a query that binds its own values first.
/// Every value is BOUND — no filter value is ever concatenated into SQL.
fn filter_sql(filter: &SalesFilter, offset: usize) -> (String, Vec<String>) {
    let mut sql = String::new();
    let mut args: Vec<String> = Vec::new();
    for (prefix, value, suffix) in [
        (" AND d.day_date >=", filter.from().map(str::to_string), ""),
        (" AND d.day_date <=", filter.to().map(str::to_string), ""),
        // The payment ledger decides the method, exactly like the invoice
        // search filter the POS already uses.
        (
            " AND EXISTS (SELECT 1 FROM payments pm WHERE pm.invoice_id = i.id AND pm.method =",
            filter.method().map(str::to_string),
            ")",
        ),
        (" AND i.status =", filter.status().map(str::to_string), ""),
        (
            " AND i.user_id =",
            filter.user_id.map(|id| id.to_string()),
            "",
        ),
        // The snapshot name first (what was true at the time of the sale), with
        // the live customer row only as the legacy fallback.
        (
            " AND COALESCE(ic.customer_name, k.name) LIKE",
            filter.customer().map(|value| format!("%{value}%")),
            "",
        ),
    ] {
        if let Some(value) = value {
            args.push(value);
            sql.push_str(&format!("{prefix} ?{}{suffix}", offset + args.len()));
        }
    }
    (sql, args)
}

/// Only the business-day bounds of a filter, for the one read (the trend) that
/// must also list days which have no matching invoice at all.
fn day_bounds_sql(filter: &SalesFilter, offset: usize) -> (String, Vec<String>) {
    let mut sql = String::new();
    let mut args: Vec<String> = Vec::new();
    for (fragment, value) in [
        (" AND d.day_date >=", filter.from().map(str::to_string)),
        (" AND d.day_date <=", filter.to().map(str::to_string)),
    ] {
        if let Some(value) = value {
            args.push(value);
            sql.push_str(&format!("{fragment} ?{}", offset + args.len()));
        }
    }
    (sql, args)
}

/// The invoice set every read of this module is scoped to, as a reusable CTE.
///
/// Written once so the "which invoices count" rule physically cannot diverge
/// between the KPIs, the trend, the items and the invoice list.
fn scoped_invoices_cte(filter: &SalesFilter) -> (String, Vec<String>) {
    let (predicate, args) = filter_sql(filter, 0);
    let sql = format!(
        "WITH inv AS (
            SELECT i.id, i.business_day_id, i.subtotal, i.discount_minor, i.service_charge,
                   i.total, i.cafe_total, i.wash_total
            FROM invoices i
            JOIN business_days d ON d.id = i.business_day_id
            LEFT JOIN invoice_customers ic ON ic.invoice_id = i.id
            LEFT JOIN customers k ON k.id = i.customer_id
            WHERE 1=1{predicate}
        ),
        pay AS (
            SELECT p.invoice_id,
                   SUM(CASE WHEN p.method = 'CASH' THEN p.amount ELSE 0 END) AS cash,
                   SUM(CASE WHEN p.method = 'CARD' THEN p.amount ELSE 0 END) AS card,
                   SUM(CASE WHEN p.method = 'CREDIT' THEN p.amount ELSE 0 END) AS credit
            FROM payments p GROUP BY p.invoice_id
        )"
    );
    (sql, args)
}

/// The whole page in ONE round trip: three fixed queries, no per-KPI calls.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SalesOverview {
    pub summary: SalesSummary,
    pub trend: Vec<SalesDayRow>,
    pub items: Vec<SalesItemRow>,
}

/// Headline aggregates of the filtered period.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SalesSummary {
    /// Invoices in the period.
    pub invoices_count: i64,
    /// Sum of the invoice subtotals: line revenue BEFORE discount and service charge.
    pub subtotal: i64,
    pub discounts: i64,
    pub service_charges: i64,
    /// `subtotal - discounts + service_charges`. The authoritative revenue.
    pub total_sales: i64,
    /// Mean invoice value. Zero for an empty period, never a division by zero.
    pub average_invoice: i64,
    pub cafe_sales: i64,
    pub wash_sales: i64,
    /// Settled money per method, from the payments ledger.
    pub cash: i64,
    pub card: i64,
    pub credit: i64,
    /// Share of SETTLED money per method, in whole percent.
    pub cash_share: i64,
    pub card_share: i64,
    pub credit_share: i64,
}

/// One business day of the trend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SalesDayRow {
    pub day_id: i64,
    pub day_date: String,
    pub invoices_count: i64,
    pub total_sales: i64,
    pub cafe_sales: i64,
    pub wash_sales: i64,
    pub cash: i64,
    pub card: i64,
    pub credit: i64,
}

/// One calendar month of the monthly comparison report.
///
/// The `month` key is the STABLE `YYYY-MM` form produced by SQLite, never a
/// display name: grouping by it is what keeps January 2025 and January 2026 in
/// two different buckets instead of merging them into one "January".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SalesMonthRow {
    /// `YYYY-MM`, the grouping key and the chart's category identity.
    pub month: String,
    /// Non-cancelled invoices in the month.
    pub invoices_count: i64,
    /// `subtotal - discounts + service_charges` over the month.
    pub total_sales: i64,
    /// Sum of the immutable `cafe_total` snapshot over the month.
    pub cafe_sales: i64,
    /// Sum of the immutable `wash_total` snapshot over the month.
    pub wash_sales: i64,
}

/// Revenue aggregated by calendar month, for one explicit business-day window.
///
/// Deliberately NOT built on [`SalesFilter`]: this report is a monthly series
/// over a period the caller states, so it can never be narrowed by the Sales
/// page's own period picker. Every invoice is a real document and the money is
/// the invoice snapshot, so the monthly figures can never disagree with the
/// daily trend or the KPIs.
///
/// Months that have a business day but no matching invoice are KEPT as a zero
/// month (the same rule the daily trend follows), so a quiet month reads as
/// zero instead of vanishing from the series.
pub fn monthly(conn: &Db, from: &str, to: &str) -> AppResult<Vec<SalesMonthRow>> {
    let mut stmt = conn.prepare(
        "SELECT strftime('%Y-%m', d.day_date) AS month,
                COUNT(inv.id),
                COALESCE(SUM(inv.total), 0),
                COALESCE(SUM(inv.cafe_total), 0),
                COALESCE(SUM(inv.wash_total), 0)
         FROM business_days d
         LEFT JOIN invoices inv
           ON inv.business_day_id = d.id
         WHERE d.day_date >= ?1 AND d.day_date <= ?2
         GROUP BY month
         ORDER BY month",
    )?;
    let rows = stmt.query_map(rusqlite::params![from, to], |r| {
        Ok(SalesMonthRow {
            month: r.get(0)?,
            invoices_count: r.get(1)?,
            total_sales: r.get(2)?,
            cafe_sales: r.get(3)?,
            wash_sales: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// One product/service of the item analysis, from the invoice line SNAPSHOT.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SalesItemRow {
    pub product_name: String,
    /// `CAFE` | `WASH` — the department the line was sold in.
    pub department: String,
    pub quantity: i64,
    /// Sum of the snapshotted line totals (line revenue, before invoice discount).
    pub revenue: i64,
    /// Share of ALL item revenue in the filtered period, in whole percent.
    pub share_percent: i64,
}

/// One invoice of the activity list — the drill-down behind every figure above.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SalesInvoiceRow {
    pub id: i64,
    pub invoice_no: i64,
    pub day_date: String,
    pub created_at: String,
    pub order_type: String,
    pub table_label: Option<String>,
    pub takeaway_no: Option<i64>,
    pub status: String,
    pub subtotal: i64,
    pub discount_minor: i64,
    pub service_charge: i64,
    pub total: i64,
    pub paid_amount: i64,
    pub cafe_total: i64,
    pub wash_total: i64,
    pub customer_name: Option<String>,
    pub car_plate: Option<String>,
    pub user_name: Option<String>,
    pub user_role: Option<String>,
    /// The payment method recorded for this invoice, if any.
    pub payment_method: Option<String>,
}

/// A cashier option of the filter, read from the users table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SalesCashier {
    pub id: i64,
    pub name: String,
    pub role: String,
}

/// Whole-percent share, half-up, defined as zero for an empty whole.
fn share(part: i64, whole: i64) -> i64 {
    if whole <= 0 {
        0
    } else {
        (part * 100 + whole / 2) / whole
    }
}

/// The KPI block. ONE query: every persisted invoice in the period is a real
/// document, so there is no second "exception" count to run beside the totals.
pub fn summary(conn: &Db, filter: &SalesFilter) -> AppResult<SalesSummary> {
    let (cte, args) = scoped_invoices_cte(filter);
    let row: (i64, i64, i64, i64, i64, i64, i64, i64, i64, i64) = conn.query_row(
        &format!(
            "{cte}
             SELECT COUNT(*),
                    COALESCE(SUM(inv.subtotal), 0),
                    COALESCE(SUM(inv.discount_minor), 0),
                    COALESCE(SUM(inv.service_charge), 0),
                    COALESCE(SUM(inv.total), 0),
                    COALESCE(SUM(inv.cafe_total), 0),
                    COALESCE(SUM(inv.wash_total), 0),
                    COALESCE(SUM(pay.cash), 0),
                    COALESCE(SUM(pay.card), 0),
                    COALESCE(SUM(pay.credit), 0)
             FROM inv LEFT JOIN pay ON pay.invoice_id = inv.id"
        ),
        to_sql_refs(&args).as_slice(),
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
            ))
        },
    )?;

    let (
        invoices_count,
        subtotal,
        discounts,
        service_charges,
        total_sales,
        cafe_sales,
        wash_sales,
        cash,
        card,
        credit,
    ) = row;
    // The three payment methods partition the SETTLED money, so the shares are
    // taken against that sum — never against invoiced revenue, which would make
    // an unsettled remainder look like missing money.
    let settled = cash + card + credit;
    Ok(SalesSummary {
        invoices_count,
        subtotal,
        discounts,
        service_charges,
        total_sales,
        average_invoice: if invoices_count > 0 {
            total_sales / invoices_count
        } else {
            0
        },
        cafe_sales,
        wash_sales,
        cash,
        card,
        credit,
        cash_share: share(cash, settled),
        card_share: share(card, settled),
        credit_share: share(credit, settled),
    })
}

/// Daily totals across the period. Business days WITHOUT a matching invoice are
/// kept, so a quiet day reads as zero on the trend instead of vanishing.
pub fn trend(conn: &Db, filter: &SalesFilter) -> AppResult<Vec<SalesDayRow>> {
    let (cte, args) = scoped_invoices_cte(filter);
    // The day bounds continue the placeholder numbering of the scoped set, so
    // one statement carries one ordered argument list.
    let (day_sql, day_args) = day_bounds_sql(filter, args.len());
    let mut all_args = args;
    all_args.extend(day_args);
    let mut stmt = conn.prepare(&format!(
        "{cte}
         SELECT d.id, d.day_date,
                COUNT(inv.id),
                COALESCE(SUM(inv.total), 0),
                COALESCE(SUM(inv.cafe_total), 0),
                COALESCE(SUM(inv.wash_total), 0),
                COALESCE(SUM(pay.cash), 0),
                COALESCE(SUM(pay.card), 0),
                COALESCE(SUM(pay.credit), 0)
         FROM business_days d
         LEFT JOIN inv ON inv.business_day_id = d.id
         LEFT JOIN pay ON pay.invoice_id = inv.id
         WHERE 1=1{day_sql}
         GROUP BY d.id ORDER BY d.day_date"
    ))?;
    let rows = stmt.query_map(to_sql_refs(&all_args).as_slice(), |r| {
        Ok(SalesDayRow {
            day_id: r.get(0)?,
            day_date: r.get(1)?,
            invoices_count: r.get(2)?,
            total_sales: r.get(3)?,
            cafe_sales: r.get(4)?,
            wash_sales: r.get(5)?,
            cash: r.get(6)?,
            card: r.get(7)?,
            credit: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Product / service analysis from the invoice line snapshots.
///
/// The share is a window total over ALL grouped lines, so it stays correct even
/// though only the top rows are returned.
pub fn items(
    conn: &Db,
    filter: &SalesFilter,
    sort: ItemSort,
    limit: Option<i64>,
) -> AppResult<Vec<SalesItemRow>> {
    debug_assert!(matches!(sort, ItemSort::Revenue | ItemSort::Quantity));
    let (cte, args) = scoped_invoices_cte(filter);
    let order = match sort {
        ItemSort::Revenue => "revenue DESC, quantity DESC, product_name",
        ItemSort::Quantity => "quantity DESC, revenue DESC, product_name",
    };
    let mut stmt = conn.prepare(&format!(
        "{cte}
         SELECT l.product_name, l.department,
                SUM(l.quantity) AS quantity,
                SUM(l.line_total) AS revenue,
                CAST(ROUND(100.0 * SUM(l.line_total)
                     / NULLIF(SUM(SUM(l.line_total)) OVER (), 0)) AS INTEGER) AS share_percent
         FROM invoice_lines l JOIN inv ON inv.id = l.invoice_id
         GROUP BY l.product_name, l.department
         ORDER BY {order}
         LIMIT {}",
        limit.unwrap_or(ITEM_LIMIT).clamp(1, ITEM_LIMIT)
    ))?;
    let rows = stmt.query_map(to_sql_refs(&args).as_slice(), |r| {
        Ok(SalesItemRow {
            product_name: r.get(0)?,
            department: r.get(1)?,
            quantity: r.get(2)?,
            revenue: r.get(3)?,
            share_percent: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// The invoices behind the numbers, newest first, under the SAME filter.
pub fn invoices(conn: &Db, filter: &SalesFilter) -> AppResult<Vec<SalesInvoiceRow>> {
    let (cte, args) = scoped_invoices_cte(filter);
    let mut all_args = args;
    all_args.push(INVOICE_LIMIT.to_string());
    let mut stmt = conn.prepare(&format!(
        "{cte}
         SELECT i.id, i.invoice_no, d.day_date, i.created_at, i.order_type, i.table_label,
                i.takeaway_no, i.status, i.subtotal, i.discount_minor, i.service_charge,
                i.total, i.paid_amount, i.cafe_total, i.wash_total,
                COALESCE(ic.customer_name, k.name), ic.car_plate, u.name, u.role,
                (SELECT p2.method FROM payments p2
                  WHERE p2.invoice_id = i.id ORDER BY p2.id LIMIT 1)
         FROM inv
         JOIN invoices i ON i.id = inv.id
         JOIN business_days d ON d.id = i.business_day_id
         LEFT JOIN invoice_customers ic ON ic.invoice_id = i.id
         LEFT JOIN customers k ON k.id = i.customer_id
         LEFT JOIN users u ON u.id = i.user_id
         ORDER BY i.id DESC
         LIMIT ?{}",
        all_args.len()
    ))?;
    let rows = stmt.query_map(to_sql_refs(&all_args).as_slice(), |r| {
        Ok(SalesInvoiceRow {
            id: r.get(0)?,
            invoice_no: r.get(1)?,
            day_date: r.get(2)?,
            created_at: r.get(3)?,
            order_type: r.get(4)?,
            table_label: r.get(5)?,
            takeaway_no: r.get(6)?,
            status: r.get(7)?,
            subtotal: r.get(8)?,
            discount_minor: r.get(9)?,
            service_charge: r.get(10)?,
            total: r.get(11)?,
            paid_amount: r.get(12)?,
            cafe_total: r.get(13)?,
            wash_total: r.get(14)?,
            customer_name: r.get(15)?,
            car_plate: r.get(16)?,
            user_name: r.get(17)?,
            user_role: r.get(18)?,
            payment_method: r.get(19)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// The cashier options of the filter.
pub fn cashiers(conn: &Db) -> AppResult<Vec<SalesCashier>> {
    let mut stmt = conn.prepare("SELECT id, name, role FROM users ORDER BY name")?;
    let rows = stmt.query_map([], |r| {
        Ok(SalesCashier {
            id: r.get(0)?,
            name: r.get(1)?,
            role: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}
