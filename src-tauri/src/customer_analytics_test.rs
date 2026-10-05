//! Customer management + analytics tests.
//!
//! Two things are proved here, and they are the two that matter:
//!
//! 1. **Authorization** — a cashier's payload contains no customer money at all
//!    (no `stats` object, and the drawer/KPI calls are refused), while manager
//!    and admin receive the real aggregate.
//! 2. **Aggregation** — the numbers come from persisted invoice snapshots and
//!    the credit ledger, follow the existing revenue rules (every invoice is a
//!    real document, credit is never "paid"), split by business type without
//!    double counting a hybrid invoice, and honour the business-day period
//!    filter.

use crate::db::migrate;
use crate::error::AppError;
use crate::repositories::customer_analytics as analytics;
use crate::repositories::invoices::{self, InvoiceLine};
use crate::repositories::users::User;
use crate::repositories::{customers, invoices as invoices_repo};
use crate::services::customers as customer_svc;
use rusqlite::Connection;

fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    for (name, role) in [
        ("manager", "MANAGER"),
        ("cashier", "STAFF"),
        ("admin", "ADMIN"),
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

fn add_day(conn: &Connection, date: &str) -> i64 {
    conn.execute(
        "INSERT INTO business_days (day_date, opened_at, status, opened_by)
         VALUES (?1, datetime('now'), 'CLOSED', 1)",
        [date],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn add_customer(conn: &Connection, name: &str, phone: Option<&str>) -> i64 {
    customers::insert(conn, name, phone, None).unwrap()
}

#[test]
fn export_phones_dedupes_skips_unusable_and_orders_deterministically() {
    let conn = fresh();
    let manager = actor(&conn, "manager");
    // The unique `phone_key` index already prevents two spellings of one
    // identity from coexisting, so dedupe is proved at the NORMALIZATION
    // level: "٠١٠٠ ١٢٣ ٤٥٦٧"-style variants normalize to one key and only the
    // first is kept. Raw duplicates can only exist pre-backfill (NULL key),
    // which the service resolves through the same normalizer.
    let zebra = add_customer(&conn, "كريم", Some("01111111111"));
    let keep = add_customer(&conn, "أحمد سيد", Some("01001234567"));
    add_customer(&conn, "بدون هاتف", None);
    conn.execute(
        "INSERT INTO customers (name, phone) VALUES ('فراغات', '   ')",
        [],
    )
    .unwrap();

    // All: skips null/blank, dedupes the shared number, orders by name.
    let all = customer_svc::export_phones(&conn, &manager, None).unwrap();
    let phones: Vec<&str> = all.iter().map(|r| r.phone.as_str()).collect();
    assert_eq!(phones, vec!["01001234567", "01111111111"]);
    assert_eq!(all[0].name, "أحمد سيد");
    assert!(all.iter().all(|r| !r.phone.trim().is_empty()));

    // Selected: exactly those rows.
    let sel = customer_svc::export_phones(&conn, &manager, Some(vec![keep, zebra])).unwrap();
    assert_eq!(sel.len(), 2);

    // A legacy row whose stored key is NULL still resolves through the
    // normalizer and dedupes against the live row.
    conn.execute(
        "INSERT INTO customers (name, phone, phone_key) VALUES ('نسخة قديمة', '0100-123-4567', NULL)",
        [],
    )
    .unwrap();
    let legacy_id: i64 = conn
        .query_row(
            "SELECT id FROM customers WHERE name = 'نسخة قديمة'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let with_legacy =
        customer_svc::export_phones(&conn, &manager, Some(vec![keep, legacy_id])).unwrap();
    assert_eq!(with_legacy.len(), 1);
    assert_eq!(with_legacy[0].name, "أحمد سيد");

    // Empty selection exports nothing — never falls through to "all".
    let empty = customer_svc::export_phones(&conn, &manager, Some(vec![])).unwrap();
    assert!(empty.is_empty());
}

#[test]
fn export_phones_is_manager_gated() {
    let conn = fresh();
    let cashier = actor(&conn, "cashier");
    add_customer(&conn, "أحمد سيد", Some("01001234567"));
    let err = customer_svc::export_phones(&conn, &cashier, None).unwrap_err();
    assert_eq!(err.to_string(), "unauthorized: auth.forbidden");
    // Manager and admin both pass the gate.
    assert!(customer_svc::export_phones(&conn, &actor(&conn, "manager"), None).is_ok());
    assert!(customer_svc::export_phones(&conn, &actor(&conn, "admin"), None).is_ok());
}

/// A real cafe table — a TABLE order is only valid with one (schema CHECK).
fn add_table(conn: &Connection, label: &str) -> i64 {
    conn.execute("INSERT INTO cafe_tables (label) VALUES (?1)", [label])
        .unwrap();
    conn.last_insert_rowid()
}

struct InvoiceFixture {
    customer_id: Option<i64>,
    day_id: i64,
    order_type: &'static str,
    cafe_total: i64,
    wash_total: i64,
    discount: i64,
    service_charge: i64,
    paid: i64,
}

impl InvoiceFixture {
    fn total(&self) -> i64 {
        self.cafe_total + self.wash_total + self.service_charge - self.discount
    }
}

/// Inserts a real invoice through the repository — the same write path checkout
/// uses, so the fixtures are production-shaped rows and not a mock.
fn add_invoice(conn: &Connection, invoice_no: i64, fixture: InvoiceFixture) -> i64 {
    // A TABLE order must reference a real table; a takeaway must not.
    let (table_id, table_label) = if fixture.order_type == "TABLE" {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM cafe_tables", [], |r| r.get(0))
            .unwrap();
        let label = format!("طاولة {:02}", count + 1);
        (Some(add_table(conn, &label)), Some(label))
    } else {
        (None, None)
    };
    conn.execute(
        "INSERT INTO orders (order_type, table_id, user_id, business_day_id, status)
         VALUES (?1, ?2, 1, ?3, 'CLOSED')",
        rusqlite::params![fixture.order_type, table_id, fixture.day_id],
    )
    .unwrap();
    let order_id = conn.last_insert_rowid();
    let lines = vec![InvoiceLine {
        department: "CAFE".into(),
        product_name: "قهوة".into(),
        unit_price: fixture.cafe_total,
        quantity: 1,
        discount_minor: 0,
        line_total: fixture.cafe_total,
    }];
    let id = invoices::insert_invoice(
        conn,
        invoice_no,
        order_id,
        table_label.as_deref(),
        fixture.day_id,
        None,
        1,
        fixture.order_type,
        None,
        fixture.customer_id,
        fixture.cafe_total + fixture.wash_total,
        fixture.discount,
        None,
        None,
        fixture.service_charge,
        fixture.total(),
        fixture.cafe_total,
        fixture.wash_total,
        &lines,
    )
    .unwrap();
    if fixture.paid > 0 {
        invoices::insert_payment(conn, id, "CASH", fixture.paid, None, None, 1).unwrap();
        invoices::apply_payment_to_invoice(conn, id, fixture.paid).unwrap();
    }
    id
}

fn base(customer_id: i64, day_id: i64) -> InvoiceFixture {
    InvoiceFixture {
        customer_id: Some(customer_id),
        day_id,
        order_type: "TABLE",
        cafe_total: 0,
        wash_total: 0,
        discount: 0,
        service_charge: 0,
        paid: 0,
    }
}

/// One customer with a hybrid invoice, a takeaway invoice, an invoice in
/// another business day, and a partly settled credit account.
fn populated(conn: &Connection) -> (i64, i64) {
    let day = add_day(conn, "2026-09-10");
    let other_day = add_day(conn, "2026-09-20");
    let customer = add_customer(conn, "أحمد سيد", Some("٠١٠٠ ١٢٣ ٤٥٦٧"));

    // Hybrid: cafe + wash on ONE invoice — counted once per department split.
    add_invoice(
        conn,
        1,
        InvoiceFixture {
            cafe_total: 4_000,
            wash_total: 6_000,
            discount: 1_000,
            service_charge: 500,
            paid: 9_500,
            ..base(customer, day)
        },
    );
    // A second, cafe-only takeaway settled in cash.
    add_invoice(
        conn,
        2,
        InvoiceFixture {
            order_type: "TAKEAWAY",
            cafe_total: 2_000,
            paid: 2_000,
            ..base(customer, day)
        },
    );
    // Outside the period: excluded whenever the period is bounded.
    add_invoice(
        conn,
        4,
        InvoiceFixture {
            order_type: "TAKEAWAY",
            wash_total: 8_000,
            paid: 8_000,
            ..base(customer, other_day)
        },
    );

    invoices_repo::open_or_extend_credit(conn, customer, 7_000).unwrap();
    invoices_repo::pay_credit(conn, 1, 2_000, 1).unwrap();
    (customer, day)
}

// ---- AUTHORIZATION ---------------------------------------------------------

#[test]
fn cashier_list_carries_no_customer_money() {
    let conn = fresh();
    populated(&conn);
    let cashier = actor(&conn, "cashier");

    let list = customer_svc::list(&conn, &cashier, "", None, None).unwrap();

    assert!(!list.financial_visible);
    assert!(!list.customers.is_empty());
    for row in &list.customers {
        // The aggregate is absent from the payload, not zeroed inside it.
        assert!(row.stats.is_none(), "cashier must not receive stats");
        // Identity is what the cashier needs to serve the customer.
        assert!(!row.name.is_empty());
    }
    // The aggregate is absent from the payload, not zeroed inside it.
    let json = serde_json::to_string(&list).unwrap();
    assert!(json.contains("\"stats\":null"), "no aggregate is sent");
    assert!(!json.contains("credit_outstanding"));
    assert!(!json.contains("invoices_count"));
}

#[test]
fn manager_and_admin_receive_the_real_aggregate() {
    let conn = fresh();
    populated(&conn);

    for name in ["manager", "admin"] {
        let list = customer_svc::list(&conn, &actor(&conn, name), "", None, None).unwrap();
        assert!(list.financial_visible, "{name} must see customer money");
        let row = list
            .customers
            .iter()
            .find(|row| row.name == "أحمد سيد")
            .expect("seeded customer listed");
        let stats = row.stats.as_ref().expect("manager receives stats");
        // Invoices 1, 2 and 4 — the one outside the period is a different day,
        // and every invoice that exists is a real document, so all three count.
        assert_eq!(stats.invoices_count, 3, "{name}");
        assert_eq!(stats.paid, 19_500, "{name}");
    }
}

#[test]
fn cashier_is_refused_customer_analytics() {
    let conn = fresh();
    populated(&conn);
    let (customer, _) = (1, 0);
    let cashier = actor(&conn, "cashier");

    let err = customer_svc::overview(&conn, &cashier, None, None).unwrap_err();
    assert!(matches!(err, AppError::Unauthorized(_)), "{err:?}");

    let err = customer_svc::details(&conn, &cashier, customer, None, None).unwrap_err();
    assert!(matches!(err, AppError::Unauthorized(_)), "{err:?}");
}

#[test]
fn manager_and_admin_can_read_customer_analytics() {
    let conn = fresh();
    let (customer, day) = populated(&conn);

    for name in ["manager", "admin"] {
        let actor = actor(&conn, name);
        let overview =
            customer_svc::overview(&conn, &actor, Some("2026-09-01"), Some("2026-09-30")).unwrap();
        assert_eq!(overview.active_customers, 1, "{name}");
        assert_eq!(overview.total_paid, 19_500, "{name}");

        let details = customer_svc::details(&conn, &actor, customer, None, None).unwrap();
        assert_eq!(details.customer.name, "أحمد سيد", "{name}");
        assert!(!details.activity.is_empty(), "{name}");
        let _ = day;
    }
}

// ---- AGGREGATION -----------------------------------------------------------

#[test]
fn customer_aggregates_follow_the_invoice_snapshot() {
    let conn = fresh();
    let (customer, _) = populated(&conn);

    let stats = analytics::stats_for(&conn, customer, None, None).unwrap();

    // 3 live invoices: hybrid 9,500 + takeaway cafe 2,000 + wash 8,000.
    assert_eq!(stats.invoices_count, 3);
    assert_eq!(stats.total, 9_500 + 2_000 + 8_000);
    assert_eq!(stats.paid, 9_500 + 2_000 + 8_000);
    assert_eq!(stats.discounts, 1_000);
    assert_eq!(stats.service_charges, 500);
    assert_eq!(stats.average_order, (9_500 + 2_000 + 8_000) / 3);
    // Department axis: the hybrid order appears in both departments, and the
    // department amounts still sum to the subtotal — no double counting.
    assert_eq!(stats.cafe_orders, 2);
    assert_eq!(stats.cafe_total, 6_000);
    assert_eq!(stats.wash_orders, 2);
    assert_eq!(stats.wash_total, 14_000);
    // Order type is the OTHER axis: 3 orders, 2 of them takeaways.
    assert_eq!(stats.takeaway_orders, 2);
    assert_eq!(stats.table_orders, 1);
    assert!(stats.first_at.is_some() && stats.last_at.is_some());
    // Credit: 7,000 taken, 2,000 settled → 5,000 outstanding.
    assert_eq!(stats.credit_original, 7_000);
    assert_eq!(stats.credit_paid, 2_000);
    assert_eq!(stats.credit_outstanding, 5_000);
}

#[test]
fn credit_invoice_is_never_counted_as_paid() {
    let conn = fresh();
    let day = add_day(&conn, "2026-09-10");
    let customer = add_customer(&conn, "بالحساب الآجل", None);
    add_invoice(
        &conn,
        1,
        InvoiceFixture {
            cafe_total: 5_000,
            ..base(customer, day)
        },
    );
    invoices_repo::open_or_extend_credit(&conn, customer, 5_000).unwrap();

    let stats = analytics::stats_for(&conn, customer, None, None).unwrap();

    assert_eq!(stats.total, 5_000);
    assert_eq!(stats.paid, 0, "a credit invoice is not settled money");
    assert_eq!(stats.credit_outstanding, 5_000);
}

#[test]
fn period_filter_scopes_every_figure() {
    let conn = fresh();
    let (customer, _) = populated(&conn);

    let in_period =
        analytics::stats_for(&conn, customer, Some("2026-09-01"), Some("2026-09-15")).unwrap();
    assert_eq!(in_period.invoices_count, 2, "the 09-20 invoice is outside");
    assert_eq!(in_period.paid, 11_500);
    assert_eq!(in_period.cafe_total, 6_000);
    assert_eq!(in_period.wash_total, 6_000);
    // The credit balance is a standing balance, so it is NOT period-scoped.
    assert_eq!(in_period.credit_outstanding, 5_000);

    let other =
        analytics::stats_for(&conn, customer, Some("2026-09-18"), Some("2026-09-30")).unwrap();
    assert_eq!(other.invoices_count, 1);
    assert_eq!(other.paid, 8_000);
}

#[test]
fn customer_search_matches_name_phone_and_plate() {
    let conn = fresh();
    let customer = add_customer(&conn, "أحمد سيد", Some("01001234567"));
    customers::insert_car(&conn, customer, "أ ب ج ١٢٣٤", Some("تويوتا"), None).unwrap();
    add_customer(&conn, "محمود", None);

    let by_name = analytics::list_rows(&conn, "أحمد", None, None, false).unwrap();
    assert_eq!(by_name.len(), 1);
    assert_eq!(by_name[0].plates, vec!["أ ب ج ١٢٣٤".to_string()]);
    assert_eq!(by_name[0].cars_count, 1);

    // ASCII digits find the record stored with Arabic-Indic digits.
    let by_phone = analytics::list_rows(&conn, "٠١٠٠١٢٣٤٥٦٧", None, None, false).unwrap();
    assert_eq!(by_phone.len(), 1);

    let by_plate = analytics::list_rows(&conn, "أ ب ج ١٢٣٤", None, None, false).unwrap();
    assert_eq!(by_plate.len(), 1);

    let no_match = analytics::list_rows(&conn, "لا يوجد", None, None, false).unwrap();
    assert!(no_match.is_empty());
}

#[test]
fn overview_reports_period_kpis_and_leaders() {
    let conn = fresh();
    populated(&conn);
    let day = add_day(&conn, "2026-09-10");
    let other = add_customer(&conn, "محمود", None);
    add_invoice(
        &conn,
        9,
        InvoiceFixture {
            order_type: "TAKEAWAY",
            cafe_total: 1_000,
            paid: 1_000,
            ..base(other, day)
        },
    );

    let overview = analytics::overview(&conn, Some("2026-09-01"), Some("2026-09-15")).unwrap();

    assert_eq!(overview.total_customers, 2, "all registered customers");
    assert_eq!(overview.active_customers, 2, "both ordered in the period");
    assert_eq!(overview.total_orders, 3);
    assert_eq!(overview.total_paid, 12_500);
    assert_eq!(overview.average_spend, 12_500 / 2);
    // Department axis: hybrid + cafe takeaway + cafe-only = 3 cafe orders.
    assert_eq!(overview.cafe_orders, 3);
    assert_eq!(overview.wash_orders, 1);
    // Order-type axis: 2 takeaways + 1 table.
    assert_eq!(overview.takeaway_orders, 2);
    assert_eq!(overview.table_orders, 1);
    assert_eq!(overview.outstanding_credit, 5_000);

    let top_orders = overview.top_by_orders.expect("a leader by orders");
    assert_eq!(top_orders.name, "أحمد سيد");
    assert_eq!(top_orders.value, 2);
    let top_spend = overview.top_by_spend.expect("a leader by spend");
    assert_eq!(top_spend.name, "أحمد سيد");
    assert_eq!(top_spend.value, 11_500);
}

#[test]
fn details_returns_identity_cars_and_recent_activity() {
    let conn = fresh();
    let (customer, _) = populated(&conn);
    customers::insert_car(&conn, customer, "ABC123", Some("هيundai"), None).unwrap();

    let details = analytics::details(&conn, customer, None, None).unwrap();

    assert_eq!(details.customer.name, "أحمد سيد");
    assert_eq!(details.cars.len(), 1);
    assert_eq!(details.cars[0].plate_no, "ABC123");
    assert!(!details.created_at.is_empty());
    // Newest first.
    assert_eq!(details.activity[0].invoice_no, 4);
    let hybrid = details
        .activity
        .iter()
        .find(|row| row.invoice_no == 1)
        .expect("hybrid invoice listed");
    assert_eq!(hybrid.cafe_total, 4_000);
    assert_eq!(hybrid.wash_total, 6_000);
    assert_eq!(hybrid.status, "PAID");
}

#[test]
fn details_of_an_unknown_customer_is_a_not_found_error() {
    let conn = fresh();
    let err = analytics::details(&conn, 999, None, None).unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
}

#[test]
fn period_bounds_must_be_iso_dates() {
    let valid = customer_svc::CustomerPeriod {
        from: Some("2026-09-01".into()),
        to: Some(" 2026-09-30 ".into()),
    };
    assert!(customer_svc::validate_period(&valid).is_ok());
    // A blank bound is an open bound, exactly like the reports filter.
    let open = customer_svc::CustomerPeriod {
        from: Some(String::new()),
        to: None,
    };
    assert!(customer_svc::validate_period(&open).is_ok());
    let bad = customer_svc::CustomerPeriod {
        from: Some("01-09-2026".into()),
        to: None,
    };
    assert!(matches!(
        customer_svc::validate_period(&bad),
        Err(AppError::Validation(_))
    ));
}

#[test]
fn overview_of_an_empty_period_reports_zeroes_not_errors() {
    let conn = fresh();
    populated(&conn);

    let overview = analytics::overview(&conn, Some("2020-01-01"), Some("2020-01-31")).unwrap();

    assert_eq!(overview.active_customers, 0);
    assert_eq!(overview.total_orders, 0);
    assert_eq!(overview.average_spend, 0);
    assert!(overview.top_by_orders.is_none());
    assert!(overview.top_by_spend.is_none());
    // The standing credit balance is still real, whatever the period.
    assert_eq!(overview.outstanding_credit, 5_000);
}

#[test]
fn search_and_period_apply_alongside_the_aggregate_join() {
    // The list binds the period arguments first (they live inside the derived
    // aggregate table) and the search arguments after them. A wrong order would
    // silently filter by the wrong value, so the combination is proved here.
    let conn = fresh();
    let (customer, _) = populated(&conn);
    let other = add_customer(&conn, "محمود", None);

    let rows =
        analytics::list_rows(&conn, "أحمد", Some("2026-09-01"), Some("2026-09-15"), true).unwrap();
    assert_eq!(rows.len(), 1, "the search narrows the list");
    assert_eq!(rows[0].id, customer);
    // The period still applies INSIDE the aggregate.
    let stats = rows[0].stats.as_ref().expect("aggregate joined");
    assert_eq!(stats.invoices_count, 2);
    assert_eq!(stats.paid, 11_500);

    // A customer with no activity in the period is listed with zeroes, not lost.
    let none =
        analytics::list_rows(&conn, "محمود", Some("2026-09-01"), Some("2026-09-15"), true).unwrap();
    assert_eq!(none.len(), 1);
    assert_eq!(none[0].id, other);
    assert_eq!(none[0].stats.as_ref().unwrap().invoices_count, 0);
}
