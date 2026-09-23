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
fn discount_limits_are_enforced_backend_side() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    // Create a dedicated staffer for this test (seed has cashier/manager/admin).
    let hash = auth::hash_password("hassan2123").unwrap();
    crate::repositories::users::insert(
        &conn,
        &crate::repositories::users::NewUser {
            name: "hassan2",
            phone: None,
            role: "STAFF",
            password_hash: &hash,
            is_seed: false,
        },
    )
    .unwrap();
    let staff = login(&conn, "hassan2", "hassan2123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();

    let table = pos::list_tables(&conn, None).unwrap().remove(0);
    pos_svc::open_table(&conn, &staff, table.id).unwrap();
    let order_id = pos_svc::start_order(&conn, &staff, table.id).unwrap();
    pos_svc::add_line(&conn, &staff, order_id, cafe_product(&conn, "قهوة"), 2).unwrap(); // 6000
    let subtotal = 6_000;

    // zero discount always ok
    assert_eq!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, None, None).unwrap(),
        0
    );
    // valid percent + fixed within default (100%) limit
    assert_eq!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("PERCENT"), Some(10_000))
            .unwrap(),
        600
    );
    assert_eq!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("FIXED"), Some(1_000))
            .unwrap(),
        1_000
    );
    // negative / over-subtotal / over-100% rejected
    assert!(pos_svc::validate_discount_against_limit(&conn, subtotal, Some("FIXED"), Some(-5)).is_err());
    assert!(pos_svc::validate_discount_against_limit(&conn, subtotal, Some("FIXED"), Some(9_999)).is_err());
    assert!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("PERCENT"), Some(150_000))
            .is_err()
    );

    // Manager caps at 15% → staff 20% rejected, 10% allowed.
    settings::set_discount_limit(
        &conn,
        &manager,
        &settings::DiscountLimitConfig {
            mode: settings::DiscountLimitMode::Percent,
            value: 15_000,
        },
    )
    .unwrap();
    assert!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("PERCENT"), Some(20_000))
            .is_err()
    );
    assert!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("PERCENT"), Some(10_000)).is_ok()
    );
    // FIXED 1000 on 6000 subtotal = 16.7% effective → over the 15% (900) ceiling.
    assert!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("FIXED"), Some(1_000)).is_err()
    );
    assert!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("FIXED"), Some(500)).is_ok()
    );

    // Manager switches to FIXED 1000 cap → percent 10% (600) ok, 20% (1200) denied.
    settings::set_discount_limit(
        &conn,
        &manager,
        &settings::DiscountLimitConfig {
            mode: settings::DiscountLimitMode::Fixed,
            value: 1_000,
        },
    )
    .unwrap();
    assert!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("PERCENT"), Some(10_000)).is_ok()
    );
    assert!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("PERCENT"), Some(20_000)).is_err()
    );

    // NONE mode → any nonzero discount rejected.
    settings::set_discount_limit(
        &conn,
        &manager,
        &settings::DiscountLimitConfig {
            mode: settings::DiscountLimitMode::None,
            value: 0,
        },
    )
    .unwrap();
    assert!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("PERCENT"), Some(1_000))
            .is_err()
    );
    assert!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("FIXED"), Some(1)).is_err()
    );

    // STAFF cannot change the limit (service-layer role gate).
    let staff_limit = settings::DiscountLimitConfig {
        mode: settings::DiscountLimitMode::Percent,
        value: 100_000,
    };
    assert!(settings::set_discount_limit(&conn, &staff, &staff_limit).is_err());
    // Invalid limit values rejected even for managers.
    assert!(
        settings::set_discount_limit(
            &conn,
            &manager,
            &settings::DiscountLimitConfig {
                mode: settings::DiscountLimitMode::Percent,
                value: 200_000
            },
        )
        .is_err()
    );
    assert!(
        settings::set_discount_limit(
            &conn,
            &manager,
            &settings::DiscountLimitConfig {
                mode: settings::DiscountLimitMode::Fixed,
                value: -1
            },
        )
        .is_err()
    );

    // End-to-end: capped percent flows through preview → checkout → snapshot.
    settings::set_discount_limit(
        &conn,
        &manager,
        &settings::DiscountLimitConfig {
            mode: settings::DiscountLimitMode::Percent,
            value: 15_000,
        },
    )
    .unwrap();
    let ok = pos_svc::preview(&conn, order_id, Some("PERCENT"), Some(10_000)).unwrap();
    assert_eq!(ok.discount_minor, 600);
    assert!(pos_svc::preview(&conn, order_id, Some("PERCENT"), Some(20_000)).is_err());
    pos_svc::mark_ready_to_pay(&conn, &staff, order_id).unwrap();
    let denied = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: Some("PERCENT".into()),
            discount_value: Some(20_000),
            received: Some(6_000),
        },
    );
    assert!(denied.is_err(), "checkout must enforce the discount ceiling");
    let paid = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: Some("PERCENT".into()),
            discount_value: Some(10_000),
            received: Some(6_000),
        },
    )
    .unwrap();
    let (inv, _) = invoices::get_invoice_full(&conn, paid.invoice_id).unwrap().unwrap();
    assert_eq!(inv.discount_minor, 600);
    assert_eq!(inv.total, 5_400);
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

/// ISSUE 1 — an OPEN order goes straight to payment: no `mark_ready_to_pay`
/// ("payment request") step anywhere in the flow, while every backend
/// protection stays enforced.
#[test]
fn open_order_pays_directly_with_no_payment_request_step() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();

    // ---- empty order cannot be paid ---------------------------------------
    let empty_id = pos_svc::start_takeaway(&conn, &staff).unwrap();
    let empty = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id: empty_id,
            method: "CASH".into(),
            discount_mode: None,
            discount_value: None,
            received: Some(6_000),
        },
    )
    .unwrap_err();
    assert_eq!(empty.kind(), crate::error::ErrorKind::BusinessRule);
    pos_svc::discard_order(&conn, &staff, empty_id).unwrap();

    // ---- table order: OPEN → checkout directly (NO payment request) -------
    let table = pos::list_tables(&conn, None).unwrap().remove(0);
    let label = table.label.clone();
    pos_svc::open_table(&conn, &staff, table.id).unwrap();
    let order_id = pos_svc::start_order(&conn, &staff, table.id).unwrap();
    pos_svc::add_line(&conn, &staff, order_id, cafe_product(&conn, "قهوة"), 2).unwrap();

    // The order panel gets its table identity from the order row itself.
    let opened = pos_svc::get_order(&conn, order_id).unwrap();
    assert_eq!(opened.status, "OPEN");
    assert_eq!(opened.table_label.as_ref(), Some(&label));

    // Invalid method / insufficient cash validation untouched.
    let bad_method = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "BITCOIN".into(),
            discount_mode: None,
            discount_value: None,
            received: None,
        },
    )
    .unwrap_err();
    assert_eq!(bad_method.kind(), crate::error::ErrorKind::Validation);

    let short_cash = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: None,
            discount_value: None,
            received: Some(5_000), // total is 6_000
        },
    )
    .unwrap_err();
    assert_eq!(short_cash.kind(), crate::error::ErrorKind::BusinessRule);

    // Direct payment succeeds from OPEN.
    let paid = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: None,
            discount_value: None,
            received: Some(6_000),
        },
    )
    .unwrap();
    assert_eq!(paid.total, 6_000);

    // Successful payment closes the order and frees the table.
    let settled = pos_svc::get_order(&conn, order_id).unwrap();
    assert_eq!(settled.status, "CLOSED");
    assert!(pos::active_order_on_table(&conn, table.id).unwrap().is_none());

    // An already-paid order can never be paid again.
    let again = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: None,
            discount_value: None,
            received: Some(6_000),
        },
    )
    .unwrap_err();
    assert_eq!(again.kind(), crate::error::ErrorKind::BusinessRule);
}

/// ISSUE 4 — open takeaway orders persist in the backend, stay discoverable
/// and reopenable with all their data, coexist, and disappear once paid.
#[test]
fn open_takeaway_orders_stay_discoverable_until_paid() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();

    // 1-2. Start takeaways and add items.
    let a = pos_svc::start_takeaway(&conn, &staff).unwrap();
    let b = pos_svc::start_takeaway(&conn, &staff).unwrap();
    pos_svc::add_line(&conn, &staff, a, cafe_product(&conn, "قهوة"), 2).unwrap();

    // 3-5. They remain open and discoverable (multiple ones coexist)…
    let open = pos_svc::list_open_takeaways(&conn, &staff).unwrap();
    assert_eq!(open.len(), 2, "multiple open takeaways must coexist");

    // Ownership stays backend-authoritative: mirrors require_editable, so a
    // different user never sees (or could reopen) someone else's takeaway.
    assert!(
        pos_svc::list_open_takeaways(&conn, &manager).unwrap().is_empty(),
        "open takeaways are owner-scoped"
    );

    // 6-7. Reopening yields the FULL persisted order (type, lines, prices).
    let reopened = pos_svc::get_order(&conn, a).unwrap();
    assert_eq!(reopened.order_type, "TAKEAWAY");
    assert_eq!(reopened.table_id, None);
    assert_eq!(reopened.table_label, None, "takeaway never shows a table");
    assert_eq!(reopened.lines.len(), 1);
    assert_eq!(reopened.lines[0].quantity, 2);
    assert_eq!(reopened.lines[0].line_total, 6_000);
    let view = open.iter().find(|t| t.id == a).expect("takeaway a listed");
    assert_eq!(view.items_count, 1);
    assert_eq!(view.total_minor, 6_000);

    // 8-9. Continue editing, then review + pay directly (no request step).
    pos_svc::add_line(&conn, &staff, a, cafe_product(&conn, "مياه معدنية"), 1).unwrap();
    checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id: a,
            method: "CASH".into(),
            discount_mode: None,
            discount_value: None,
            received: Some(7_000), // 6_000 + 1_000
        },
    )
    .unwrap();

    // 10. The paid takeaway leaves the OPEN list; the other one remains.
    let after = pos_svc::list_open_takeaways(&conn, &staff).unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].id, b);
    assert_eq!(
        pos_svc::get_order(&conn, a).unwrap().status,
        "CLOSED",
        "paid takeaway is no longer open"
    );
}
