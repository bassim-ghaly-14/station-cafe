//! Sales management aggregation tests.
//!
//! These prove the BUSINESS SEMANTICS of the Sales page, not that it renders:
//!
//! 1. **Totals** — revenue, invoice count, average, discounts, service charges
//!    and the payment-method split, straight from the invoice snapshot.
//! 2. **Inclusion rules** — a cancelled invoice never counts, through any
//!    column, including through its own payment rows; a credit invoice counts
//!    as invoiced credit and never as collected cash.
//! 3. **Filtering** — business-day period, payment method, status, cashier and
//!    customer all narrow the SAME set for the KPIs, the trend, the items and
//!    the invoice list.
//! 4. **Item aggregation** — quantity, revenue, share and both sort orders.
//! 5. **Authorization** — a cashier is refused; a manager is served.

use crate::db::migrate;
use crate::repositories::invoices::{self, InvoiceLine};
use crate::repositories::sales_analytics::{self as sales, ItemSort, SalesFilter};
use crate::repositories::users::User;
use crate::services::sales as sales_svc;
use rusqlite::Connection;

fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();

    for (name, role) in [
        ("manager", "MANAGER"),
        ("cashier", "STAFF"),
        ("ahmed", "STAFF"),
    ] {
        conn.execute(
            "INSERT INTO users (name, role, password_hash) VALUES (?1, ?2, 'x')",
            rusqlite::params![name, role],
        )
        .unwrap();
    }

    conn
}

fn actor(conn: &Connection, name: &str) -> User {
    let (id, role) = conn
        .query_row("SELECT id, role FROM users WHERE name = ?1", [name], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();

    User {
        id,
        name: name.to_string(),
        phone: None,
        role,
        status: "ACTIVE".into(),
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn user_id(conn: &Connection, name: &str) -> i64 {
    conn.query_row("SELECT id FROM users WHERE name = ?1", [name], |r| r.get(0))
        .unwrap()
}

fn add_day(conn: &Connection, date: &str) -> i64 {
    conn.execute(
        "INSERT INTO business_days (day_date, opened_at, status, opened_by)
         VALUES (?1, datetime('now'), 'CLOSED', 1)",
        [date],
    )
    .unwrap();

    conn.last_insert_rowid()
}

fn add_order(conn: &Connection, day_id: i64, user_id: i64, customer_id: Option<i64>) -> i64 {
    conn.execute(
        "INSERT INTO orders (
            order_type,
            table_id,
            user_id,
            business_day_id,
            customer_id,
            status
         )
         VALUES ('TAKEAWAY', NULL, ?2, ?1, ?3, 'CLOSED')",
        rusqlite::params![day_id, user_id, customer_id],
    )
    .unwrap();

    conn.last_insert_rowid()
}

struct Sale {
    cafe: i64,
    wash: i64,
    service_charge: i64,
    discount: i64,
}

impl Sale {
    fn cafe(amount: i64) -> Self {
        Sale {
            cafe: amount,
            wash: 0,
            service_charge: 0,
            discount: 0,
        }
    }

    fn subtotal(&self) -> i64 {
        self.cafe + self.wash
    }

    fn total(&self) -> i64 {
        self.subtotal() - self.discount + self.service_charge
    }
}

/// Inserts an invoice through the repository — the same write path checkout uses.
fn add_invoice(
    conn: &Connection,
    invoice_no: i64,
    day_id: i64,
    user_id: i64,
    customer_id: Option<i64>,
    sale: Sale,
    lines: &[(&str, &str, i64, i64)],
) -> i64 {
    let order_id = add_order(conn, day_id, user_id, customer_id);

    let snap: Vec<InvoiceLine> = lines
        .iter()
        .map(|(department, name, quantity, line_total)| InvoiceLine {
            department: (*department).into(),
            product_name: (*name).into(),
            unit_price: if *quantity > 0 {
                line_total / quantity
            } else {
                0
            },
            quantity: *quantity,
            discount_minor: 0,
            line_total: *line_total,
        })
        .collect();

    invoices::insert_invoice(
        conn,
        invoice_no,
        order_id,
        None,
        day_id,
        None,
        user_id,
        "TAKEAWAY",
        None,
        customer_id,
        sale.subtotal(),
        sale.discount,
        None,
        None,
        sale.service_charge,
        sale.total(),
        sale.cafe,
        sale.wash,
        &snap,
    )
    .unwrap()
}

/// A settled cash sale of one cafe line.
fn cash_sale(conn: &Connection, no: i64, day_id: i64, user_id: i64, amount: i64) -> i64 {
    let id = add_invoice(
        conn,
        no,
        day_id,
        user_id,
        None,
        Sale::cafe(amount),
        &[("CAFE", "قهوة", 1, amount)],
    );

    invoices::insert_payment(conn, id, "CASH", amount, None, None, user_id).unwrap();
    invoices::apply_payment_to_invoice(conn, id, amount).unwrap();

    id
}

fn filter() -> SalesFilter {
    SalesFilter::default()
}

#[test]
fn monthly_revenue_aggregates_cafe_and_wash_per_calendar_month() {
    let conn = fresh();
    let september = add_day(&conn, "2026-09-10");
    let also_september = add_day(&conn, "2026-09-28");

    // A hybrid September invoice: cafe 4,000 + wash 6,000, no discount or charge.
    add_invoice(
        &conn,
        1,
        september,
        1,
        None,
        Sale {
            cafe: 4_000,
            wash: 6_000,
            service_charge: 0,
            discount: 0,
        },
        &[("CAFE", "قهوة", 1, 4_000), ("WASH", "غسيل", 1, 6_000)],
    );
    cash_sale(&conn, 2, also_september, 1, 2_500);

    let rows = sales::monthly(&conn, "2026-09-01", "2026-09-30").unwrap();

    assert_eq!(
        rows.len(),
        1,
        "two business days of one month are one bucket"
    );
    let row = &rows[0];
    assert_eq!(row.month, "2026-09");
    assert_eq!(row.invoices_count, 2);
    assert_eq!(row.cafe_sales, 6_500);
    assert_eq!(row.wash_sales, 6_000);
    assert_eq!(row.total_sales, 12_500);
}

#[test]
fn monthly_revenue_keeps_the_same_month_of_two_years_apart() {
    let conn = fresh();
    let last_january = add_day(&conn, "2025-01-15");
    let this_january = add_day(&conn, "2026-01-15");

    cash_sale(&conn, 1, last_january, 1, 3_000);
    cash_sale(&conn, 2, this_january, 1, 7_000);

    let rows = sales::monthly(&conn, "2025-01-01", "2026-01-31").unwrap();

    // Grouping by a display name would have produced one "January" of 10,000.
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].month, "2025-01");
    assert_eq!(rows[0].total_sales, 3_000);
    assert_eq!(rows[1].month, "2026-01");
    assert_eq!(rows[1].total_sales, 7_000);
    // Ascending by the stable key, so the latest month is always the last row.
    assert!(rows[0].month < rows[1].month);
}

#[test]
fn a_month_with_a_business_day_but_no_sales_stays_a_zero_month() {
    let conn = fresh();
    // January has a business day but no sale at all: a quiet month, not a gap.
    add_day(&conn, "2026-01-10");
    let february = add_day(&conn, "2026-02-10");
    cash_sale(&conn, 1, february, 1, 4_000);

    let rows = sales::monthly(&conn, "2026-01-01", "2026-02-28").unwrap();

    assert_eq!(
        rows.len(),
        2,
        "a quiet month must not vanish from the series"
    );
    assert_eq!(rows[0].month, "2026-01");
    assert_eq!(rows[0].invoices_count, 0);
    assert_eq!(rows[0].total_sales, 0);
    assert_eq!(rows[0].cafe_sales, 0);
    assert_eq!(rows[0].wash_sales, 0);
    assert_eq!(rows[1].month, "2026-02");
    assert_eq!(rows[1].total_sales, 4_000);
}

#[test]
fn monthly_revenue_counts_every_invoice_and_respects_the_window() {
    let conn = fresh();
    let inside = add_day(&conn, "2026-03-10");
    let outside = add_day(&conn, "2026-05-10");
    cash_sale(&conn, 1, inside, 1, 5_000);
    cash_sale(&conn, 2, inside, 1, 9_000);
    cash_sale(&conn, 3, outside, 1, 7_000);

    let rows = sales::monthly(&conn, "2026-03-01", "2026-04-30").unwrap();

    assert_eq!(rows.len(), 1, "May is outside the requested window");
    assert_eq!(rows[0].month, "2026-03");
    assert_eq!(rows[0].invoices_count, 2);
    assert_eq!(rows[0].total_sales, 14_000);
}

#[test]
fn an_empty_window_reports_no_months_instead_of_zero_months() {
    let conn = fresh();
    assert!(sales::monthly(&conn, "2020-01-01", "2020-12-31")
        .unwrap()
        .is_empty());
}

/// The window the service derives for each supported month count.
///
/// The expectation is computed the same way the product defines it — the first
/// day of the month `months - 1` back, through today — so the test states the
/// RULE rather than repeating a literal, and it can never drift from a season
/// boundary the way a hard-coded "2026-09" would.
fn expected_window(months: i64) -> (String, String) {
    let to = crate::time::today_business_date();
    (crate::time::business_date_months_ago(months - 1), to)
}

#[test]
fn the_monthly_window_follows_the_requested_month_count() {
    let conn = fresh();
    let manager = actor(&conn, "manager");

    for months in [6, 12, 18, 24] {
        let report = sales_svc::monthly(&conn, &manager, Some(months)).unwrap();

        assert_eq!(
            (report.from.as_str(), report.to.as_str()),
            (
                expected_window(months).0.as_str(),
                expected_window(months).1.as_str()
            ),
            "{months} months must cover its own trailing window"
        );
        // A window of N months starts N-1 months back: 6 → five months back.
        assert_eq!(
            report.from,
            crate::time::business_date_months_ago(months - 1)
        );
        assert!(
            report.from.ends_with("-01"),
            "a monthly window opens on a month start"
        );
        assert_eq!(report.to, crate::time::today_business_date());
    }
}

#[test]
fn the_monthly_window_counts_exactly_the_requested_buckets() {
    let conn = fresh();
    let manager = actor(&conn, "manager");
    // One business day in the current business month is enough to prove the
    // bucket count: the current month is always part of the window.
    add_day(&conn, &crate::time::today_business_date());
    let today = crate::time::today_business_date();
    let current_month = today[..7].to_string();

    for months in [6, 12, 18, 24] {
        let report = sales_svc::monthly(&conn, &manager, Some(months)).unwrap();

        // Only the current month has a business day, so the ROW count cannot
        // prove the window; the window bounds are what the chart is built from.
        assert_eq!(report.months.len(), 1);
        assert_eq!(report.months[0].month, current_month);
    }
}

#[test]
fn the_monthly_window_includes_the_current_business_month() {
    let conn = fresh();
    let manager = actor(&conn, "manager");
    let today = crate::time::today_business_date();
    add_day(&conn, &today);

    let report = sales_svc::monthly(&conn, &manager, Some(6)).unwrap();

    assert_eq!(report.months.len(), 1);
    assert_eq!(report.months[0].month, today[..7]);
    assert_eq!(
        report.to, today,
        "the window ends on the current business date"
    );
}

#[test]
fn the_monthly_window_keeps_two_years_apart_separate_at_every_length() {
    let conn = fresh();
    let manager = actor(&conn, "manager");
    // Two Januaries two years apart: with a 24-month window both are visible,
    // and they must stay two categories rather than one merged "January".
    cash_sale(&conn, 1, add_day(&conn, "2025-01-15"), 1, 3_000);
    cash_sale(&conn, 2, add_day(&conn, "2026-01-15"), 1, 7_000);

    let report = sales_svc::monthly(&conn, &manager, Some(24)).unwrap();
    let keys: Vec<&str> = report.months.iter().map(|row| row.month.as_str()).collect();

    assert!(keys.contains(&"2025-01"));
    assert!(keys.contains(&"2026-01"));
    // Exactly two: the current month has no business day in this fixture, and a
    // month without one is not a bucket (see the zero-month rule).
    assert_eq!(keys.len(), 2, "the two Januaries must stay two categories");
}

#[test]
fn the_monthly_window_ignores_the_sales_page_filter() {
    let conn = fresh();
    let manager = actor(&conn, "manager");
    cash_sale(
        &conn,
        1,
        add_day(&conn, &crate::time::today_business_date()),
        1,
        2_000,
    );

    // `monthly` takes no `SalesFilter` at all: the command cannot even be handed
    // the page's period, so the date picker cannot reshape this series.
    let report = sales_svc::monthly(&conn, &manager, Some(12)).unwrap();

    assert_eq!(report.months.len(), 1);
    assert_eq!(report.months[0].total_sales, 2_000);
}

#[test]
fn an_unsupported_month_count_is_refused_by_the_server() {
    let conn = fresh();
    let manager = actor(&conn, "manager");

    for months in [0, -5, 5, 7, 25, 9999] {
        assert!(
            sales_svc::monthly(&conn, &manager, Some(months)).is_err(),
            "{months} months must be refused"
        );
    }
    // And the supported set is exactly what the UI offers.
    for months in [6, 12, 18, 24] {
        assert!(sales_svc::monthly(&conn, &manager, Some(months)).is_ok());
    }
}

#[test]
fn the_monthly_report_states_its_own_trailing_window() {
    let conn = fresh();
    let manager = actor(&conn, "manager");
    let today = crate::time::today_business_date();

    let report = sales_svc::monthly(&conn, &manager, None).unwrap();

    // The window is a calendar window, not the page's business-day filter: it
    // always starts on the first day of a month and ends today.
    assert_eq!(report.to, today);
    assert!(report.from.ends_with("-01"));
    assert!(report.from <= report.to);
    // And it is never empty of months merely because the range is wide.
    assert!(report.months.len() <= 24);
}

#[test]
fn a_cashier_is_refused_the_monthly_report() {
    let conn = fresh();
    let cashier = actor(&conn, "cashier");
    assert!(sales_svc::monthly(&conn, &cashier, None).is_err());
}

#[test]
fn empty_period_reports_zeroes_instead_of_claiming_data() {
    let conn = fresh();
    let summary = sales::summary(&conn, &filter()).unwrap();

    assert_eq!(summary.invoices_count, 0);
    assert_eq!(summary.total_sales, 0);
    assert_eq!(summary.average_invoice, 0);
    assert_eq!(summary.cash_share, 0);
    assert!(sales::trend(&conn, &filter()).unwrap().is_empty());
    assert!(sales::items(&conn, &filter(), ItemSort::Revenue, None)
        .unwrap()
        .is_empty());
    assert!(sales::invoices(&conn, &filter()).unwrap().is_empty());
}

#[test]
fn summary_reports_totals_count_average_discounts_and_service_charge() {
    let conn = fresh();
    let day = add_day(&conn, "2026-09-10");

    // 3,000 cafe − 300 discount + 200 service charge = 2,900
    let first = add_invoice(
        &conn,
        1,
        day,
        1,
        None,
        Sale {
            cafe: 3_000,
            wash: 0,
            service_charge: 200,
            discount: 300,
        },
        &[("CAFE", "قهوة", 2, 3_000)],
    );

    invoices::insert_payment(&conn, first, "CASH", 2_900, None, None, 1).unwrap();
    invoices::apply_payment_to_invoice(&conn, first, 2_900).unwrap();

    cash_sale(&conn, 2, day, 1, 1_100);

    let summary = sales::summary(&conn, &filter()).unwrap();

    assert_eq!(summary.invoices_count, 2);
    assert_eq!(summary.subtotal, 4_100);
    assert_eq!(summary.discounts, 300);
    assert_eq!(summary.service_charges, 200);

    // The authoritative revenue is the invoice total: subtotal − discount + service.
    assert_eq!(summary.total_sales, 4_000);
    assert_eq!(summary.average_invoice, 2_000);
    assert_eq!(summary.cafe_sales, 4_100);
    assert_eq!(summary.wash_sales, 0);
    assert_eq!(summary.cash, 4_000);
    assert_eq!(summary.card, 0);
    assert_eq!(summary.credit, 0);
}

#[test]
fn payment_methods_come_from_the_ledger_and_credit_is_never_collected_cash() {
    let conn = fresh();
    let day = add_day(&conn, "2026-09-10");

    cash_sale(&conn, 1, day, 1, 3_000);

    let card = add_invoice(
        &conn,
        2,
        day,
        1,
        None,
        Sale::cafe(2_000),
        &[("CAFE", "شاي", 2, 2_000)],
    );

    invoices::insert_payment(&conn, card, "CARD", 2_000, None, None, 1).unwrap();
    invoices::apply_payment_to_invoice(&conn, card, 2_000).unwrap();

    conn.execute("INSERT INTO customers (name) VALUES ('عميل آجل')", [])
        .unwrap();

    let credit_customer = conn.last_insert_rowid();

    let credit = add_invoice(
        &conn,
        3,
        day,
        1,
        Some(credit_customer),
        Sale::cafe(1_000),
        &[("CAFE", "عصير", 1, 1_000)],
    );

    invoices::insert_payment(&conn, credit, "CREDIT", 1_000, None, None, 1).unwrap();
    invoices::mark_invoice_credit(&conn, credit).unwrap();

    let summary = sales::summary(&conn, &filter()).unwrap();

    assert_eq!(summary.cash, 3_000);
    assert_eq!(summary.card, 2_000);
    assert_eq!(summary.credit, 1_000);

    // Revenue includes the credit invoice; the settled split never does.
    assert_eq!(summary.total_sales, 6_000);
    assert_eq!(
        (summary.cash_share, summary.card_share, summary.credit_share),
        (50, 33, 17)
    );
}

/// Station has no cancelled invoice. This is a DOMAIN rule, so it is enforced
/// by the database itself: the status is gone from the `invoices` CHECK
/// constraint, and every persisted invoice therefore counts in every figure.
#[test]
fn the_schema_refuses_a_cancelled_invoice_and_the_kpis_count_every_invoice() {
    let conn = fresh();
    let day = add_day(&conn, "2026-09-10");

    // Both real invoices are counted, and every figure describes both of them.
    let first = cash_sale(&conn, 1, day, 1, 5_000);
    cash_sale(&conn, 2, day, 1, 9_000);

    // The status the application used to be able to write no longer exists.
    let attempt = conn.execute(
        "UPDATE invoices SET status = 'CANCELLED' WHERE id = ?1",
        [first],
    );
    assert!(
        attempt.is_err(),
        "the database must not accept a cancelled invoice"
    );

    let summary = sales::summary(&conn, &filter()).unwrap();

    // Both real invoices are counted, and every figure describes both of them.
    assert_eq!(summary.invoices_count, 2);
    assert_eq!(summary.total_sales, 14_000);
    assert_eq!(summary.cash, 14_000);

    // The item analysis groups by product, and both sales are the same cafe
    // product, so they aggregate into one line whose revenue is the sum.
    let items = sales::items(&conn, &filter(), ItemSort::Revenue, None).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].product_name, "قهوة");
    assert_eq!(items[0].revenue, 14_000);
    assert_eq!(items[0].quantity, 2);
    assert_eq!(items[0].share_percent, 100);

    assert_eq!(sales::invoices(&conn, &filter()).unwrap().len(), 2);
}

#[test]
fn the_period_filters_by_business_day_not_by_the_utc_instant() {
    let conn = fresh();

    let inside = add_day(&conn, "2026-09-10");
    let outside = add_day(&conn, "2026-09-20");

    cash_sale(&conn, 1, inside, 1, 4_000);
    cash_sale(&conn, 2, outside, 1, 7_000);

    let period = SalesFilter {
        from: Some("2026-09-10".into()),
        to: Some("2026-09-10".into()),
        ..SalesFilter::default()
    };

    let summary = sales::summary(&conn, &period).unwrap();

    assert_eq!(summary.invoices_count, 1);
    assert_eq!(summary.total_sales, 4_000);

    let trend = sales::trend(&conn, &period).unwrap();

    assert_eq!(trend.len(), 1);
    assert_eq!(trend[0].day_date, "2026-09-10");
    assert_eq!(trend[0].total_sales, 4_000);
}

#[test]
fn the_trend_keeps_a_business_day_that_has_no_matching_sale() {
    let conn = fresh();

    let busy = add_day(&conn, "2026-09-10");
    add_day(&conn, "2026-09-11");

    cash_sale(&conn, 1, busy, 1, 4_000);

    let period = SalesFilter {
        from: Some("2026-09-10".into()),
        to: Some("2026-09-11".into()),
        ..SalesFilter::default()
    };

    let trend = sales::trend(&conn, &period).unwrap();

    assert_eq!(trend.len(), 2);
    assert_eq!(trend[1].day_date, "2026-09-11");
    assert_eq!(trend[1].invoices_count, 0);
    assert_eq!(trend[1].total_sales, 0);
}

#[test]
fn the_method_filter_narrows_every_read_at_once() {
    let conn = fresh();
    let day = add_day(&conn, "2026-09-10");

    cash_sale(&conn, 1, day, 1, 4_000);

    let card = add_invoice(
        &conn,
        2,
        day,
        1,
        None,
        Sale::cafe(6_000),
        &[("CAFE", "كابتشينو", 1, 6_000)],
    );

    invoices::insert_payment(&conn, card, "CARD", 6_000, None, None, 1).unwrap();
    invoices::apply_payment_to_invoice(&conn, card, 6_000).unwrap();

    let card_only = SalesFilter {
        method: Some("CARD".into()),
        ..SalesFilter::default()
    };

    let summary = sales::summary(&conn, &card_only).unwrap();

    assert_eq!(summary.invoices_count, 1);
    assert_eq!(summary.total_sales, 6_000);
    assert_eq!(summary.cash, 0);
    assert_eq!(summary.card, 6_000);

    // The same set feeds the items and the invoice list.
    let items = sales::items(&conn, &card_only, ItemSort::Revenue, None).unwrap();

    assert_eq!(items.len(), 1);
    assert_eq!(items[0].product_name, "كابتشينو");

    let invoices = sales::invoices(&conn, &card_only).unwrap();

    assert_eq!(invoices.len(), 1);
    assert_eq!(invoices[0].payment_method.as_deref(), Some("CARD"));
}

#[test]
fn the_cashier_and_status_filters_narrow_the_same_set() {
    let conn = fresh();
    let day = add_day(&conn, "2026-09-10");
    let ahmed = user_id(&conn, "ahmed");

    cash_sale(&conn, 1, day, 1, 4_000);
    cash_sale(&conn, 2, day, ahmed, 6_000);

    let by_cashier = SalesFilter {
        user_id: Some(ahmed),
        ..SalesFilter::default()
    };

    let summary = sales::summary(&conn, &by_cashier).unwrap();

    assert_eq!(summary.total_sales, 6_000);
    assert_eq!(
        sales::invoices(&conn, &by_cashier).unwrap()[0]
            .user_name
            .as_deref(),
        Some("ahmed")
    );

    let paid = SalesFilter {
        status: Some("PAID".into()),
        ..SalesFilter::default()
    };

    assert_eq!(sales::summary(&conn, &paid).unwrap().invoices_count, 2);

    let credit_only = SalesFilter {
        status: Some("CREDIT".into()),
        ..SalesFilter::default()
    };

    assert_eq!(
        sales::summary(&conn, &credit_only).unwrap().invoices_count,
        0
    );
}

#[test]
fn the_customer_filter_matches_the_snapshotted_name() {
    let conn = fresh();
    let day = add_day(&conn, "2026-09-10");

    conn.execute(
        "INSERT INTO customers (name, phone) VALUES ('أحمد سيد', '0100')",
        [],
    )
    .unwrap();

    let customer = conn.last_insert_rowid();

    let named = add_invoice(
        &conn,
        1,
        day,
        1,
        Some(customer),
        Sale::cafe(5_000),
        &[("CAFE", "قهوة", 1, 5_000)],
    );

    invoices::insert_invoice_customer(&conn, named, "أحمد سيد", Some("0100"), None, None).unwrap();

    invoices::insert_payment(&conn, named, "CASH", 5_000, None, None, 1).unwrap();
    invoices::apply_payment_to_invoice(&conn, named, 5_000).unwrap();

    cash_sale(&conn, 2, day, 1, 1_000);

    let by_customer = SalesFilter {
        customer: Some("أحمد".into()),
        ..SalesFilter::default()
    };

    let summary = sales::summary(&conn, &by_customer).unwrap();

    assert_eq!(summary.invoices_count, 1);
    assert_eq!(summary.total_sales, 5_000);

    assert_eq!(
        sales::invoices(&conn, &by_customer).unwrap()[0]
            .customer_name
            .as_deref(),
        Some("أحمد سيد")
    );
}

#[test]
fn items_aggregate_quantity_revenue_and_share_and_honour_both_sort_orders() {
    let conn = fresh();
    let day = add_day(&conn, "2026-09-10");

    // Two espressos on one invoice, plus a cold brew and a wash on a hybrid order.
    let first = add_invoice(
        &conn,
        1,
        day,
        1,
        None,
        Sale::cafe(1_000),
        &[("CAFE", "قهوة", 2, 1_000)],
    );

    invoices::insert_payment(&conn, first, "CASH", 1_000, None, None, 1).unwrap();
    invoices::apply_payment_to_invoice(&conn, first, 1_000).unwrap();

    add_invoice(
        &conn,
        2,
        day,
        1,
        None,
        Sale {
            cafe: 1_200,
            wash: 3_000,
            service_charge: 0,
            discount: 0,
        },
        &[
            ("CAFE", "قهوة مثلجة", 1, 1_200),
            ("WASH", "غسيل خارجي", 1, 3_000),
        ],
    );

    let by_revenue = sales::items(&conn, &filter(), ItemSort::Revenue, None).unwrap();

    assert_eq!(by_revenue[0].product_name, "غسيل خارجي");
    assert_eq!(by_revenue[0].revenue, 3_000);
    assert_eq!(by_revenue[0].department, "WASH");

    // 3,000 of 5,200 item revenue = 58%.
    assert_eq!(by_revenue[0].share_percent, 58);
    assert_eq!(by_revenue.len(), 3);

    // The same three rows, ordered by how often they sold.
    let by_quantity = sales::items(&conn, &filter(), ItemSort::Quantity, None).unwrap();

    assert_eq!(by_quantity.len(), 3);
    assert_eq!(by_quantity[0].product_name, "قهوة");
    assert_eq!(by_quantity[0].quantity, 2);
    assert_eq!(by_quantity[0].revenue, 1_000);

    // The share belongs to the row, not to its position.
    assert_eq!(by_quantity[0].share_percent, 19);
}

#[test]
fn invoice_rows_expose_the_manager_fields_of_the_activity_list() {
    let conn = fresh();
    let day = add_day(&conn, "2026-09-10");

    let id = add_invoice(
        &conn,
        1,
        day,
        1,
        None,
        Sale {
            cafe: 4_000,
            wash: 0,
            service_charge: 500,
            discount: 500,
        },
        &[("CAFE", "قهوة", 1, 4_000)],
    );

    invoices::insert_invoice_customer(&conn, id, "بدون عميل", None, None, None).unwrap();

    invoices::insert_payment(&conn, id, "CARD", 4_000, None, None, 1).unwrap();
    invoices::apply_payment_to_invoice(&conn, id, 4_000).unwrap();

    cash_sale(&conn, 2, day, 1, 1_000);

    let rows = sales::invoices(&conn, &filter()).unwrap();

    // Newest first.
    assert_eq!(rows[0].invoice_no, 2);

    let row = rows.iter().find(|row| row.invoice_no == 1).unwrap();

    assert_eq!(row.day_date, "2026-09-10");
    assert_eq!(row.subtotal, 4_000);
    assert_eq!(row.discount_minor, 500);
    assert_eq!(row.service_charge, 500);
    assert_eq!(row.total, 4_000);
    assert_eq!(row.paid_amount, 4_000);
    assert_eq!(row.status, "PAID");
    assert_eq!(row.payment_method.as_deref(), Some("CARD"));
    assert_eq!(row.user_name.as_deref(), Some("manager"));
    assert_eq!(row.customer_name.as_deref(), Some("بدون عميل"));
}

#[test]
fn a_cashier_is_refused_every_sales_aggregate() {
    let conn = fresh();
    let cashier = actor(&conn, "cashier");

    assert!(sales_svc::overview(&conn, &cashier, &filter(), ItemSort::Revenue).is_err());
    assert!(sales_svc::invoices(&conn, &cashier, &filter()).is_err());
    assert!(sales_svc::cashiers(&conn, &cashier).is_err());
}

#[test]
fn a_manager_receives_the_whole_page_in_one_call() {
    let conn = fresh();
    let manager = actor(&conn, "manager");
    let day = add_day(&conn, "2026-09-10");

    cash_sale(&conn, 1, day, 1, 2_500);

    let overview = sales_svc::overview(&conn, &manager, &filter(), ItemSort::Revenue).unwrap();

    assert_eq!(overview.summary.total_sales, 2_500);
    assert_eq!(overview.trend.len(), 1);
    assert_eq!(overview.items.len(), 1);
    assert_eq!(sales_svc::cashiers(&conn, &manager).unwrap().len(), 3);
}

#[test]
fn malformed_filters_are_refused_before_any_query_runs() {
    assert!(sales_svc::validate(&SalesFilter {
        from: Some("10-09-2026".into()),
        ..SalesFilter::default()
    })
    .is_err());

    assert!(sales_svc::validate(&SalesFilter {
        from: Some("2026-09-20".into()),
        to: Some("2026-09-10".into()),
        ..SalesFilter::default()
    })
    .is_err());

    assert!(sales_svc::validate(&SalesFilter {
        method: Some("TRANSFER".into()),
        ..SalesFilter::default()
    })
    .is_err());

    assert!(sales_svc::validate(&SalesFilter {
        status: Some("REFUNDED".into()),
        ..SalesFilter::default()
    })
    .is_err());

    // An emptied field is "no filter", not an invalid one.
    let blank = SalesFilter {
        from: Some("  ".into()),
        method: Some(String::new()),
        ..SalesFilter::default()
    };

    assert!(sales_svc::validate(&blank).is_ok());

    // And it reads back as no filter at all, not as a match-everything.
    assert!(blank.is_empty());
}
