//! Customer activity analytics — aggregated reads over persisted records.
//!
//! Every number here is a single-pass SQL aggregate over the immutable invoice
//! snapshots (`cafe_total` / `wash_total` / `paid_amount` / `discount_minor` /
//! `service_charge` / `order_type`) and the credit ledger. It follows the
//! revenue rules already established by `repositories::analytics`:
//!
//! - a `CANCELLED` invoice never counts;
//! - `paid_amount` is the cash/card money actually settled on the invoice; a
//!   `CREDIT` invoice keeps `paid_amount = 0` and is represented by the
//!   customer's credit account, so credit is never counted as paid revenue;
//! - the department split uses the snapshot totals, which sum to the invoice
//!   subtotal, so `cafe_total + wash_total` cannot double count;
//! - a period is a business-day range (`business_days.day_date`) — exactly the
//!   filter the reports service already uses, never a timestamp range.
//!
//! Rows are read once per request: the list is ONE query with a derived
//! aggregate table, the details payload is a fixed three queries. There is no
//! per-customer query anywhere in this module.

use crate::error::AppResult;
use crate::repositories::customers::{self, Car, Customer};
use crate::repositories::Db;
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// Row cap of the customer list, mirroring the invoice search cap.
const LIST_LIMIT: i64 = 200;

/// Column list of the per-customer invoice aggregate, in the exact order
/// [`read_stats`] reads it. The aliases are what the list query joins on; the
/// single-customer query reads the same expressions positionally.
const AGG_COLUMNS: &str = "COUNT(*) AS invoices_count,
            COALESCE(SUM(i.total), 0) AS total,
            COALESCE(SUM(i.paid_amount), 0) AS paid,
            COALESCE(SUM(i.discount_minor), 0) AS discounts,
            COALESCE(SUM(i.service_charge), 0) AS service_charges,
            COALESCE(SUM(CASE WHEN i.cafe_total > 0 THEN 1 ELSE 0 END), 0) AS cafe_orders,
            COALESCE(SUM(i.cafe_total), 0) AS cafe_total,
            COALESCE(SUM(CASE WHEN i.wash_total > 0 THEN 1 ELSE 0 END), 0) AS wash_orders,
            COALESCE(SUM(i.wash_total), 0) AS wash_total,
            COALESCE(SUM(CASE WHEN i.order_type = 'TAKEAWAY' THEN 1 ELSE 0 END), 0) AS takeaway_orders,
            COALESCE(SUM(CASE WHEN i.order_type = 'TABLE' THEN 1 ELSE 0 END), 0) AS table_orders,
            MIN(i.created_at) AS first_at,
            MAX(i.created_at) AS last_at";

/// Aggregated activity of ONE customer, scoped to the requested period.
///
/// `credit_*` describe the standing credit account. That account is a running
/// balance, not a period movement, so it is reported beside the period totals
/// rather than inside them.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CustomerStats {
    pub invoices_count: i64,
    pub total: i64,
    pub paid: i64,
    pub discounts: i64,
    pub service_charges: i64,
    pub average_order: i64,
    pub cafe_orders: i64,
    pub cafe_total: i64,
    pub wash_orders: i64,
    pub wash_total: i64,
    pub takeaway_orders: i64,
    pub table_orders: i64,
    pub first_at: Option<String>,
    pub last_at: Option<String>,
    pub credit_outstanding: i64,
    pub credit_original: i64,
    pub credit_paid: i64,
    pub credit_status: Option<String>,
}

impl CustomerStats {
    /// Mean invoice value, derived from the aggregates themselves.
    pub fn average_order(&self) -> i64 {
        if self.invoices_count > 0 {
            self.total / self.invoices_count
        } else {
            0
        }
    }

    /// Fill the derived average once every component has been read.
    fn sealed(mut self) -> Self {
        self.average_order = self.average_order();
        self
    }
}

/// One customer as the management page lists it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerRow {
    pub id: i64,
    pub name: String,
    pub phone: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub plates: Vec<String>,
    pub cars_count: i64,
    /// `None` for a role that may not see customer money. The figures are not
    /// computed and not sent — they are absent from the payload.
    pub stats: Option<CustomerStats>,
}

/// The customer list plus whether the caller's role may see the money, so the
/// UI can explain its reduced view instead of leaving columns silently missing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerList {
    pub financial_visible: bool,
    pub customers: Vec<CustomerRow>,
}

/// Page-level KPI block across every customer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerOverview {
    pub total_customers: i64,
    pub active_customers: i64,
    pub total_orders: i64,
    pub total_paid: i64,
    pub average_spend: i64,
    pub cafe_orders: i64,
    pub wash_orders: i64,
    pub takeaway_orders: i64,
    pub table_orders: i64,
    pub outstanding_credit: i64,
    pub top_by_orders: Option<CustomerRank>,
    pub top_by_spend: Option<CustomerRank>,
}

/// The customer leading an aggregate, resolved by name — never a bare id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerRank {
    pub customer_id: i64,
    pub name: String,
    pub value: i64,
}

/// One recent invoice of a customer, for the details activity list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerActivityRow {
    pub invoice_no: i64,
    pub order_type: String,
    pub table_label: Option<String>,
    pub takeaway_no: Option<i64>,
    pub status: String,
    pub total: i64,
    pub paid_amount: i64,
    pub cafe_total: i64,
    pub wash_total: i64,
    pub created_at: String,
}

/// Everything the details drawer shows for one customer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomerDetails {
    pub customer: Customer,
    pub created_at: String,
    pub cars: Vec<Car>,
    pub stats: CustomerStats,
    pub activity: Vec<CustomerActivityRow>,
}

/// Business-day range predicate; `offset` reserves the placeholders a caller
/// prefixes with its own arguments. `from`/`to` are ISO dates, empty = open.
fn day_range(from: Option<&str>, to: Option<&str>, offset: usize) -> (String, Vec<String>) {
    let mut sql = String::new();
    let mut args: Vec<String> = Vec::new();
    if let Some(value) = from.filter(|v| !v.is_empty()) {
        args.push(value.to_string());
        sql.push_str(&format!(" AND d.day_date >= ?{}", offset + args.len()));
    }
    if let Some(value) = to.filter(|v| !v.is_empty()) {
        args.push(value.to_string());
        sql.push_str(&format!(" AND d.day_date <= ?{}", offset + args.len()));
    }
    (sql, args)
}

fn to_sql_refs(args: &[String]) -> Vec<&dyn rusqlite::ToSql> {
    args.iter().map(|s| s as &dyn rusqlite::ToSql).collect()
}

/// Read the aggregate columns above, starting at `offset` in the row. The list
/// query places the customer's own columns before the aggregate, so the same
/// reader serves both shapes.
fn read_stats(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<CustomerStats> {
    Ok(CustomerStats {
        invoices_count: row.get(offset)?,
        total: row.get(offset + 1)?,
        paid: row.get(offset + 2)?,
        discounts: row.get(offset + 3)?,
        service_charges: row.get(offset + 4)?,
        cafe_orders: row.get(offset + 5)?,
        cafe_total: row.get(offset + 6)?,
        wash_orders: row.get(offset + 7)?,
        wash_total: row.get(offset + 8)?,
        takeaway_orders: row.get(offset + 9)?,
        table_orders: row.get(offset + 10)?,
        first_at: row.get(offset + 11)?,
        last_at: row.get(offset + 12)?,
        ..Default::default()
    })
}

/// The shared invoice aggregate, grouped per customer and period-filtered.
/// Used as a derived table so the list, the KPIs and the drawer all read the
/// same numbers from the same rule.
///
/// The columns carry explicit aliases because this is joined as a derived
/// table, where a bare `COUNT(*)` would be an anonymous column.
fn customer_invoice_aggregate(from: Option<&str>, to: Option<&str>) -> (String, Vec<String>) {
    let (range, args) = day_range(from, to, 0);
    let sql = format!(
        "SELECT i.customer_id, {AGG_COLUMNS}
         FROM invoices i JOIN business_days d ON d.id = i.business_day_id
         WHERE i.customer_id IS NOT NULL AND i.status != 'CANCELLED'{range}
         GROUP BY i.customer_id"
    );
    (sql, args)
}

/// The customer list: ONE query for the whole page.
///
/// Identity, cars and the period aggregate are read together. The aggregate is
/// only joined at all when the caller is authorized to see it, so the reduced
/// (cashier) payload is a smaller query with no financial column in it. Search
/// reuses Station's normalized identity keys, so "٠١٠٠ ١٢٣" and "0100123"
/// reach the same record.
pub fn list_rows(
    conn: &Db,
    q: &str,
    from: Option<&str>,
    to: Option<&str>,
    with_stats: bool,
) -> AppResult<Vec<CustomerRow>> {
    let mut args: Vec<String> = Vec::new();
    let mut sql = String::from(
        "SELECT k.id, k.name, k.phone, k.notes, k.created_at, k.updated_at,
                (SELECT GROUP_CONCAT(c.plate_no, '|') FROM cars c WHERE c.customer_id = k.id),
                (SELECT COUNT(*) FROM cars c WHERE c.customer_id = k.id)",
    );
    if with_stats {
        let (aggregate, aggregate_args) = customer_invoice_aggregate(from, to);
        args.extend(aggregate_args);
        sql.push_str(&format!(
            ", COALESCE(a.invoices_count, 0), COALESCE(a.total, 0), COALESCE(a.paid, 0),
                COALESCE(a.discounts, 0), COALESCE(a.service_charges, 0),
                COALESCE(a.cafe_orders, 0), COALESCE(a.cafe_total, 0),
                COALESCE(a.wash_orders, 0), COALESCE(a.wash_total, 0),
                COALESCE(a.takeaway_orders, 0), COALESCE(a.table_orders, 0),
                a.first_at, a.last_at,
                COALESCE(ca.outstanding, 0), COALESCE(ca.original_total, 0),
                COALESCE(ca.paid_total, 0), ca.credit_status
             FROM customers k
             LEFT JOIN ({aggregate}) a ON a.customer_id = k.id
             LEFT JOIN (SELECT customer_id, original_total, paid_total,
                                original_total - paid_total AS outstanding,
                                status AS credit_status
                         FROM credit_accounts) ca ON ca.customer_id = k.id
             WHERE 1=1"
        ));
    } else {
        sql.push_str(" FROM customers k WHERE 1=1");
    }

    // Search matches the raw term AND, when it is an identity, its normalized
    // form — so "٠١٠٠ ١٢٣" and "0100123" reach the same record. Every candidate
    // is an ALTERNATIVE, never an additional requirement.
    let term = q.trim();
    if !term.is_empty() {
        let mut terms = vec![term.to_string()];
        if let Some(norm) = crate::normalize::normalize_phone(term)
            .or_else(|| crate::normalize::normalize_plate(term))
            .filter(|norm| norm != term)
        {
            terms.push(norm);
        }
        let placeholders = terms
            .iter()
            .map(|value| {
                args.push(format!("%{value}%"));
                args.len()
            })
            .collect::<Vec<_>>();
        let matches = placeholders
            .iter()
            .map(|n| {
                format!(
                    "(k.name LIKE ?{n} OR k.phone_key LIKE ?{n}
                        OR k.id IN (SELECT customer_id FROM cars WHERE plate_key LIKE ?{n}))"
                )
            })
            .collect::<Vec<_>>()
            .join(" OR ");
        sql.push_str(&format!(" AND ({matches})"));
    }
    sql.push_str(&format!(" ORDER BY k.name LIMIT {LIST_LIMIT}"));

    let mut stmt = conn.prepare(&sql)?;
    let refs = to_sql_refs(&args);
    let rows = stmt.query_map(refs.as_slice(), |row| {
        let plates: Option<String> = row.get(6)?;
        let stats = if with_stats {
            let mut stats = read_stats(row, 8)?.sealed();
            stats.credit_outstanding = row.get(21)?;
            stats.credit_original = row.get(22)?;
            stats.credit_paid = row.get(23)?;
            stats.credit_status = row.get(24)?;
            Some(stats)
        } else {
            None
        };
        Ok(CustomerRow {
            id: row.get(0)?,
            name: row.get(1)?,
            phone: row.get(2)?,
            notes: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
            plates: plates
                .map(|value| {
                    value
                        .split('|')
                        .filter(|plate| !plate.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            cars_count: row.get(7)?,
            stats,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}


/// Aggregated activity for one customer. Period-scoped, with the standing
/// credit balance attached.
pub fn stats_for(
    conn: &Db,
    customer_id: i64,
    from: Option<&str>,
    to: Option<&str>,
) -> AppResult<CustomerStats> {
    let (range, mut args) = day_range(from, to, 1);
    args.insert(0, customer_id.to_string());
    let sql = format!(
        "SELECT {AGG_COLUMNS}
         FROM invoices i JOIN business_days d ON d.id = i.business_day_id
         WHERE i.customer_id = ?1 AND i.status != 'CANCELLED'{range}"
    );
    let refs = to_sql_refs(&args);
    // No rows means "no activity in this period", which is a real answer.
    let mut stats: CustomerStats = conn
        .query_row(&sql, refs.as_slice(), |row| read_stats(row, 0))
        .unwrap_or_default()
        .sealed();

    let credit: Option<(i64, i64, String)> = conn
        .query_row(
            "SELECT original_total, paid_total, status FROM credit_accounts WHERE customer_id = ?1",
            [customer_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    if let Some((original, paid, status)) = credit {
        stats.credit_original = original;
        stats.credit_paid = paid;
        stats.credit_outstanding = original - paid;
        stats.credit_status = Some(status);
    }
    Ok(stats)
}

/// The customer's most recent non-cancelled invoices.
pub fn recent_activity(
    conn: &Db,
    customer_id: i64,
    limit: i64,
) -> AppResult<Vec<CustomerActivityRow>> {
    let mut stmt = conn.prepare(
        "SELECT i.invoice_no, i.order_type, i.table_label, i.takeaway_no, i.status,
                i.total, i.paid_amount, i.cafe_total, i.wash_total, i.created_at
         FROM invoices i
         WHERE i.customer_id = ?1 AND i.status != 'CANCELLED'
         ORDER BY i.id DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![customer_id, limit.clamp(1, 50)], |r| {
        Ok(CustomerActivityRow {
            invoice_no: r.get(0)?,
            order_type: r.get(1)?,
            table_label: r.get(2)?,
            takeaway_no: r.get(3)?,
            status: r.get(4)?,
            total: r.get(5)?,
            paid_amount: r.get(6)?,
            cafe_total: r.get(7)?,
            wash_total: r.get(8)?,
            created_at: r.get(9)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Full details payload for the drawer: identity, cars, aggregated activity
/// and the recent invoice list. Three fixed queries, never one per record.
pub fn details(
    conn: &Db,
    customer_id: i64,
    from: Option<&str>,
    to: Option<&str>,
) -> AppResult<CustomerDetails> {
    let (customer, created_at) = {
        let mut stmt = conn
            .prepare("SELECT id, name, phone, notes, created_at FROM customers WHERE id = ?1")?;
        let mut rows = stmt.query([customer_id])?;
        match rows.next()? {
            Some(row) => (
                Customer {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    phone: row.get(2)?,
                    notes: row.get(3)?,
                },
                row.get::<_, String>(4)?,
            ),
            None => return Err(crate::error::AppError::not_found("customers.not_found")),
        }
    };
    Ok(CustomerDetails {
        cars: customers::cars_of(conn, customer_id)?,
        stats: stats_for(conn, customer_id, from, to)?,
        activity: recent_activity(conn, customer_id, 10)?,
        customer,
        created_at,
    })
}


/// Page-level KPI block across every customer.
pub fn overview(conn: &Db, from: Option<&str>, to: Option<&str>) -> AppResult<CustomerOverview> {
    let total_customers: i64 = conn.query_row("SELECT COUNT(*) FROM customers", [], |r| r.get(0))?;

    // ONE aggregate query answers every activity KPI of the band, so the whole
    // header costs a constant number of statements however many customers exist.
    let (range, args) = day_range(from, to, 0);
    let refs = to_sql_refs(&args);
    type Totals = (i64, i64, i64, i64, i64, i64, i64);
    let (active_customers, total_orders, total_paid, cafe_orders, wash_orders, takeaway_orders, table_orders): Totals =
        conn.query_row(
            &format!(
                "SELECT COUNT(DISTINCT i.customer_id),
                        COUNT(*),
                        COALESCE(SUM(i.paid_amount), 0),
                        COALESCE(SUM(CASE WHEN i.cafe_total > 0 THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN i.wash_total > 0 THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN i.order_type = 'TAKEAWAY' THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN i.order_type = 'TABLE' THEN 1 ELSE 0 END), 0)
                 FROM invoices i JOIN business_days d ON d.id = i.business_day_id
                 WHERE i.customer_id IS NOT NULL AND i.status != 'CANCELLED'{range}"
            ),
            refs.as_slice(),
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )?;

    // Standing credit across every account — a balance, not a period movement.
    let outstanding_credit: i64 = conn.query_row(
        "SELECT COALESCE(SUM(original_total - paid_total), 0) FROM credit_accounts",
        [],
        |r| r.get(0),
    )?;

    Ok(CustomerOverview {
        total_customers,
        // Average spend per ACTIVE customer: a period with no customer activity
        // has no average at all, rather than a division by zero.
        average_spend: if active_customers > 0 {
            total_paid / active_customers
        } else {
            0
        },
        active_customers,
        total_orders,
        total_paid,
        cafe_orders,
        wash_orders,
        takeaway_orders,
        table_orders,
        outstanding_credit,
        top_by_orders: top_customer(conn, "COUNT(*)", from, to)?,
        top_by_spend: top_customer(conn, "SUM(i.paid_amount)", from, to)?,
    })
}

/// The customer leading an aggregate, resolved by name. `aggregate` is a fixed
/// fragment chosen by this module — never user input — and it is applied under
/// the SAME predicate the list and the KPI block use, so the leader of a period
/// here is the leader of that period everywhere.
fn top_customer(
    conn: &Db,
    aggregate: &str,
    from: Option<&str>,
    to: Option<&str>,
) -> AppResult<Option<CustomerRank>> {
    debug_assert!(matches!(aggregate, "COUNT(*)" | "SUM(i.paid_amount)"));
    let (range, args) = day_range(from, to, 0);
    let refs = to_sql_refs(&args);
    let row: Option<(i64, String, i64)> = conn
        .query_row(
            &format!(
                "SELECT k.id, k.name, COALESCE({aggregate}, 0)
                 FROM invoices i
                 JOIN customers k ON k.id = i.customer_id
                 JOIN business_days d ON d.id = i.business_day_id
                 WHERE i.customer_id IS NOT NULL AND i.status != 'CANCELLED'{range}
                 GROUP BY k.id, k.name ORDER BY 3 DESC, k.id LIMIT 1"
            ),
            refs.as_slice(),
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    // A zero aggregate means "nobody leads this", not a customer who is free.
    Ok(row.and_then(|(customer_id, name, value)| {
        (value > 0).then_some(CustomerRank {
            customer_id,
            name,
            value,
        })
    }))
}
