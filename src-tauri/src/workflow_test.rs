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

    // Create a dedicated staffer for this test.
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

    // CROISSANT ROMI = 74.00 EGP × 2 = 148.00 EGP.
    pos_svc::add_line(
        &conn,
        &staff,
        order_id,
        cafe_product(&conn, "CROISSANT ROMI"),
        2,
    )
    .unwrap();

    let subtotal = 14_800;

    // Zero discount always works.
    assert_eq!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, None, None).unwrap(),
        0
    );

    // Valid percent + fixed within default 100% limit.
    assert_eq!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("PERCENT"), Some(10_000))
            .unwrap(),
        1_480
    );

    assert_eq!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("FIXED"), Some(1_000))
            .unwrap(),
        1_000
    );

    // Negative / over-subtotal / over-100% rejected.
    assert!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("FIXED"), Some(-5)).is_err()
    );

    assert!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("FIXED"), Some(14_801))
            .is_err()
    );

    assert!(pos_svc::validate_discount_against_limit(
        &conn,
        subtotal,
        Some("PERCENT"),
        Some(150_000)
    )
    .is_err());

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

    assert!(pos_svc::validate_discount_against_limit(
        &conn,
        subtotal,
        Some("PERCENT"),
        Some(20_000)
    )
    .is_err());

    assert!(pos_svc::validate_discount_against_limit(
        &conn,
        subtotal,
        Some("PERCENT"),
        Some(10_000)
    )
    .is_ok());

    // Fixed 1000 on 14800 subtotal = 6.76% → within 15% ceiling.
    assert!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("FIXED"), Some(1_000))
            .is_ok()
    );

    // Fixed 3000 on 14800 subtotal = 20.27% → over 15% ceiling.
    assert!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("FIXED"), Some(3_000))
            .is_err()
    );

    // Manager switches to FIXED 1000 cap.
    settings::set_discount_limit(
        &conn,
        &manager,
        &settings::DiscountLimitConfig {
            mode: settings::DiscountLimitMode::Fixed,
            value: 1_000,
        },
    )
    .unwrap();

    assert!(pos_svc::validate_discount_against_limit(
        &conn,
        subtotal,
        Some("PERCENT"),
        Some(5_000)
    )
    .is_ok());

    assert!(pos_svc::validate_discount_against_limit(
        &conn,
        subtotal,
        Some("PERCENT"),
        Some(10_000)
    )
    .is_err());

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

    assert!(pos_svc::validate_discount_against_limit(
        &conn,
        subtotal,
        Some("PERCENT"),
        Some(1_000)
    )
    .is_err());

    assert!(
        pos_svc::validate_discount_against_limit(&conn, subtotal, Some("FIXED"), Some(1)).is_err()
    );

    // STAFF cannot change the limit.
    let staff_limit = settings::DiscountLimitConfig {
        mode: settings::DiscountLimitMode::Percent,
        value: 100_000,
    };

    assert!(settings::set_discount_limit(&conn, &staff, &staff_limit).is_err());

    // Invalid limit values rejected even for managers.
    assert!(settings::set_discount_limit(
        &conn,
        &manager,
        &settings::DiscountLimitConfig {
            mode: settings::DiscountLimitMode::Percent,
            value: 200_000,
        },
    )
    .is_err());

    assert!(settings::set_discount_limit(
        &conn,
        &manager,
        &settings::DiscountLimitConfig {
            mode: settings::DiscountLimitMode::Fixed,
            value: -1,
        },
    )
    .is_err());

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

    assert_eq!(ok.discount_minor, 1_480);
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
            received: Some(14_800),
        },
    );

    assert!(
        denied.is_err(),
        "checkout must enforce the discount ceiling"
    );

    let paid = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: Some("PERCENT".into()),
            discount_value: Some(10_000),
            received: Some(14_800),
        },
    )
    .unwrap();

    let (inv, _) = invoices::get_invoice_full(&conn, paid.invoice_id)
        .unwrap()
        .unwrap();

    assert_eq!(inv.discount_minor, 1_480);
    assert_eq!(inv.total, 13_320);
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
        cafe_product(&conn, "CROISSANT ROMI"),
        2,
    )
    .unwrap();

    pos_svc::add_line(&conn, &staff, order_id, cafe_product(&conn, "WATER"), 1).unwrap();

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
            mode: settings::ServiceChargeMode::Fixed,
            value: 2_000,
        },
    )
    .unwrap();

    // ---- discount 10% ------------------------------------------------------
    //
    // Subtotal = 33300
    // Discount = 3330
    // Service charge = 2000
    // Total = 31970
    let preview = pos_svc::preview(&conn, order_id, Some("PERCENT"), Some(10_000)).unwrap();

    assert_eq!(preview.subtotal, 33_300);
    assert_eq!(preview.discount_minor, 3_330);
    assert_eq!(preview.service_charge_minor, 2_000);
    assert_eq!(preview.total, 31_970);

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
    catalog::update_price(&conn, cafe_product(&conn, "CROISSANT ROMI"), 9_900).unwrap();

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
    pos_svc::add_line(
        &conn,
        &manager,
        order_id,
        cafe_product(&conn, "ESPRESSO"),
        2,
    )
    .unwrap();

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
        cafe_product(&conn, "CROISSANT ROMI"),
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
        cafe_product(&conn, "CROISSANT ROMI"),
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
    pos_svc::add_line(&conn, &staff, a, cafe_product(&conn, "CROISSANT ROMI"), 2).unwrap();

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
    pos_svc::add_line(&conn, &staff, a, cafe_product(&conn, "WATER"), 1).unwrap();

    checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id: a,
            method: "CASH".into(),
            discount_mode: None,
            discount_value: None,
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
        cafe_product(&conn, "CROISSANT ROMI"),
        2,
    )
    .unwrap();

    // Persist a 10% discount on the order row itself.
    let saved =
        pos_svc::set_discount(&conn, &staff, order_id, Some("PERCENT"), Some(10_000)).unwrap();
    assert_eq!(saved.discount_mode.as_deref(), Some("PERCENT"));
    assert_eq!(saved.discount_value, Some(10_000));

    // Refresh / reopen reads the SAME row — discount must still exist.
    let reloaded = pos_svc::get_order(&conn, order_id).unwrap();
    assert_eq!(reloaded.discount_mode.as_deref(), Some("PERCENT"));
    assert_eq!(reloaded.discount_value, Some(10_000));

    let preview = pos_svc::preview(
        &conn,
        order_id,
        reloaded.discount_mode.as_deref(),
        reloaded.discount_value,
    )
    .unwrap();
    assert_eq!(preview.discount_minor, 1_480);

    let paid = checkout::checkout(
        &conn,
        &staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CARD".into(),
            discount_mode: reloaded.discount_mode.clone(),
            discount_value: reloaded.discount_value,
            received: None,
        },
    )
    .unwrap();
    assert_eq!(paid.total, 14_800 - 1_480);

    let (inv, _) = invoices::get_invoice_full(&conn, paid.invoice_id)
        .unwrap()
        .unwrap();
    assert_eq!(inv.discount_minor, 1_480);
    assert_eq!(inv.total, 14_800 - 1_480);
}
