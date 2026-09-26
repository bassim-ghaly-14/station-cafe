//! POS business rules that the POS page depends on:
//! cart identity (one line per product), customer / vehicle duplicate
//! prevention, the customer-less invoice, and the admin-configured discount
//! model (including what must stay readable from the previous model).
//!
//! Every rule is asserted through the SERVICE layer, exactly like production
//! traffic, so a passing test means the command path is protected too.

use crate::db::migrate;
use crate::repositories::{catalog, customers, invoices, pos};
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

/// Open a business day + a cashier shift, then a table with an empty order.
fn open_order(conn: &Connection, manager: &auth::User, staff: &auth::User) -> i64 {
    shift_svc::open_day(conn, manager).unwrap();
    shift_svc::open_shift(conn, staff, 0).unwrap();
    let table = pos::list_tables(conn, None).unwrap().remove(0);
    pos_svc::open_table(conn, staff, table.id).unwrap();
    pos_svc::start_order(conn, staff, table.id).unwrap()
}

fn pay_cash(
    conn: &Connection,
    staff: &auth::User,
    order_id: i64,
    discount_mode: Option<&str>,
    discount_value: Option<i64>,
) -> checkout::CheckoutResult {
    checkout::checkout(
        conn,
        staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: discount_mode.map(String::from),
            discount_value,
            // A discount already persisted on the order is settled without
            // asking for the password a second time.
            discount_pin: None,
            service_charge_minor: None,
            received: Some(1_000_000),
        },
    )
    .unwrap()
}

/// Configure THE one global shared discount PIN, exactly the way an ADMIN
/// does it from the settings screen.
fn configure_shared_pin(conn: &Connection, pin: &str) {
    let admin = login(conn, "admin", "admin123");
    settings::set_discount_authorization_pin(conn, &admin, pin).unwrap();
}

#[test]
fn adding_the_same_product_twice_increments_one_line() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let order_id = open_order(&conn, &manager, &staff);

    let tea = cafe_product(&conn, "شاي كلاسيك");
    pos_svc::add_line(&conn, &staff, order_id, tea, 1).unwrap();
    let after_second = pos_svc::add_line(&conn, &staff, order_id, tea, 1).unwrap();
    let after_third = pos_svc::add_line(&conn, &staff, order_id, tea, 1).unwrap();

    // ONE line that grows — never three identical rows.
    assert_eq!(after_second.lines.len(), 1);
    assert_eq!(after_third.lines.len(), 1);
    assert_eq!(after_third.lines[0].quantity, 3);
    assert_eq!(
        after_third.lines[0].line_total,
        after_third.lines[0].unit_price * 3
    );
}

#[test]
fn distinct_purchasable_items_stay_on_separate_lines() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let order_id = open_order(&conn, &manager, &staff);

    // The same drink in two sizes are two catalog items, hence two lines.
    let small = cafe_product(&conn, "قهوة تركي صغير");
    let double = cafe_product(&conn, "قهوة تركي دبل");
    pos_svc::add_line(&conn, &staff, order_id, small, 1).unwrap();
    let order = pos_svc::add_line(&conn, &staff, order_id, double, 1).unwrap();

    assert_eq!(order.lines.len(), 2);
    assert!(order.lines.iter().all(|line| line.quantity == 1));
}

#[test]
fn a_duplicate_phone_is_rejected_but_another_customer_is_allowed() {
    let conn = fresh();

    let first = customers::insert(&conn, "أحمد محمود", Some("01001234567"), None).unwrap();
    // Same identity written differently → no second customer.
    let err = customers::insert(&conn, "أحمد آخر", Some("٠١٠٠ ١٢٣ ٤٥٦٧"), None).unwrap_err();
    assert_eq!(err.to_string(), "conflict: customers.phone_taken");
    // A different number is fine, and identical names are legitimate.
    customers::insert(&conn, "أحمد محمود", Some("01111111111"), None).unwrap();

    // Editing a customer onto someone else's number is refused too.
    let other = customers::insert(&conn, "سعيد", Some("01222222222"), None).unwrap();
    let err = customers::update(&conn, other, "سعيد", Some("0100-123-4567"), None).unwrap_err();
    assert_eq!(err.to_string(), "conflict: customers.phone_taken");

    // Keeping your own number is not a duplicate.
    customers::update(&conn, first, "أحمد محمد", Some("01001234567"), None).unwrap();
    assert_eq!(
        customers::find_by_id(&conn, first).unwrap().unwrap().name,
        "أحمد محمد"
    );
}

#[test]
fn a_duplicate_plate_is_rejected_even_with_different_formatting() {
    let conn = fresh();
    let customer = customers::insert(&conn, "عميل", Some("01000000000"), None).unwrap();

    assert!(
        customers::insert_car(&conn, customer, "أ ب ج 1234", Some("تويوتا"), None)
            .unwrap()
            .is_some()
    );
    // Same plate, different spacing and Arabic digits → no second vehicle.
    assert!(
        customers::insert_car(&conn, customer, "أبج ١٢٣٤", None, None)
            .unwrap()
            .is_none()
    );
    // A genuinely different plate is a different vehicle.
    assert!(
        customers::insert_car(&conn, customer, "ب ج د 1234", None, None)
            .unwrap()
            .is_some()
    );
    // Attaching a car tolerates formatting differences.
    assert!(customers::find_car(&conn, "أ ب ج ١٢٣٤").unwrap().is_some());
    assert!(customers::find_car(&conn, "أبج 1234").unwrap().is_some());
}

#[test]
fn a_search_without_a_query_lists_the_registered_customers() {
    let conn = fresh();
    customers::insert(&conn, "منى", Some("01000000001"), None).unwrap();
    customers::insert(&conn, "وليد", Some("01000000002"), None).unwrap();
    let owner = customers::insert(&conn, "هالة", Some("01000000003"), None).unwrap();
    customers::insert_car(&conn, owner, "س ط 9876", None, None).unwrap();

    // Browsing needs no search: an empty query returns the list.
    let all = customers::search(&conn, "").unwrap();
    assert_eq!(all.len(), 3);
    assert_eq!(all[0].customer.name, "منى");

    // Search resolves by name, by phone, and by plate.
    assert_eq!(customers::search(&conn, "وليد").unwrap().len(), 1);
    assert_eq!(customers::search(&conn, "01000000002").unwrap().len(), 1);
    let by_plate = customers::search(&conn, "9876").unwrap();
    assert_eq!(by_plate.len(), 1);
    assert_eq!(by_plate[0].customer.name, "هالة");
    assert_eq!(customers::search(&conn, "لا يوجد").unwrap().len(), 0);
}

#[test]
fn an_invoice_without_a_customer_is_recorded_as_no_customer() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let order_id = open_order(&conn, &manager, &staff);

    pos_svc::add_line(&conn, &staff, order_id, cafe_product(&conn, "شاي كلاسيك"), 1).unwrap();
    let result = pay_cash(&conn, &staff, order_id, None, None);

    let (invoice, _) = invoices::get_invoice_full(&conn, result.invoice_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        invoice.customer_name.as_deref(),
        Some(checkout::NO_CUSTOMER_LABEL)
    );
    // The same label reaches the invoice list the cashier actually reads.
    let rows = invoices::search_invoices(&conn, None, None, None, None).unwrap();
    assert_eq!(
        rows[0].customer_name.as_deref(),
        Some(checkout::NO_CUSTOMER_LABEL)
    );
}

#[test]
fn discount_amount_is_open_ended_and_bounded_only_by_the_subtotal() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let developer = login(&conn, "admin", "admin123");
    let staff = login(&conn, "cashier", "cashier123");
    let order_id = open_order(&conn, &manager, &staff);
    configure_shared_pin(&conn, "4820");

    // The admin quick-pick list stays editable configuration — but it is a
    // SHORTCUT list, never a ceiling.
    settings::set_discount_options(
        &conn,
        &developer,
        &settings::DiscountOptionsConfig {
            amounts: vec![2_000, 5_000],
        },
    )
    .unwrap();

    pos_svc::add_line(
        &conn,
        &staff,
        order_id,
        cafe_product(&conn, "قهوة تركي دبل"),
        30,
    )
    .unwrap();
    // Derived from the authoritative preview, never hardcoded in the test.
    // The order is deliberately worth more than 1,000 EGP so the "1,000 EGP and
    // beyond" cases are real discounts, not out-of-range amounts.
    let subtotal = pos_svc::preview(&conn, order_id, None, None, None)
        .unwrap()
        .subtotal;
    assert!(subtotal >= 100_000);

    // 10 / 100 / 500 / 1000 EGP — and an amount nobody configured — are all
    // valid once the authorized user approves them: there is NO maximum.
    for amount in [1_000, 10_000, 50_000, 100_000, 777] {
        let saved = pos_svc::set_discount(
            &conn,
            &staff,
            order_id,
            Some("FIXED"),
            Some(amount),
            Some("4820"),
        )
        .unwrap();
        assert_eq!(saved.discount_value, Some(amount));
        let preview = pos_svc::preview(&conn, order_id, Some("FIXED"), Some(amount), None).unwrap();
        assert_eq!(preview.discount_minor, amount);
        assert_eq!(preview.total, subtotal - amount);
    }

    // Legitimate invoice constraints remain: a discount may not exceed what the
    // invoice actually holds, so a total can never go negative.
    let err = pos_svc::set_discount(
        &conn,
        &staff,
        order_id,
        Some("FIXED"),
        Some(subtotal + 1),
        Some("4820"),
    )
    .unwrap_err();
    assert_eq!(err.to_string(), "validation error: discount.invalid");

    // Zero and negative amounts are not discounts at all.
    assert!(pos_svc::set_discount(
        &conn,
        &staff,
        order_id,
        Some("FIXED"),
        Some(0),
        Some("4820"),
    )
    .is_err());
    assert!(pos_svc::set_discount(
        &conn,
        &staff,
        order_id,
        Some("FIXED"),
        Some(-500),
        Some("4820"),
    )
    .is_err());

    // The old percentage model can no longer be SELECTED.
    let err = pos_svc::set_discount(
        &conn,
        &staff,
        order_id,
        Some("PERCENT"),
        Some(10_000),
        Some("4820"),
    )
    .unwrap_err();
    assert_eq!(
        err.to_string(),
        "validation error: discount.percent_not_allowed"
    );
}

#[test]
fn an_applied_discount_is_persisted_and_survives_configuration_changes() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let developer = login(&conn, "admin", "admin123");
    let staff = login(&conn, "cashier", "cashier123");
    let order_id = open_order(&conn, &manager, &staff);
    configure_shared_pin(&conn, "4820");
    settings::set_discount_options(
        &conn,
        &developer,
        &settings::DiscountOptionsConfig {
            amounts: vec![5_000],
        },
    )
    .unwrap();

    pos_svc::add_line(
        &conn,
        &staff,
        order_id,
        cafe_product(&conn, "قهوة تركي دبل"),
        4,
    )
    .unwrap();
    pos_svc::set_discount(
        &conn,
        &staff,
        order_id,
        Some("FIXED"),
        Some(5_000),
        Some("4820"),
    )
    .unwrap();

    let result = pay_cash(&conn, &staff, order_id, Some("FIXED"), Some(5_000));
    let (invoice, _) = invoices::get_invoice_full(&conn, result.invoice_id)
        .unwrap()
        .unwrap();
    assert_eq!(invoice.discount_minor, 5_000);

    // The admin removes the option afterwards: history keeps the real amount.
    settings::set_discount_options(
        &conn,
        &developer,
        &settings::DiscountOptionsConfig { amounts: vec![] },
    )
    .unwrap();
    let (reloaded, _) = invoices::get_invoice_full(&conn, result.invoice_id)
        .unwrap()
        .unwrap();
    assert_eq!(reloaded.discount_minor, 5_000);
    assert_eq!(reloaded.total, invoice.total);
}

#[test]
fn a_wrong_shared_pin_does_not_apply_the_discount() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let order_id = open_order(&conn, &manager, &staff);
    configure_shared_pin(&conn, "4820");
    pos_svc::add_line(
        &conn,
        &staff,
        order_id,
        cafe_product(&conn, "قهوة تركي دبل"),
        4,
    )
    .unwrap();

    // A wrong PIN is refused by the authorization gate, and — because the
    // gate runs BEFORE the write, in the same transaction — nothing is
    // persisted on the order.
    let err = pos_svc::set_discount(
        &conn,
        &staff,
        order_id,
        Some("FIXED"),
        Some(5_000),
        Some("wrong-one"),
    )
    .unwrap_err();
    assert_eq!(err.to_string(), "unauthorized: discount.authorization_failed");
    assert!(pos_svc::get_order(&conn, order_id)
        .unwrap()
        .discount_value
        .is_none());

    // Clearing a discount needs no authorization at all.
    pos_svc::set_discount(
        &conn,
        &staff,
        order_id,
        Some("FIXED"),
        Some(5_000),
        Some("4820"),
    )
    .unwrap();
    pos_svc::set_discount(&conn, &staff, order_id, None, None, None).unwrap();
    assert!(pos_svc::get_order(&conn, order_id)
        .unwrap()
        .discount_value
        .is_none());
}

#[test]
fn the_discount_pin_is_one_global_shared_credential() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let order_id = open_order(&conn, &manager, &staff);
    pos_svc::add_line(
        &conn,
        &staff,
        order_id,
        cafe_product(&conn, "قهوة تركي دبل"),
        2,
    )
    .unwrap();

    // Before anyone is configured, nothing authorizes a discount — and the
    // error is identical to a wrong PIN, so the POS cannot probe for the
    // existence of a stored hash.
    for pin in [None, Some(""), Some("4820")] {
        let err = settings::authorize_discount(&conn, &staff, order_id, 500, pin).unwrap_err();
        assert_eq!(err.to_string(), "unauthorized: discount.authorization_failed");
    }

    // ONE global PIN, configured once and owned by nobody.
    settings::set_discount_authorization_pin(&conn, &manager, "4820").unwrap();

    // Cashier A authorizes with the shared PIN...
    settings::authorize_discount(&conn, &staff, order_id, 500, Some("4820")).unwrap();

    // ...and cashier B authorizes with the EXACT SAME shared PIN: no per-cashier
    // credential, no cross-cashier rejection.
    let second = crate::repositories::users::insert(
        &conn,
        &crate::repositories::users::NewUser {
            name: "second-cashier",
            phone: None,
            role: "STAFF",
            password_hash: &auth::hash_password("staff123").unwrap(),
            is_seed: false,
        },
    )
    .unwrap()
    .unwrap();
    let other_cashier = login(&conn, "second-cashier", "staff123");
    assert_eq!(other_cashier.id, second);
    settings::authorize_discount(&conn, &other_cashier, order_id, 500, Some("4820")).unwrap();

    // Identity is only for auditability: the audit event names the ACTING user,
    // the order and the amount — and never any credential material.
    let (actor, entity, details): (i64, String, String) = conn
        .query_row(
            "SELECT actor_id, entity_id, after_json
             FROM audit_log WHERE action = 'discount.authorized'
             ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(actor, second);
    assert_eq!(entity, order_id.to_string());
    assert!(details.contains("\"discount_minor\":500"));
    assert!(details.contains("AUTHORIZED"));
    assert!(!details.contains("4820"));
    assert!(!details.contains("argon2"));

    // A manager's / admin's / cashier's LOGIN password is not a discount
    // credential — it only works if it happens to equal the shared PIN.
    for login_password in ["manager123", "admin123", "cashier123"] {
        let err = settings::authorize_discount(&conn, &staff, order_id, 500, Some(login_password))
            .unwrap_err();
        assert_eq!(err.to_string(), "unauthorized: discount.authorization_failed");
    }

    // End to end: the cashier applies the discount on their own order with the
    // shared PIN.
    let saved = pos_svc::set_discount(
        &conn,
        &staff,
        order_id,
        Some("FIXED"),
        Some(500),
        Some("4820"),
    )
    .unwrap();
    assert_eq!(saved.discount_value, Some(500));
}

#[test]
fn the_shared_discount_pin_must_be_exactly_four_ascii_digits() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");

    // Valid: four digits, leading zeros included. The PIN is a STRING, so 0097
    // is never normalized into 97.
    for pin in ["1234", "0000", "0097", "4820"] {
        settings::set_discount_authorization_pin(&conn, &manager, pin).unwrap();
        settings::authorize_discount(&conn, &manager, 1, 500, Some(pin)).unwrap();
    }

    // Invalid: wrong length, letters, empty, whitespace, non-ASCII digits.
    for pin in ["123", "12345", "12a4", "abcd", "", " 1234", "1234 ", "٤٨٢٠"] {
        let err = settings::set_discount_authorization_pin(&conn, &manager, pin).unwrap_err();
        assert_eq!(
            err.to_string(),
            "validation error: discount.invalid_pin",
            "PIN {pin:?} must be rejected"
        );
    }

    // A malformed PIN is refused uniformly at the gate, exactly like a wrong
    // one — never as a different, probe-friendly error.
    for pin in ["123", "12345", "12a4", ""] {
        let err = settings::authorize_discount(&conn, &manager, 1, 500, Some(pin)).unwrap_err();
        assert_eq!(err.to_string(), "unauthorized: discount.authorization_failed");
    }
}


#[test]
fn a_manager_or_admin_configures_the_shared_pin_and_a_cashier_cannot() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let developer = login(&conn, "admin", "admin123");
    let staff = login(&conn, "cashier", "cashier123");

    assert!(!settings::get_discount_authorization(&conn).unwrap().configured);

    // A CASHIER may never configure the shared PIN.
    assert!(settings::set_discount_authorization_pin(&conn, &staff, "4820").is_err());
    assert!(!settings::get_discount_authorization(&conn).unwrap().configured);

    // MANAGER may configure it, exactly like the other business settings; ADMIN
    // may too. There is no target user: the PIN is cafe-wide.
    settings::set_discount_authorization_pin(&conn, &manager, "4820").unwrap();
    assert!(settings::get_discount_authorization(&conn).unwrap().configured);
    settings::set_discount_authorization_pin(&conn, &developer, "0097").unwrap();

    // Changing the PIN invalidates the previous one immediately, and the new one
    // works at once — for any cashier.
    settings::authorize_discount(&conn, &staff, 1, 500, Some("0097")).unwrap();
    let err = settings::authorize_discount(&conn, &staff, 1, 500, Some("4820")).unwrap_err();
    assert_eq!(err.to_string(), "unauthorized: discount.authorization_failed");

    // Exactly ONE global hash, stored with Argon2id and never as plaintext.
    let stored: String = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'discount_authorization_hash'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!stored.contains("0097"));
    assert!(!stored.contains("4820"));
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM app_settings WHERE key = 'discount_authorization_hash'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "there is exactly one shared discount credential");

    // No per-user credential column exists at all.
    let columns: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('users')
             WHERE name = 'discount_password_hash'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(columns, 0);

    // The audit trail records THAT the shared PIN changed — never its value.
    let logged: String = conn
        .query_row(
            "SELECT COALESCE(before_json, '') || COALESCE(after_json, '')
             FROM audit_log WHERE action = 'settings.discount_authorization_changed'
             ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!logged.contains("0097"));
    assert!(!logged.contains("4820"));
    assert!(logged.contains("configured"));
}

#[test]
fn a_client_cannot_smuggle_a_discount_past_authorization_at_checkout() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let order_id = open_order(&conn, &manager, &staff);
    configure_shared_pin(&conn, "4820");
    pos_svc::add_line(
        &conn,
        &staff,
        order_id,
        cafe_product(&conn, "قهوة تركي دبل"),
        2,
    )
    .unwrap();

    // A modified client calling checkout with a discount it never applied: the
    // backend still demands a verified authorization.
    let err = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: Some("FIXED".into()),
            discount_value: Some(5_000),
            discount_pin: None,
            service_charge_minor: None,
            received: Some(1_000_000),
        },
    )
    .unwrap_err();
    assert_eq!(err.to_string(), "unauthorized: discount.authorization_failed");

    // Authorization is tied to the amount: authorizing 5.00 does not authorize
    // a later, larger discount on the same order.
    pos_svc::set_discount(
        &conn,
        &staff,
        order_id,
        Some("FIXED"),
        Some(500),
        Some("4820"),
    )
    .unwrap();
    let err = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: Some("FIXED".into()),
            discount_value: Some(8_000),
            discount_pin: None,
            service_charge_minor: None,
            received: Some(1_000_000),
        },
    )
    .unwrap_err();
    assert_eq!(err.to_string(), "unauthorized: discount.authorization_failed");
    // The order still holds exactly the authorized amount.
    assert_eq!(
        pos_svc::get_order(&conn, order_id).unwrap().discount_value,
        Some(500)
    );

    // Paying the authorized amount settles normally.
    let result = pay_cash(&conn, &staff, order_id, Some("FIXED"), Some(500));
    let (invoice, _) = invoices::get_invoice_full(&conn, result.invoice_id)
        .unwrap()
        .unwrap();
    assert_eq!(invoice.discount_minor, 500);
}

#[test]
fn an_unconfigured_pin_blocks_discounts_but_service_charge_stays_free() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let order_id = open_order(&conn, &manager, &staff);
    pos_svc::add_line(
        &conn,
        &staff,
        order_id,
        cafe_product(&conn, "قهوة تركي دبل"),
        2,
    )
    .unwrap();
    settings::set_service_charge(
        &conn,
        &manager,
        &settings::ServiceChargeConfig {
            amounts: vec![2_000],
        },
    )
    .unwrap();

    // Discount → authorization required, and this cashier has none.
    assert!(pos_svc::set_discount(
        &conn,
        &staff,
        order_id,
        Some("FIXED"),
        Some(500),
        Some("4820"),
    )
    .is_err());

    // Service charge → no password, no authorization, exactly as before.
    let preview = pos_svc::preview(&conn, order_id, None, None, Some(2_000)).unwrap();
    assert_eq!(preview.service_charge_minor, 2_000);
    let result = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: None,
            discount_value: None,
            discount_pin: None,
            service_charge_minor: Some(2_000),
            received: Some(1_000_000),
        },
    )
    .unwrap();
    let (invoice, _) = invoices::get_invoice_full(&conn, result.invoice_id)
        .unwrap()
        .unwrap();
    assert_eq!(invoice.service_charge, 2_000);
    assert_eq!(invoice.discount_minor, 0);
}

#[test]
fn historical_percentage_discounts_stay_readable_and_payable() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let order_id = open_order(&conn, &manager, &staff);

    pos_svc::add_line(
        &conn,
        &staff,
        order_id,
        cafe_product(&conn, "قهوة تركي دبل"),
        1,
    )
    .unwrap();
    // Simulate a draft created under the previous model.
    pos::set_order_discount(&conn, order_id, Some("PERCENT"), Some(10_000)).unwrap();

    // Reading and settling it still resolve the stored value exactly.
    let preview = pos_svc::preview(&conn, order_id, Some("PERCENT"), Some(10_000), None).unwrap();
    assert_eq!(preview.discount_minor, 440);
    let result = pay_cash(&conn, &staff, order_id, Some("PERCENT"), Some(10_000));
    let (invoice, _) = invoices::get_invoice_full(&conn, result.invoice_id)
        .unwrap()
        .unwrap();
    assert_eq!(invoice.discount_minor, 440);
    assert_eq!(invoice.total, preview.total);
}
