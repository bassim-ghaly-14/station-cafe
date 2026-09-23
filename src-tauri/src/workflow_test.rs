//! End-to-end business workflow tests (Phase 2 Definition of Done).
//!
//! Manager creates staff → staff logs in → opens day → opens shift → opens
//! table → adds cafe item → adds wash service → selects customer/car →
//! issues wash ticket → discount + service charge → pays cash → invoice
//! created → table closed → shift closed (expected vs actual) → day closed.
//! Financial integrity is asserted at each step.

use crate::db::migrate;
use crate::repositories::{catalog, customers, invoices, pos, shifts};
use crate::seed::run_if_empty;
use crate::services::{auth, checkout, pos as pos_svc, settings, shifts as shift_svc};
use rusqlite::Connection;

fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    run_if_empty(&conn).unwrap();
    conn
}

fn login(conn: &Connection, name: &str, password: &str) -> auth::User {
    auth::login(
        conn,
        &auth::LoginInput {
            name: name.into(),
            password: password.into(),
        },
    )
    .unwrap()
    .user
}

fn cafe_product(conn: &Connection, name: &str) -> i64 {
    catalog::list(conn, Some("CAFE"), true)
        .unwrap()
        .into_iter()
        .find(|p| p.name == name)
        .expect("seeded cafe product")
        .id
}

fn wash_service(conn: &Connection, name: &str) -> i64 {
    catalog::list(conn, Some("WASH"), true)
        .unwrap()
        .into_iter()
        .find(|p| p.name == name)
        .expect("seeded wash service")
        .id
}

#[test]
fn full_pos_lifecycle_preserves_financial_integrity() {
    let conn = fresh();

    // ---- manager creates a cashier, staff logs in --------------------------
    let manager = login(&conn, "manager", "manager123");
    let hash = auth::hash_password("staff123").unwrap();
    let staff_id = crate::repositories::users::insert(
        &conn,
        &crate::repositories::users::NewUser {
            name: "hassan",
            phone: Some("01000000001"),
            role: "STAFF",
            password_hash: &hash,
            is_seed: false,
        },
    )
    .unwrap()
    .unwrap();
    assert!(staff_id > 0);
    let staff = login(&conn, "hassan", "staff123");
    assert_eq!(staff.role, "STAFF");

    // ---- day + shift -------------------------------------------------------
    let day_id = shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 50_000).unwrap();
    assert!(
        shift_svc::open_shift(&conn, &staff, 1_000).is_err(),
        "double shift must fail"
    );

    // ---- open a table (shift-gated), then enter its order -----------------
    let table = pos::list_tables(&conn, None).unwrap().remove(0);
    pos_svc::open_table(&conn, &staff, table.id).unwrap();
    // Opening a table alone must NEVER create an order.
    assert!(pos::active_order_on_table(&conn, table.id)
        .unwrap()
        .is_none());
    let order_id = pos_svc::start_order(&conn, &staff, table.id).unwrap();
    assert!(pos::active_order_on_table(&conn, table.id)
        .unwrap()
        .is_some());

    // ---- cafe items + wash service on the SAME table ----------------------
    pos_svc::add_line(&conn, &staff, order_id, cafe_product(&conn, "قهوة"), 2).unwrap();
    pos_svc::add_line(
        &conn,
        &staff,
        order_id,
        cafe_product(&conn, "مياه معدنية"),
        1,
    )
    .unwrap();
    pos_svc::add_line(
        &conn,
        &staff,
        order_id,
        wash_service(&conn, "مغسلة كامل"),
        1,
    )
    .unwrap();

    // ---- customer + car (required for wash) --------------------------------
    let customer_id = customers::insert(&conn, "أحمد محمود", Some("01234567890"), None).unwrap();
    customers::insert_car(&conn, customer_id, "ABC123", Some("تويوتا"), None).unwrap();
    pos_svc::attach_customer(&conn, order_id, customer_id, Some("ABC123")).unwrap();

    // ---- wash job ticket ---------------------------------------------------
    let ticket = pos_svc::issue_wash_ticket(&conn, order_id).unwrap();
    assert_eq!(ticket.waiting_no, 1);
    assert_eq!(ticket.car_plate, "ABC123");
    assert_eq!(ticket.services, vec!["مغسلة كامل"]);

    // ---- service charge configuration (fixed 20.00 EGP) --------------------
    settings::set_service_charge(
        &conn,
        &manager,
        &settings::ServiceChargeConfig {
            mode: settings::ServiceChargeMode::Fixed,
            value: 2_000,
        },
    )
    .unwrap();

    // ---- discount 10% ------------------------------------------------------
    let preview = pos_svc::preview(&conn, order_id, Some("PERCENT"), Some(10_000)).unwrap();
    assert_eq!(preview.subtotal, 19_000); // 60 + 10 + 120
    assert_eq!(preview.discount_minor, 1_900); // 10%
    assert_eq!(preview.service_charge_minor, 2_000); // fixed
    assert_eq!(preview.total, 19_100); // (190 − 19) + 20
    pos_svc::mark_ready_to_pay(&conn, &staff, order_id).unwrap();

    // ---- pay CASH with change ---------------------------------------------
    let result = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: Some("PERCENT".into()),
            discount_value: Some(10_000),
            received: Some(20_000),
        },
    )
    .unwrap();
    assert_eq!(result.total, 19_100);
    assert_eq!(result.change_given, Some(900));
    assert_eq!(result.status, "PAID");

    // Invoice snapshot is complete and correct.
    let (inv, lines) = invoices::get_invoice_full(&conn, result.invoice_id)
        .unwrap()
        .unwrap();
    assert_eq!(inv.subtotal, 19_000);
    assert_eq!(inv.discount_minor, 1_900);
    assert_eq!(inv.service_charge, 2_000);
    assert_eq!(inv.total, 19_100);
    assert_eq!(inv.paid_amount, 19_100);
    assert_eq!(inv.cafe_total, 7_000);
    assert_eq!(inv.wash_total, 12_000);
    assert_eq!(inv.customer_name.as_deref(), Some("أحمد محمود"));
    assert_eq!(inv.car_plate.as_deref(), Some("ABC123"));
    assert_eq!(inv.order_type, "TABLE"); // table invoices never carry a takeaway number
    assert_eq!(inv.takeaway_no, None);
    assert_eq!(lines.len(), 3);

    // Table is free again.
    let tables = pos::list_tables(&conn, None).unwrap();
    assert_eq!(
        tables.iter().find(|t| t.id == table.id).unwrap().status,
        "EMPTY"
    );

    // ---- a later price change must NOT move history -----------------------
    catalog::update_price(&conn, cafe_product(&conn, "قهوة"), 9_900).unwrap();
    let (inv_again, _) = invoices::get_invoice_full(&conn, result.invoice_id)
        .unwrap()
        .unwrap();
    assert_eq!(inv_again.total, 19_100, "invoice totals must be immutable");

    // ---- close shift: expected vs actual, explicit difference -------------
    let closing = shift_svc::close_shift(&conn, &staff, 69_050).unwrap();
    assert_eq!(closing.expected_cash, 69_100); // 500 opening + 191.00 cash sales
    assert_eq!(closing.difference, -50);
    assert!(
        shift_svc::close_shift(&conn, &staff, 1).is_err(),
        "double close must fail"
    );

    // ---- close the business day -------------------------------------------
    let totals = shift_svc::close_day(&conn, &manager).unwrap();
    assert_eq!(totals.invoices_count, 1);
    assert_eq!(totals.total_sales, 19_100);
    assert_eq!(totals.cash, 19_100);
    assert_eq!(totals.service_charges, 2_000);
    assert_eq!(totals.discounts, 1_900);
    assert!(
        shift_svc::close_day(&conn, &manager).is_err(),
        "day already closed"
    );

    // Day is CLOSED and no shift stays open.
    assert!(shifts::current_day(&conn).unwrap().is_none());
    let day_shifts = shifts::shifts_of_day(&conn, day_id).unwrap();
    assert_eq!(day_shifts.len(), 1);
    assert_eq!(day_shifts[0].id, shift_id);
    assert_eq!(day_shifts[0].status, "CLOSED");

    // ---- audit trail covers the whole lifecycle ---------------------------
    let actions: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT action FROM audit_log ORDER BY id")
            .unwrap();
        let rows = stmt.query_map([], |r| r.get(0)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    };
    for expected in [
        "auth.login",
        "day.opened",
        "shift.opened",
        "invoice.created",
        "shift.closed",
        "day.closed",
    ] {
        assert!(
            actions.iter().any(|a| a == expected),
            "missing audit entry {expected}"
        );
    }
}

#[test]
fn table_cannot_be_opened_without_an_active_shift() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let table = pos::list_tables(&conn, None).unwrap().remove(0);
    // Day is open but the manager has no ACTIVE shift → business rule blocks it.
    let err = pos_svc::open_table(&conn, &manager, table.id).unwrap_err();
    assert_eq!(err.kind(), crate::error::ErrorKind::BusinessRule);
}

#[test]
fn day_cannot_be_opened_twice() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let err = shift_svc::open_day(&conn, &manager).unwrap_err();
    assert_eq!(err.kind(), crate::error::ErrorKind::BusinessRule);
}

#[test]
fn day_cannot_close_while_a_shift_is_open() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &manager, 10_000).unwrap();
    let err = shift_svc::close_day(&conn, &manager).unwrap_err();
    assert_eq!(err.kind(), crate::error::ErrorKind::BusinessRule);
}

#[test]
fn credit_flow_tracks_outstanding_until_settled() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &manager, 0).unwrap();

    // Credit authorization is explicit (default mode = LIST).
    let customer_id = customers::insert(&conn, "شركة النور", Some("01111111111"), None).unwrap();
    let table = pos::list_tables(&conn, None).unwrap().remove(0);
    pos_svc::open_table(&conn, &manager, table.id).unwrap();
    let order_id = pos_svc::start_order(&conn, &manager, table.id).unwrap();
    pos_svc::add_line(&conn, &manager, order_id, cafe_product(&conn, "نسكافيه"), 2).unwrap();
    pos_svc::attach_customer(&conn, order_id, customer_id, None).unwrap();
    pos_svc::mark_ready_to_pay(&conn, &manager, order_id).unwrap();

    let credit_input = checkout::CheckoutInput {
        order_id,
        method: "CREDIT".into(),
        discount_mode: None,
        discount_value: None,
        received: None,
    };
    // Not authorized yet → rejected.
    let denied = checkout::checkout(&conn, &manager, &credit_input).unwrap_err();
    assert_eq!(denied.kind(), crate::error::ErrorKind::BusinessRule);

    // Manager authorizes the customer → credit sale allowed.
    settings::set_credit_config(
        &conn,
        &manager,
        &settings::CreditConfig {
            mode: "LIST".into(),
            allowed_customer_ids: vec![customer_id],
        },
    )
    .unwrap();
    let result = checkout::checkout(&conn, &manager, &credit_input).unwrap();
    assert_eq!(result.status, "CREDIT");

    let acct = invoices::credit_account_for(&conn, customer_id)
        .unwrap()
        .unwrap();
    assert_eq!(acct.1, 7_000); // original amount
    assert_eq!(acct.2, 0); // nothing paid yet

    // Partial settlement → PARTIALLY_PAID, then full → PAID.
    assert_eq!(
        checkout::settle_credit(&conn, &manager, customer_id, 2_000).unwrap(),
        "PARTIALLY_PAID"
    );
    assert_eq!(
        checkout::settle_credit(&conn, &manager, customer_id, 5_000).unwrap(),
        "PAID"
    );
    // Overpayment is refused.
    assert!(checkout::settle_credit(&conn, &manager, customer_id, 100).is_err());
}

#[test]
fn takeaway_order_has_takeaway_number_and_no_table_session() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();

    // A takeaway starts as its own first-class order (no table opened).
    let order_id = pos_svc::start_takeaway(&conn, &staff).unwrap();
    pos_svc::add_line(&conn, &staff, order_id, cafe_product(&conn, "قهوة"), 2).unwrap();
    pos_svc::mark_ready_to_pay(&conn, &staff, order_id).unwrap();
    let result = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: None,
            discount_value: None,
            received: Some(7_000),
        },
    )
    .unwrap();

    let (inv, _lines) = invoices::get_invoice_full(&conn, result.invoice_id)
        .unwrap()
        .unwrap();
    assert_eq!(inv.order_type, "TAKEAWAY");
    assert_eq!(inv.status, "PAID");
    assert!(
        inv.takeaway_no.is_some(),
        "takeaway orders must carry a takeaway number"
    );
    assert_eq!(inv.table_label, None, "takeaway never references a table");
}
