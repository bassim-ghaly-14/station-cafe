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
fn fixed_service_charge_options_and_authorized_discounts() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let developer = login(&conn, "admin", "admin123");
    let staff = login(&conn, "cashier", "cashier123");

    settings::set_service_charge(
        &conn,
        &manager,
        &settings::ServiceChargeConfig {
            amounts: vec![1_000, 3_000, 5_000, 7_000, 10_000],
        },
    )
    .unwrap();
    assert_eq!(
        settings::get_service_charge(&conn).unwrap().amounts.len(),
        5
    );
    assert!(settings::set_service_charge(
        &conn,
        &manager,
        &settings::ServiceChargeConfig {
            amounts: vec![1_000, 1_000],
        }
    )
    .is_err());
    assert!(settings::set_service_charge(
        &conn,
        &manager,
        &settings::ServiceChargeConfig { amounts: vec![0] }
    )
    .is_err());

    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    let table = pos::list_tables(&conn, None).unwrap().remove(0);
    pos_svc::open_table(&conn, &staff, table.id).unwrap();
    let order_id = pos_svc::start_order(&conn, &staff, table.id).unwrap();
    pos_svc::add_line(
        &conn,
        &staff,
        order_id,
        cafe_product(&conn, "كرواسون رومي"),
        2,
    )
    .unwrap();

    let selected =
        pos_svc::preview(&conn, order_id, Some("PERCENT"), Some(20_000), Some(3_000)).unwrap();
    assert_eq!(selected.discount_minor, 2_960);
    assert_eq!(selected.service_charge_minor, 3_000);
    assert!(pos_svc::preview(&conn, order_id, Some("PERCENT"), Some(20_000), Some(2_500)).is_err());

    // The cashier's discount credential is configured by the ADMIN — per user,
    // never as a shared global password, and stored as a hash.
    auth::set_discount_authorization(&conn, &developer, staff.id, "approve123").unwrap();
    assert!(auth::discount_authorization_configured(&conn, staff.id).unwrap());
    let stored: String = conn
        .query_row(
            "SELECT discount_password_hash FROM users WHERE id = ?1",
            [staff.id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!stored.contains("approve123"));
    // The global discount password is gone for good.
    let global_left: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM app_settings WHERE key = 'discount_authorization_hash'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(global_left, 0);
    assert!(settings::authorize_discount(&conn, &staff, order_id, 2_960, Some("wrong123")).is_err());
    settings::authorize_discount(&conn, &staff, order_id, 2_960, Some("approve123")).unwrap();
    assert_eq!(
        pos_svc::validate_discount(&conn, 14_800, Some("PERCENT"), Some(20_000)).unwrap(),
        2_960
    );

    let paid = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: Some("PERCENT".into()),
            discount_value: Some(20_000),
            discount_password: Some("approve123".into()),
            service_charge_minor: Some(3_000),
            received: Some(15_000),
        },
    )
    .unwrap();
    let (invoice, _) = invoices::get_invoice_full(&conn, paid.invoice_id)
        .unwrap()
        .unwrap();
    assert_eq!(invoice.discount_minor, 2_960);
    assert_eq!(invoice.service_charge, 3_000);
    assert_eq!(invoice.total, 14_840);
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
    //
    // CROISSANT ROMI = 7400 × 2 = 14800
    // WATER          = 1000
    // WASH FULL SEDAN = 17500
    // Subtotal = 33300
    pos_svc::add_line(
        &conn,
        &staff,
        order_id,
        cafe_product(&conn, "كرواسون رومي"),
        2,
    )
    .unwrap();

    pos_svc::add_line(&conn, &staff, order_id, cafe_product(&conn, "مياه"), 1).unwrap();

    pos_svc::add_line(
        &conn,
        &staff,
        order_id,
        wash_service(&conn, "غسيل كامل سيدان"),
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
    assert_eq!(ticket.services, vec!["غسيل كامل سيدان"]);

    // ---- service charge configuration (fixed 20.00 EGP) --------------------
    settings::set_service_charge(
        &conn,
        &manager,
        &settings::ServiceChargeConfig {
            amounts: vec![2_000],
        },
    )
    .unwrap();

    // ---- discount 10% ------------------------------------------------------
    //
    // Subtotal = 33300
    // Discount = 3330
    // Service charge = 2000
    // Total = 31970
    settings::set_service_charge(
        &conn,
        &manager,
        &settings::ServiceChargeConfig {
            amounts: vec![2_000],
        },
    )
    .unwrap();
    let preview =
        pos_svc::preview(&conn, order_id, Some("PERCENT"), Some(10_000), Some(2_000)).unwrap();

    assert_eq!(preview.subtotal, 33_300);
    assert_eq!(preview.discount_minor, 3_330);
    assert_eq!(preview.service_charge_minor, 2_000);
    assert_eq!(preview.total, 31_970);

    pos_svc::mark_ready_to_pay(&conn, &staff, order_id).unwrap();

    let developer = login(&conn, "admin", "admin123");
    auth::set_discount_authorization(&conn, &developer, staff.id, "approve123").unwrap();
    // ---- pay CASH with change ---------------------------------------------
    let result = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: Some("PERCENT".into()),
            discount_value: Some(10_000),
            discount_password: Some("approve123".into()),
            service_charge_minor: Some(2_000),
            received: Some(32_000),
        },
    )
    .unwrap();

    assert_eq!(result.total, 31_970);
    assert_eq!(result.change_given, Some(30));
    assert_eq!(result.status, "PAID");

    // Invoice snapshot is complete and correct.
    let (inv, lines) = invoices::get_invoice_full(&conn, result.invoice_id)
        .unwrap()
        .unwrap();

    assert_eq!(inv.subtotal, 33_300);
    assert_eq!(inv.discount_minor, 3_330);
    assert_eq!(inv.service_charge, 2_000);
    assert_eq!(inv.total, 31_970);
    assert_eq!(inv.paid_amount, 31_970);

    // Cafe:
    // CROISSANT ROMI × 2 = 14800
    // WATER × 1 = 1000
    // Cafe total = 15800
    assert_eq!(inv.cafe_total, 15_800);

    // Wash:
    // غسيل كامل سيدان = 17500
    assert_eq!(inv.wash_total, 17_500);

    assert_eq!(inv.customer_name.as_deref(), Some("أحمد محمود"));

    assert_eq!(inv.car_plate.as_deref(), Some("ABC123"));

    assert_eq!(inv.order_type, "TABLE");
    assert_eq!(inv.takeaway_no, None);
    assert_eq!(lines.len(), 3);

    // Table is free again.
    let tables = pos::list_tables(&conn, None).unwrap();

    assert_eq!(
        tables.iter().find(|t| t.id == table.id).unwrap().status,
        "EMPTY"
    );

    // ---- a later price change must NOT move history -----------------------
    catalog::update_price(&conn, cafe_product(&conn, "كرواسون رومي"), 9_900).unwrap();

    let (inv_again, _) = invoices::get_invoice_full(&conn, result.invoice_id)
        .unwrap()
        .unwrap();

    assert_eq!(inv_again.total, 31_970, "invoice totals must be immutable");

    // ---- close shift: expected vs actual, explicit difference -------------
    //
    // Opening cash = 50000
    // Cash sale = 31970
    // Expected = 81970
    // Actual = 81920
    // Difference = -50
    let closing = shift_svc::close_shift(&conn, &staff, 81_920).unwrap();

    assert_eq!(closing.expected_cash, 81_970);
    assert_eq!(closing.difference, -50);

    assert!(
        shift_svc::close_shift(&conn, &staff, 1).is_err(),
        "double close must fail"
    );

    // ---- settlement checkpoint, then final business-day closure ----------
    let settlement = shift_svc::settle_day(&conn, &manager).unwrap();
    assert_eq!(settlement.shift_ids, vec![shift_id]);

    let totals = shift_svc::close_day(&conn, &manager).unwrap();

    assert_eq!(totals.invoices_count, 1);
    assert_eq!(totals.total_sales, 31_970);
    assert_eq!(totals.cash, 31_970);
    assert_eq!(totals.service_charges, 2_000);
    assert_eq!(totals.discounts, 3_330);

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
fn flexible_sequential_shifts_and_incremental_settlement_do_not_double_count() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let day_id = shifts::current_day(&conn).unwrap().unwrap().id;

    for expected in 1..=4 {
        shift_svc::open_shift(&conn, &staff, 0).unwrap();
        shift_svc::close_shift(&conn, &staff, 0).unwrap();
        assert_eq!(
            shifts::shifts_of_day(&conn, day_id).unwrap().len(),
            expected
        );
    }

    let first = shift_svc::preview_settlement(&conn, &manager).unwrap();
    assert_eq!(first.pending_shifts.len(), 4);
    let first = shift_svc::settle_day(&conn, &manager).unwrap();
    assert_eq!(first.shift_ids.len(), 4);
    assert!(shift_svc::preview_settlement(&conn, &manager)
        .unwrap()
        .pending_shifts
        .is_empty());
    assert!(
        shift_svc::settle_day(&conn, &manager).is_err(),
        "empty settlement is forbidden"
    );

    // A new sequential shift may open after the checkpoint; only it is pending.
    let fifth = shift_svc::open_shift(&conn, &staff, 0).unwrap();
    shift_svc::close_shift(&conn, &staff, 0).unwrap();
    let second = shift_svc::settle_day(&conn, &manager).unwrap();
    assert_eq!(second.shift_ids, vec![fifth]);
    assert!(!second.shift_ids.contains(&first.shift_ids[0]));
    let history = shift_svc::settlement_history(&conn, &manager).unwrap();
    assert_eq!(history.len(), 2);
    shift_svc::close_day(&conn, &manager).unwrap();
}

#[test]
fn shift_closing_and_settlement_reject_unsafe_states() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();

    // Only one global ACTIVE shift, even for a different cashier.
    let first = shift_svc::open_shift(&conn, &staff, 0).unwrap();
    assert!(shift_svc::open_shift(&conn, &manager, 0).is_err());
    assert!(shift_svc::settle_day(&conn, &manager).is_err());
    // A manager cannot close a shift they do not own.
    assert!(shift_svc::close_shift(&conn, &manager, 0).is_err());

    shift_svc::close_shift(&conn, &staff, 0).unwrap();
    assert!(
        shift_svc::close_shift(&conn, &staff, 0).is_err(),
        "double close is forbidden"
    );
    assert_eq!(
        shifts::get_shift(&conn, first).unwrap().unwrap().status,
        "CLOSED"
    );
}

#[test]
fn one_shift_business_day_can_be_settled_then_final_closed() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 100).unwrap();
    shift_svc::close_shift(&conn, &staff, 100).unwrap();
    let closing = shift_svc::settle_day(&conn, &manager).unwrap();
    assert_eq!(closing.shift_ids.len(), 1);
    shift_svc::close_day(&conn, &manager).unwrap();
    assert!(shifts::current_day(&conn).unwrap().is_none());
}

#[test]
fn active_shift_and_business_day_survive_restart_after_midnight() {
    let dir = std::env::temp_dir().join(format!("station-midnight-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(crate::db::DB_FILE);
    let (day_id, shift_id, staff_id) = {
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();
        let manager = login(&conn, "manager", "manager123");
        let staff = login(&conn, "cashier", "cashier123");
        shift_svc::open_day(&conn, &manager).unwrap();
        let day = shifts::current_day(&conn).unwrap().unwrap();
        let shift = shift_svc::open_shift(&conn, &staff, 10_000).unwrap();
        conn.execute(
            "UPDATE shifts SET opened_at = '2026-09-24 23:59:00' WHERE id = ?1",
            [shift],
        )
        .unwrap();
        (day.id, shift, staff.id)
    };

    // Fresh process-equivalent connection at 00:30: no calendar lookup occurs.
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    let staff = auth::User {
        id: staff_id,
        name: "cashier".into(),
        phone: None,
        role: "STAFF".into(),
        status: "ACTIVE".into(),
        created_at: String::new(),
        updated_at: String::new(),
    };
    let day = shifts::current_day(&conn).unwrap().unwrap();
    let shift = shifts::active_shift_for(&conn, staff.id).unwrap().unwrap();
    assert_eq!(day.id, day_id);
    assert_eq!(shift.business_day_id, day_id);
    assert_eq!(shift.id, shift_id);
    assert_eq!(shift.opened_at, "2026-09-24 23:59:00");

    let closed = shift_svc::close_shift_at(&conn, &staff, 10_000, "2026-09-25 00:30:00").unwrap();
    assert_eq!(closed.shift.business_day_id, day_id);
    assert_eq!(
        closed.shift.closed_at.as_deref(),
        Some("2026-09-25 00:30:00")
    );
    assert_eq!(shifts::current_day(&conn).unwrap().unwrap().id, day_id);
    drop(conn);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn shift_opening_reuses_open_business_day() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let day_id = shift_svc::open_day(&conn, &manager).unwrap();
    let before: i64 = conn
        .query_row("SELECT COUNT(*) FROM business_days", [], |r| r.get(0))
        .unwrap();

    shift_svc::open_shift(&conn, &staff, 0).unwrap();

    let after: i64 = conn
        .query_row("SELECT COUNT(*) FROM business_days", [], |r| r.get(0))
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        shifts::active_shift_for(&conn, staff.id)
            .unwrap()
            .unwrap()
            .business_day_id,
        day_id
    );
}

#[test]
fn shift_opening_implicitly_opens_a_day_after_close() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    shift_svc::close_shift(&conn, &staff, 0).unwrap();
    shift_svc::close_day(&conn, &manager).unwrap();
    assert!(shifts::current_day(&conn).unwrap().is_none());

    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    let shift = shifts::active_shift_for(&conn, staff.id).unwrap().unwrap();
    assert!(shifts::current_day(&conn).unwrap().is_some());
    assert_eq!(
        shift.business_day_id,
        shifts::current_day(&conn).unwrap().unwrap().id
    );
}

#[test]
fn shift_opening_preserves_duplicate_shift_protection() {
    let conn = fresh();
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    assert!(shift_svc::open_shift(&conn, &staff, 0).is_err());
}

#[test]
fn failed_business_day_creation_does_not_create_shift() {
    let conn = fresh();
    let staff = login(&conn, "cashier", "cashier123");
    conn.execute_batch("CREATE TRIGGER fail_business_day BEFORE INSERT ON business_days BEGIN SELECT RAISE(ABORT, 'day creation failed'); END;").unwrap();
    let err = shift_svc::open_shift(&conn, &staff, 0).unwrap_err();
    assert_eq!(err.kind(), crate::error::ErrorKind::BusinessRule);
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM shifts", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
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

    // ESPRESSO = 52.00 EGP × 2 = 104.00 EGP.
    pos_svc::add_line(&conn, &manager, order_id, cafe_product(&conn, "إسبريسو"), 2).unwrap();

    pos_svc::attach_customer(&conn, order_id, customer_id, None).unwrap();

    pos_svc::mark_ready_to_pay(&conn, &manager, order_id).unwrap();

    let credit_input = checkout::CheckoutInput {
        order_id,
        method: "CREDIT".into(),
        discount_mode: None,
        discount_value: None,
        discount_password: None,
        service_charge_minor: None,
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
            enabled: true,
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

    assert_eq!(acct.1, 10_400);
    assert_eq!(acct.2, 0);

    // Partial settlement → PARTIALLY_PAID, then full → PAID.
    assert_eq!(
        checkout::settle_credit(&conn, &manager, customer_id, 2_000).unwrap(),
        "PARTIALLY_PAID"
    );

    assert_eq!(
        checkout::settle_credit(&conn, &manager, customer_id, 8_400).unwrap(),
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

    // A takeaway starts as its own first-class order.
    let order_id = pos_svc::start_takeaway(&conn, &staff).unwrap();

    // CROISSANT ROMI = 7400 × 2 = 14800.
    pos_svc::add_line(
        &conn,
        &staff,
        order_id,
        cafe_product(&conn, "كرواسون رومي"),
        2,
    )
    .unwrap();

    pos_svc::mark_ready_to_pay(&conn, &staff, order_id).unwrap();

    let result = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: None,
            discount_value: None,
            discount_password: None,
            service_charge_minor: None,
            received: Some(14_800),
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
            discount_password: None,
            service_charge_minor: None,
            received: Some(14_800),
        },
    )
    .unwrap_err();

    assert_eq!(empty.kind(), crate::error::ErrorKind::BusinessRule);

    pos_svc::discard_order(&conn, &staff, empty_id).unwrap();

    // ---- table order: OPEN → checkout directly ----------------------------
    let table = pos::list_tables(&conn, None).unwrap().remove(0);
    let label = table.label.clone();

    pos_svc::open_table(&conn, &staff, table.id).unwrap();

    let order_id = pos_svc::start_order(&conn, &staff, table.id).unwrap();

    // CROISSANT ROMI × 2 = 14800.
    pos_svc::add_line(
        &conn,
        &staff,
        order_id,
        cafe_product(&conn, "كرواسون رومي"),
        2,
    )
    .unwrap();

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
            discount_password: None,
            service_charge_minor: None,
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
            discount_password: None,
            service_charge_minor: None,
            received: Some(14_000),
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
            discount_password: None,
            service_charge_minor: None,
            received: Some(14_800),
        },
    )
    .unwrap();

    assert_eq!(paid.total, 14_800);

    // Successful payment closes the order and frees the table.
    let settled = pos_svc::get_order(&conn, order_id).unwrap();

    assert_eq!(settled.status, "CLOSED");

    assert!(pos::active_order_on_table(&conn, table.id)
        .unwrap()
        .is_none());

    // An already-paid order can never be paid again.
    let again = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: None,
            discount_value: None,
            discount_password: None,
            service_charge_minor: None,
            received: Some(14_800),
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

    // CROISSANT ROMI × 2 = 14800.
    pos_svc::add_line(&conn, &staff, a, cafe_product(&conn, "كرواسون رومي"), 2).unwrap();

    // 3-5. They remain open and discoverable.
    let open = pos_svc::list_open_takeaways(&conn, &staff).unwrap();

    assert_eq!(open.len(), 2, "multiple open takeaways must coexist");

    // Ownership stays backend-authoritative.
    assert!(
        pos_svc::list_open_takeaways(&conn, &manager)
            .unwrap()
            .is_empty(),
        "open takeaways are owner-scoped"
    );

    // 6-7. Reopening yields the FULL persisted order.
    let reopened = pos_svc::get_order(&conn, a).unwrap();

    assert_eq!(reopened.order_type, "TAKEAWAY");

    assert_eq!(reopened.table_id, None);

    assert_eq!(reopened.table_label, None, "takeaway never shows a table");

    assert_eq!(reopened.lines.len(), 1);

    assert_eq!(reopened.lines[0].quantity, 2);

    assert_eq!(reopened.lines[0].line_total, 14_800);

    let view = open.iter().find(|t| t.id == a).expect("takeaway a listed");

    assert_eq!(view.items_count, 1);

    assert_eq!(view.total_minor, 14_800);

    // 8-9. Continue editing, then review + pay directly.
    pos_svc::add_line(&conn, &staff, a, cafe_product(&conn, "مياه"), 1).unwrap();

    checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id: a,
            method: "CASH".into(),
            discount_mode: None,
            discount_value: None,
            discount_password: None,
            service_charge_minor: None,
            received: Some(15_800),
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

/// Discount persistence regression: apply → persist → reload → same discount
/// → payment carries it to the final invoice.
#[test]
fn discount_survives_reload_and_reaches_invoice() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();

    let order_id = pos_svc::start_takeaway(&conn, &staff).unwrap();
    pos_svc::add_line(
        &conn,
        &staff,
        order_id,
        cafe_product(&conn, "كرواسون رومي"),
        2,
    )
    .unwrap();

    let developer = login(&conn, "admin", "admin123");
    auth::set_discount_authorization(&conn, &developer, staff.id, "approve123").unwrap();
    settings::set_service_charge(
        &conn,
        &manager,
        &settings::ServiceChargeConfig {
            amounts: vec![2_000],
        },
    )
    .unwrap();
    settings::set_discount_options(
        &conn,
        &developer,
        &settings::DiscountOptionsConfig {
            amounts: vec![2_000],
        },
    )
    .unwrap();
    // Persist an authorized fixed discount on the order row itself.
    let saved = pos_svc::set_discount(
        &conn,
        &staff,
        order_id,
        Some("FIXED"),
        Some(2_000),
        Some("approve123"),
    )
    .unwrap();
    assert_eq!(saved.discount_mode.as_deref(), Some("FIXED"));
    assert_eq!(saved.discount_value, Some(2_000));

    // Refresh / reopen reads the SAME row — discount must still exist.
    let reloaded = pos_svc::get_order(&conn, order_id).unwrap();
    assert_eq!(reloaded.discount_mode.as_deref(), Some("FIXED"));
    assert_eq!(reloaded.discount_value, Some(2_000));

    let preview = pos_svc::preview(
        &conn,
        order_id,
        reloaded.discount_mode.as_deref(),
        reloaded.discount_value,
        Some(2_000),
    )
    .unwrap();
    assert_eq!(preview.discount_minor, 2_000);

    let paid = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CARD".into(),
            discount_mode: reloaded.discount_mode.clone(),
            discount_value: reloaded.discount_value,
            discount_password: None,
            service_charge_minor: Some(2_000),
            received: None,
        },
    )
    .unwrap();
    // 2 × 74.00 = 148.00, − 20.00 discount, + 20.00 service charge.
    assert_eq!(paid.total, 14_800);

    let (inv, _) = invoices::get_invoice_full(&conn, paid.invoice_id)
        .unwrap()
        .unwrap();
    assert_eq!(inv.discount_minor, 2_000);
    assert_eq!(inv.total, 14_800);
}

#[test]
fn table_count_controls_active_sequence_and_reuses_ids() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let original: Vec<(i64, String)> = pos::list_tables(&conn, None)
        .unwrap()
        .into_iter()
        .map(|table| (table.id, table.label))
        .collect();

    pos_svc::set_table_count(&conn, &manager, 13).unwrap();
    let thirteen = pos::list_tables(&conn, None).unwrap();
    assert_eq!(thirteen.len(), 13);
    assert_eq!(thirteen[12].label, "طاولة 13");

    pos_svc::set_table_count(&conn, &manager, 10).unwrap();
    let ten = pos::list_tables(&conn, None).unwrap();
    assert_eq!(ten.len(), 10);
    assert_eq!(ten[9].label, "طاولة 10");

    pos_svc::set_table_count(&conn, &manager, 12).unwrap();
    let twelve = pos::list_tables(&conn, None).unwrap();
    assert_eq!(
        twelve.iter().map(|table| table.id).collect::<Vec<_>>(),
        original.iter().map(|table| table.0).collect::<Vec<_>>()
    );

    pos_svc::set_table_count(&conn, &manager, 15).unwrap();
    let fifteen = pos::list_tables(&conn, None).unwrap();
    assert_eq!(fifteen.len(), 15);
    assert_eq!(fifteen[12].label, "طاولة 13");
    assert_eq!(fifteen[14].label, "طاولة 15");
    assert_eq!(
        fifteen[12].id, thirteen[12].id,
        "existing table 13 is reused, not duplicated"
    );
    assert!(pos_svc::set_table_count(&conn, &manager, 0).is_err());
    assert!(pos_svc::set_table_count(&conn, &manager, 100).is_err());
}

#[test]
fn table_count_reduction_rejects_open_session_atomically() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &manager, 0).unwrap();
    let twelfth = pos::list_tables(&conn, None).unwrap().remove(11);
    pos_svc::open_table(&conn, &manager, twelfth.id).unwrap();

    assert!(pos_svc::set_table_count(&conn, &manager, 10).is_err());
    let active: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cafe_tables WHERE is_active = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(active, 12, "no table may be disabled before rejection");
}

#[test]
fn table_count_reduction_rejects_open_and_ready_orders() {
    for ready in [false, true] {
        let conn = fresh();
        let manager = login(&conn, "manager", "manager123");
        shift_svc::open_day(&conn, &manager).unwrap();
        shift_svc::open_shift(&conn, &manager, 0).unwrap();
        let twelfth = pos::list_tables(&conn, None).unwrap().remove(11);
        pos_svc::open_table(&conn, &manager, twelfth.id).unwrap();
        let order_id = pos_svc::start_order(&conn, &manager, twelfth.id).unwrap();
        pos_svc::add_line(
            &conn,
            &manager,
            order_id,
            cafe_product(&conn, "كرواسون رومي"),
            1,
        )
        .unwrap();
        if ready {
            pos_svc::mark_ready_to_pay(&conn, &manager, order_id).unwrap();
        }

        assert!(pos_svc::set_table_count(&conn, &manager, 10).is_err());
        assert_eq!(pos::list_tables(&conn, None).unwrap().len(), 12);
    }
}

#[test]
fn table_count_deactivation_preserves_historical_order_references() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &manager, 0).unwrap();
    let twelfth = pos::list_tables(&conn, None).unwrap().remove(11);
    pos_svc::open_table(&conn, &manager, twelfth.id).unwrap();
    let order_id = pos_svc::start_order(&conn, &manager, twelfth.id).unwrap();
    pos_svc::add_line(
        &conn,
        &manager,
        order_id,
        cafe_product(&conn, "كرواسون رومي"),
        1,
    )
    .unwrap();
    checkout::checkout(
        &conn,
        &manager,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: None,
            discount_value: None,
            discount_password: None,
            service_charge_minor: None,
            received: Some(7_400),
        },
    )
    .unwrap();

    pos_svc::set_table_count(&conn, &manager, 10).unwrap();
    let historical = pos_svc::get_order(&conn, order_id).unwrap();
    assert_eq!(historical.table_id, Some(twelfth.id));
    assert_eq!(historical.table_label.as_deref(), Some("طاولة 12"));
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cafe_tables WHERE id = ?1",
            [twelfth.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(exists, 1);
}

// ---------------------------------------------------------------------------
// Shift / day closing synchronization and historical-report contracts.
//
// These cover the defects that made the POS closing cards show frozen numbers
// and the historical day-closing preview fail:
//   * an ACTIVE shift must be served as a LIVE aggregate view, so the card and
//     the closing dialog can never disagree;
//   * a CLOSED shift must keep the snapshot persisted at close time;
//   * a closed business day must be addressable by its own id from the reports
//     list, and its report must be reproducible from the stored snapshot.
use crate::services::reports;

/// One cash sale of a seeded cafe product, booked against the active shift.
fn sell_cafe_cash(conn: &Connection, actor: &auth::User, product: &str) -> i64 {
    let table = pos::list_tables(conn, None).unwrap().remove(0);
    pos_svc::open_table(conn, actor, table.id).unwrap();
    let order_id = pos_svc::start_order(conn, actor, table.id).unwrap();
    pos_svc::add_line(conn, actor, order_id, cafe_product(conn, product), 1).unwrap();
    let result = checkout::checkout(
        conn,
        actor,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: None,
            discount_value: None,
            discount_password: None,
            service_charge_minor: None,
            // Tender far above the line total: a shift's cash sales are the
            // invoiced amounts, not the change handed back.
            received: Some(1_000_000),
        },
    )
    .unwrap();
    // Settling the invoice releases the table again.
    result.invoice_id
}

fn invoice_total(conn: &Connection, invoice_id: i64) -> i64 {
    invoices::get_invoice_full(conn, invoice_id)
        .unwrap()
        .unwrap()
        .0
        .total
}

#[test]
fn closed_shift_snapshot_is_never_recomputed() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 0).unwrap();
    sell_cafe_cash(&conn, &staff, "كرواسون رومي");
    shift_svc::close_shift(&conn, &staff, 0).unwrap();

    // A frozen copy of the persisted closing snapshot.
    let frozen = shifts::get_shift(&conn, shift_id).unwrap().unwrap();
    assert_eq!(frozen.status, "CLOSED");
    assert!(frozen.cash_sales > 0);

    // Reading the report twice must keep returning the immutable snapshot.
    let first = reports::shift_report(&conn, shift_id).unwrap();
    let second = reports::shift_report(&conn, shift_id).unwrap();
    assert_eq!(first.cash_sales, frozen.cash_sales);
    assert_eq!(first.expected_cash, frozen.expected_cash);
    assert_eq!(first.actual_cash, frozen.actual_cash);
    assert_eq!(second.cash_sales, frozen.cash_sales);
    assert_eq!(second.expected_cash, frozen.expected_cash);

    // Hydration is a no-op for a closed shift: the stored row is untouched.
    let mut reread = shifts::get_shift(&conn, shift_id).unwrap().unwrap();
    shifts::hydrate_active_totals(&conn, &mut reread).unwrap();
    assert_eq!(reread.cash_sales, frozen.cash_sales);
    assert_eq!(reread.expected_cash, frozen.expected_cash);
    assert_eq!(reread.invoices_count, frozen.invoices_count);
}

#[test]
fn a_closed_shift_is_no_longer_treated_as_active() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    sell_cafe_cash(&conn, &staff, "كرواسون رومي");
    shift_svc::close_shift(&conn, &staff, 0).unwrap();

    let state = shift_svc::state(&conn, &staff).unwrap();
    assert!(
        state.my_shift.is_none(),
        "a closed shift is not an active shift"
    );
    assert!(!state.any_active_shift);
    assert!(shift_svc::preview_shift_close(&conn, &staff).is_err());
}

#[test]
fn active_shift_state_reports_live_totals_after_every_completed_sale() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 10_000).unwrap();

    // A freshly opened shift has no closing snapshot yet: the stored aggregate
    // columns are still their defaults, which is exactly why reading the raw row
    // made the POS card permanently show zero.
    let raw = shifts::get_shift(&conn, shift_id).unwrap().unwrap();
    assert_eq!(raw.cash_sales, 0, "no snapshot is written before closing");
    assert_eq!(raw.invoices_count, 0);

    let before = shift_svc::state(&conn, &staff).unwrap().my_shift.unwrap();
    assert_eq!(before.cash_sales, 0);
    assert_eq!(before.invoices_count, 0);
    assert_eq!(before.expected_cash, 10_000, "opening float only");

    // ---- complete a sale ---------------------------------------------------
    let total = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "كرواسون رومي"));

    // The card is refreshed from `day_shift_state` after a sale; it must now
    // carry the real figures without opening any dialog.
    let after = shift_svc::state(&conn, &staff).unwrap().my_shift.unwrap();
    assert_eq!(after.cash_sales, total);
    assert_eq!(after.card_sales, 0);
    assert_eq!(after.invoices_count, 1);
    assert_eq!(after.expected_cash, 10_000 + total);

    // ---- a second sale stacks onto the same live view -----------------------
    let second_total = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    let after_two = shift_svc::state(&conn, &staff).unwrap().my_shift.unwrap();
    assert_eq!(after_two.invoices_count, 2);
    assert_eq!(after_two.cash_sales, total + second_total);
    assert_eq!(after_two.expected_cash, 10_000 + total + second_total);
}

#[test]
fn shift_closing_dialog_and_card_always_agree() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 5_000).unwrap();
    sell_cafe_cash(&conn, &staff, "كرواسون رومي");

    let card = shift_svc::state(&conn, &staff).unwrap().my_shift.unwrap();
    let preview = shift_svc::preview_shift_close(&conn, &staff).unwrap();

    assert_eq!(preview.cash_sales, card.cash_sales);
    assert_eq!(preview.card_sales, card.card_sales);
    assert_eq!(preview.credit_sales, card.credit_sales);
    assert_eq!(preview.invoices_count, card.invoices_count);
    assert_eq!(preview.expected_cash, card.expected_cash);
    assert_eq!(preview.shift.expected_cash, card.expected_cash);
}

#[test]
fn closing_persists_the_same_numbers_the_live_view_reported() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 1_000).unwrap();
    sell_cafe_cash(&conn, &staff, "كرواسون رومي");

    let preview = shift_svc::preview_shift_close(&conn, &staff).unwrap();
    let expected = preview.expected_cash;
    let closing = shift_svc::close_shift(&conn, &staff, expected).unwrap();

    assert_eq!(closing.expected_cash, expected);
    assert_eq!(closing.difference, 0);
    assert_eq!(closing.shift.cash_sales, preview.cash_sales);
    assert_eq!(closing.shift.invoices_count, preview.invoices_count);
    assert_eq!(closing.shift.status, "CLOSED");
}

#[test]
fn closed_business_days_are_addressable_by_their_own_id_for_the_reports_list() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let day_id = shifts::current_day(&conn).unwrap().unwrap().id;
    let day_date: String = conn
        .query_row(
            "SELECT day_date FROM business_days WHERE id = ?1",
            [day_id],
            |r| r.get(0),
        )
        .unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    let total = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    shift_svc::close_shift(&conn, &staff, 0).unwrap();
    shift_svc::settle_day(&conn, &manager).unwrap();
    shift_svc::close_day(&conn, &manager).unwrap();

    let days = shifts::closed_business_days(&conn, None, None).unwrap();
    assert_eq!(days.len(), 1);
    let day = &days[0];

    // The identifier the reports list renders AND sends to the preview command
    // must exist on the row itself — this is what the nested payload lost.
    assert_eq!(day.business_day_id, day_id);
    assert_eq!(day.day_date, day_date);
    assert_eq!(day.status, "CLOSED");
    assert!(!day.opened_at.is_empty());
    assert!(!day.closed_at.is_empty());
    assert!(day.closing_id > 0);
    assert_eq!(day.closed_by, manager.id);
    assert_eq!(day.shift_count, 1);
    assert_eq!(day.totals.total_sales, total);
}

#[test]
fn a_historical_day_report_is_reproducible_from_the_stored_snapshot() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let day_id = shifts::current_day(&conn).unwrap().unwrap().id;
    shift_svc::open_shift(&conn, &staff, 2_000).unwrap();
    let total = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    shift_svc::close_shift(&conn, &staff, 2_000 + total).unwrap();
    shift_svc::settle_day(&conn, &manager).unwrap();
    shift_svc::close_day(&conn, &manager).unwrap();

    // The report a manager opens from "تقفيلات أيام العمل" is served from the
    // immutable final snapshot, and reading it twice yields the same document.
    let first = reports::day_report(&conn, day_id).unwrap();
    let second = reports::day_report(&conn, day_id).unwrap();
    assert_eq!(first.day.status, "CLOSED");
    assert_eq!(first.totals.total_sales, total);
    assert_eq!(second.totals.total_sales, total);
    assert_eq!(first.expected_drawer_cash, second.expected_drawer_cash);
    assert_eq!(first.shifts.len(), 1);
    assert_eq!(first.shifts[0].status, "CLOSED");
}

#[test]
fn an_unknown_day_reference_is_a_controlled_domain_error_not_a_crash() {
    let conn = fresh();
    let err = reports::day_report(&conn, 987_654).unwrap_err();
    assert_eq!(err.to_string(), "not found: day.not_found");

    let err = reports::shift_report(&conn, 987_654).unwrap_err();
    assert_eq!(err.to_string(), "not found: shift.not_found");

    // A closed day whose snapshot is missing is reported as a domain error too,
    // never as a generic internal failure.
    let manager = login(&conn, "manager", "manager123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let day_id = shifts::current_day(&conn).unwrap().unwrap().id;
    conn.execute(
        "UPDATE business_days SET status = 'CLOSED' WHERE id = ?1",
        [day_id],
    )
    .unwrap();
    let err = reports::day_report(&conn, day_id).unwrap_err();
    assert_eq!(err.to_string(), "not found: day.closing_not_found");
}
