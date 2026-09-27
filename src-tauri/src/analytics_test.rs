//! Analytics report tests — prove the three charts read persisted production
//! rows (invoices / payments / expenses) and follow the existing revenue rules.

use crate::db::migrate;
use crate::repositories::invoices::{self, InvoiceLine};
use crate::repositories::{analytics, expenses};
use rusqlite::Connection;

/// Migrated in-memory database plus the one user every FK needs.
fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    conn.execute(
        "INSERT INTO users (name, role, password_hash) VALUES ('manager', 'MANAGER', 'x')",
        [],
    )
    .unwrap();
    conn
}

/// Closed business day with an explicit calendar label (report filtering input).
fn add_day(conn: &Connection, date: &str) -> i64 {
    conn.execute(
        "INSERT INTO business_days (day_date, opened_at, status, opened_by)
         VALUES (?1, datetime('now'), 'CLOSED', 1)",
        [date],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn add_order(conn: &Connection, day_id: i64) -> i64 {
    conn.execute(
        "INSERT INTO orders (order_type, table_id, user_id, business_day_id, status)
         VALUES ('TAKEAWAY', NULL, 1, ?1, 'CLOSED')",
        [day_id],
    )
    .unwrap();
    conn.last_insert_rowid()
}

struct InvoiceFixture {
    invoice_no: i64,
    day_id: i64,
    cafe_total: i64,
    wash_total: i64,
    service_charge: i64,
    discount_minor: i64,
}

impl InvoiceFixture {
    fn total(&self) -> i64 {
        self.cafe_total + self.wash_total + self.service_charge - self.discount_minor
    }
}

/// Inserts a real invoice through the repository (same write path as checkout).
fn add_invoice(conn: &Connection, fixture: InvoiceFixture) -> i64 {
    let order_id = add_order(conn, fixture.day_id);
    let subtotal = fixture.cafe_total + fixture.wash_total;
    let lines = vec![InvoiceLine {
        department: "CAFE".into(),
        product_name: "قهوة".into(),
        unit_price: fixture.cafe_total,
        quantity: 1,
        discount_minor: 0,
        line_total: fixture.cafe_total,
    }];
    invoices::insert_invoice(
        conn,
        fixture.invoice_no,
        order_id,
        None,
        fixture.day_id,
        None,
        1,
        "TAKEAWAY",
        None,
        None,
        subtotal,
        fixture.discount_minor,
        None,
        None,
        fixture.service_charge,
        fixture.total(),
        fixture.cafe_total,
        fixture.wash_total,
        &lines,
    )
    .unwrap()
}

fn pay(conn: &Connection, invoice_id: i64, method: &str, amount: i64) {
    invoices::insert_payment(conn, invoice_id, method, amount, None, None, 1).unwrap();
    invoices::apply_payment_to_invoice(conn, invoice_id, amount).unwrap();
}

fn chart<'a>(
    report: &'a analytics::AnalyticsCharts,
    id: &str,
) -> &'a analytics::AnalyticsChartValue {
    report
        .charts
        .iter()
        .find(|chart| chart.id == id)
        .expect("chart id present")
}

fn value(report: &analytics::AnalyticsCharts, chart_id: &str, category_id: &str) -> i64 {
    chart(report, chart_id)
        .categories
        .iter()
        .find(|category| category.id == category_id)
        .expect("category id present")
        .value
}

#[test]
fn empty_database_reports_zero_values_and_no_data_for_every_chart() {
    let conn = fresh();
    let report =
        analytics::analytics_charts(&conn, Some("2026-09-01"), Some("2026-09-30")).unwrap();

    assert_eq!(report.charts.len(), 3);
    for entry in &report.charts {
        assert_eq!(entry.total, 0, "{} must be empty", entry.id);
        assert!(!entry.has_data, "{} must not claim data", entry.id);
    }
    assert_eq!(value(&report, "laundry-cafe", "laundry"), 0);
    assert_eq!(value(&report, "cash-visa", "cash"), 0);
    assert_eq!(value(&report, "sales-expenses", "expenses"), 0);
}

#[test]
fn department_split_uses_invoice_snapshot_totals() {
    let conn = fresh();
    let day = add_day(&conn, "2026-09-10");
    add_invoice(
        &conn,
        InvoiceFixture {
            invoice_no: 1,
            day_id: day,
            cafe_total: 6_000,
            wash_total: 15_000,
            service_charge: 0,
            discount_minor: 0,
        },
    );
    add_invoice(
        &conn,
        InvoiceFixture {
            invoice_no: 2,
            day_id: day,
            cafe_total: 4_000,
            wash_total: 5_000,
            service_charge: 0,
            discount_minor: 0,
        },
    );

    let report =
        analytics::analytics_charts(&conn, Some("2026-09-01"), Some("2026-09-30")).unwrap();

    assert_eq!(value(&report, "laundry-cafe", "laundry"), 20_000);
    assert_eq!(value(&report, "laundry-cafe", "cafe"), 10_000);
    assert_eq!(chart(&report, "laundry-cafe").total, 30_000);
    assert!(chart(&report, "laundry-cafe").has_data);
}

#[test]
fn cash_and_card_come_from_the_payment_ledger() {
    let conn = fresh();
    let day = add_day(&conn, "2026-09-10");
    let cash_invoice = add_invoice(
        &conn,
        InvoiceFixture {
            invoice_no: 1,
            day_id: day,
            cafe_total: 5_000,
            wash_total: 0,
            service_charge: 0,
            discount_minor: 0,
        },
    );
    let card_invoice = add_invoice(
        &conn,
        InvoiceFixture {
            invoice_no: 2,
            day_id: day,
            cafe_total: 3_000,
            wash_total: 0,
            service_charge: 0,
            discount_minor: 0,
        },
    );
    pay(&conn, cash_invoice, "CASH", 5_000);
    pay(&conn, card_invoice, "CARD", 3_000);

    let report = analytics::analytics_charts(&conn, None, None).unwrap();

    assert_eq!(value(&report, "cash-visa", "cash"), 5_000);
    assert_eq!(value(&report, "cash-visa", "visa"), 3_000);
    assert_eq!(chart(&report, "cash-visa").total, 8_000);
}

#[test]
fn credit_is_never_counted_as_cash_or_card_revenue() {
    let conn = fresh();
    let day = add_day(&conn, "2026-09-11");
    let invoice = add_invoice(
        &conn,
        InvoiceFixture {
            invoice_no: 1,
            day_id: day,
            cafe_total: 8_000,
            wash_total: 2_000,
            service_charge: 0,
            discount_minor: 0,
        },
    );
    invoices::insert_payment(&conn, invoice, "CREDIT", 10_000, None, None, 1).unwrap();
    invoices::mark_invoice_credit(&conn, invoice).unwrap();

    let report = analytics::analytics_charts(&conn, None, None).unwrap();

    assert_eq!(value(&report, "cash-visa", "cash"), 0);
    assert_eq!(value(&report, "cash-visa", "visa"), 0);
    assert!(!chart(&report, "cash-visa").has_data);
    // The credit sale is still turnover for the sales-vs-expenses comparison.
    assert_eq!(value(&report, "sales-expenses", "sales"), 10_000);
}

#[test]
fn partially_paid_invoice_counts_only_the_settled_amount() {
    let conn = fresh();
    let day = add_day(&conn, "2026-09-12");
    let invoice = add_invoice(
        &conn,
        InvoiceFixture {
            invoice_no: 1,
            day_id: day,
            cafe_total: 10_000,
            wash_total: 0,
            service_charge: 0,
            discount_minor: 0,
        },
    );
    pay(&conn, invoice, "CASH", 4_000);
    let status: String = conn
        .query_row(
            "SELECT status FROM invoices WHERE id = ?1",
            [invoice],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "PARTIALLY_PAID");

    let report = analytics::analytics_charts(&conn, None, None).unwrap();

    assert_eq!(value(&report, "cash-visa", "cash"), 4_000);
}

/// Every invoice is a real document, so every chart counts all of them: the
/// department split, the payment ledger and the revenue total.
#[test]
fn every_invoice_reaches_every_chart() {
    let conn = fresh();
    let day = add_day(&conn, "2026-09-13");
    let first = add_invoice(
        &conn,
        InvoiceFixture {
            invoice_no: 1,
            day_id: day,
            cafe_total: 5_000,
            wash_total: 1_000,
            service_charge: 0,
            discount_minor: 0,
        },
    );
    let second = add_invoice(
        &conn,
        InvoiceFixture {
            invoice_no: 2,
            day_id: day,
            cafe_total: 9_000,
            wash_total: 9_000,
            service_charge: 0,
            discount_minor: 0,
        },
    );
    pay(&conn, first, "CASH", 6_000);
    pay(&conn, second, "CASH", 18_000);
    expenses::insert(
        &conn,
        "SUPPLIES",
        2_000,
        None,
        "2026-09-13",
        false,
        None,
        Some(day),
        None,
        true,
        1,
    )
    .unwrap();

    let report = analytics::analytics_charts(&conn, None, None).unwrap();

    assert_eq!(value(&report, "laundry-cafe", "laundry"), 10_000);
    assert_eq!(value(&report, "laundry-cafe", "cafe"), 14_000);
    assert_eq!(value(&report, "cash-visa", "cash"), 24_000);
    assert_eq!(value(&report, "sales-expenses", "sales"), 24_000);
    assert_eq!(value(&report, "sales-expenses", "expenses"), 2_000);
}

#[test]
fn range_filter_keeps_boundary_days_and_drops_everything_outside() {
    let conn = fresh();
    let before = add_day(&conn, "2026-08-31");
    let first = add_day(&conn, "2026-09-01");
    let last = add_day(&conn, "2026-09-30");
    let after = add_day(&conn, "2026-10-01");
    for (index, day) in [before, first, last, after].iter().enumerate() {
        let invoice = add_invoice(
            &conn,
            InvoiceFixture {
                invoice_no: index as i64 + 1,
                day_id: *day,
                cafe_total: 1_000,
                wash_total: 0,
                service_charge: 0,
                discount_minor: 0,
            },
        );
        pay(&conn, invoice, "CASH", 1_000);
    }

    let report =
        analytics::analytics_charts(&conn, Some("2026-09-01"), Some("2026-09-30")).unwrap();

    assert_eq!(value(&report, "cash-visa", "cash"), 2_000);
}

#[test]
fn single_day_range_matches_that_business_day_only() {
    let conn = fresh();
    let day_a = add_day(&conn, "2026-09-20");
    let day_b = add_day(&conn, "2026-09-21");
    add_invoice(
        &conn,
        InvoiceFixture {
            invoice_no: 1,
            day_id: day_a,
            cafe_total: 7_000,
            wash_total: 500,
            service_charge: 0,
            discount_minor: 0,
        },
    );
    add_invoice(
        &conn,
        InvoiceFixture {
            invoice_no: 2,
            day_id: day_b,
            cafe_total: 3_000,
            wash_total: 0,
            service_charge: 0,
            discount_minor: 0,
        },
    );

    let report =
        analytics::analytics_charts(&conn, Some("2026-09-20"), Some("2026-09-20")).unwrap();

    assert_eq!(value(&report, "laundry-cafe", "cafe"), 7_000);
    assert_eq!(value(&report, "laundry-cafe", "laundry"), 500);
}

#[test]
fn empty_range_is_unbounded_and_reports_all_persisted_data() {
    let conn = fresh();
    let day = add_day(&conn, "2026-01-05");
    add_invoice(
        &conn,
        InvoiceFixture {
            invoice_no: 1,
            day_id: day,
            cafe_total: 2_500,
            wash_total: 0,
            service_charge: 0,
            discount_minor: 0,
        },
    );

    let report = analytics::analytics_charts(&conn, Some(""), Some("")).unwrap();

    assert_eq!(value(&report, "laundry-cafe", "cafe"), 2_500);
}

#[test]
fn sales_total_keeps_the_invoice_total_with_discount_and_service_charge() {
    let conn = fresh();
    let day = add_day(&conn, "2026-09-15");
    // 10,000 cafe − 1,000 discount + 1,200 service charge = 10,200 total.
    add_invoice(
        &conn,
        InvoiceFixture {
            invoice_no: 1,
            day_id: day,
            cafe_total: 10_000,
            wash_total: 0,
            service_charge: 1_200,
            discount_minor: 1_000,
        },
    );
    expenses::insert(
        &conn,
        "UTILITY",
        5_200,
        Some("كهرباء"),
        "2026-09-15",
        false,
        None,
        Some(day),
        None,
        true,
        1,
    )
    .unwrap();
    // Expenses outside the period must not leak in.
    expenses::insert(
        &conn,
        "UTILITY",
        9_999,
        None,
        "2026-08-15",
        false,
        None,
        Some(day),
        None,
        true,
        1,
    )
    .unwrap();

    let report =
        analytics::analytics_charts(&conn, Some("2026-09-01"), Some("2026-09-30")).unwrap();

    assert_eq!(value(&report, "sales-expenses", "sales"), 10_200);
    assert_eq!(value(&report, "sales-expenses", "expenses"), 5_200);
    assert_eq!(chart(&report, "sales-expenses").total, 15_400);
}

#[test]
fn analytics_totals_reconcile_with_day_totals() {
    let conn = fresh();
    let day = add_day(&conn, "2026-09-18");
    let cash_invoice = add_invoice(
        &conn,
        InvoiceFixture {
            invoice_no: 1,
            day_id: day,
            cafe_total: 4_000,
            wash_total: 6_000,
            service_charge: 500,
            discount_minor: 0,
        },
    );
    let card_invoice = add_invoice(
        &conn,
        InvoiceFixture {
            invoice_no: 2,
            day_id: day,
            cafe_total: 1_000,
            wash_total: 2_000,
            service_charge: 0,
            discount_minor: 300,
        },
    );
    pay(&conn, cash_invoice, "CASH", 10_500);
    pay(&conn, card_invoice, "CARD", 2_700);

    let report =
        analytics::analytics_charts(&conn, Some("2026-09-18"), Some("2026-09-18")).unwrap();
    let day_totals = crate::repositories::shifts::day_totals(&conn, day).unwrap();

    assert_eq!(
        value(&report, "laundry-cafe", "laundry"),
        day_totals.wash_sales
    );
    assert_eq!(
        value(&report, "laundry-cafe", "cafe"),
        day_totals.cafe_sales
    );
    assert_eq!(value(&report, "cash-visa", "cash"), day_totals.cash);
    assert_eq!(value(&report, "cash-visa", "visa"), day_totals.card);
    assert_eq!(
        value(&report, "sales-expenses", "sales"),
        day_totals.total_sales
    );
}
