//! Wash-ticket lifecycle rules and the تذاكر المغسلة اليوم read.
//!
//! Two business rules are protected here, both asserted through the SERVICE
//! layer exactly like production traffic, so a passing test means the IPC
//! command path is protected too:
//!
//!  1. **Once a wash ticket is ISSUED, its order can no longer be cancelled**
//!     by the cashier. The ticket is the persisted document, so the rule reads
//!     `wash_tickets` — it cannot be side-stepped by editing order lines, and a
//!     rejected cancellation leaves both the ticket and the order untouched.
//!  2. **The daily wash-ticket read never loses a ticket.** A ticket with no
//!     receipt yet is still a ticket, every ticket of the day is returned, and
//!     the related receipt travels with the row through the real persisted
//!     `invoices.order_id` relation — never through resemblance.

use crate::db::migrate;
use crate::repositories::{catalog, customers, pos};
use crate::demo_data::seed_for_development as run_if_empty;
use crate::services::{auth, checkout, pos as pos_svc, shifts as shift_svc};
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

fn wash_service(conn: &Connection, name: &str) -> i64 {
    catalog::list(conn, Some("WASH"), true)
        .unwrap()
        .into_iter()
        .find(|p| p.name == name)
        .expect("seeded wash service")
        .id
}

/// A customer with one car, ready to be attached to a wash order.
fn customer_with_car(conn: &Connection, name: &str, phone: &str, plate: &str) -> i64 {
    let id = customers::insert(conn, name, Some(phone), None).unwrap();
    customers::insert_car(conn, id, plate, Some("تويوتا"), None).unwrap();
    id
}

/// A business day, a cashier shift and one open table order.
fn open_day_shift_and_order(conn: &Connection, manager: &auth::User, staff: &auth::User) -> (i64, i64) {
    let day_id = shift_svc::open_day(conn, manager).unwrap();
    shift_svc::open_shift(conn, staff, 0).unwrap();
    let table = pos::list_tables(conn, None).unwrap().remove(0);
    pos_svc::open_table(conn, staff, table.id).unwrap();
    let order_id = pos_svc::start_order(conn, staff, table.id).unwrap();
    (day_id, order_id)
}

/// A wash order whose ticket has been issued, on the given business day.
fn ticketed_wash_order(
    conn: &Connection,
    manager: &auth::User,
    staff: &auth::User,
    name: &str,
    phone: &str,
    plate: &str,
) -> (i64, i64) {
    let (day_id, order_id) = open_day_shift_and_order(conn, manager, staff);
    pos_svc::add_line(conn, staff, order_id, wash_service(conn, "غسيل كامل سيدان"), 1).unwrap();
    let customer_id = customer_with_car(conn, name, phone, plate);
    pos_svc::attach_customer(conn, order_id, customer_id, Some(plate)).unwrap();
    pos_svc::issue_wash_ticket(conn, order_id).unwrap();
    (day_id, order_id)
}

fn pay_cash(conn: &Connection, staff: &auth::User, order_id: i64) -> checkout::CheckoutResult {
    checkout::checkout(
        conn,
        staff,
        &checkout::CheckoutInput {
            order_id,
            method: "CASH".into(),
            discount_mode: None,
            discount_value: None,
            discount_pin: None,
            service_charge_minor: None,
            received: Some(1_000_000),
        },
    )
    .unwrap()
}


// ---- CANCELLATION AFTER TICKET ISSUANCE ------------------------------------

#[test]
fn a_cashier_can_still_discard_an_order_that_has_no_wash_ticket() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let (_, order_id) = open_day_shift_and_order(&conn, &manager, &staff);

    pos_svc::discard_order(&conn, &staff, order_id).unwrap();

    assert_eq!(
        pos_svc::get_order(&conn, order_id).unwrap().status,
        "CANCELLED"
    );
}

#[test]
fn a_cashier_cannot_cancel_an_order_after_the_wash_ticket_is_issued() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let (_, order_id) =
        ticketed_wash_order(&conn, &manager, &staff, "أحمد محمود", "01000000001", "AAA111");

    let err = pos_svc::discard_order(&conn, &staff, order_id).unwrap_err();

    assert_eq!(err.kind(), crate::error::ErrorKind::BusinessRule);
    assert!(
        err.to_string().contains("pos.order_ticket_issued"),
        "the cashier must be told WHY, got: {err}"
    );
}

#[test]
fn the_rule_cannot_be_side_stepped_by_removing_the_wash_lines_first() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let (_, order_id) =
        ticketed_wash_order(&conn, &manager, &staff, "أحمد محمود", "01000000001", "AAA111");

    // The bypass this rule exists to close: empty the order first so the
    // incidental "an order with items cannot be discarded" guard no longer
    // applies, and only then try to cancel it.
    for line in pos_svc::get_order(&conn, order_id).unwrap().lines {
        pos_svc::remove_line(&conn, &staff, line.id).unwrap();
    }
    assert!(pos_svc::get_order(&conn, order_id).unwrap().lines.is_empty());

    let err = pos_svc::discard_order(&conn, &staff, order_id).unwrap_err();

    assert!(
        err.to_string().contains("pos.order_ticket_issued"),
        "emptying the order must not unlock cancellation, got: {err}"
    );
    assert_eq!(pos_svc::get_order(&conn, order_id).unwrap().status, "OPEN");
}

#[test]
fn a_refused_cancellation_never_mutates_the_historical_ticket_or_the_order() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let (_, order_id) =
        ticketed_wash_order(&conn, &manager, &staff, "أحمد محمود", "01000000001", "AAA111");
    let read_ticket = |conn: &Connection| -> (i64, i64, String) {
        conn.query_row(
            "SELECT id, waiting_no, day_date FROM wash_tickets WHERE order_id = ?1",
            [order_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    };
    let before = read_ticket(&conn);

    assert!(pos_svc::discard_order(&conn, &staff, order_id).is_err());

    assert_eq!(before, read_ticket(&conn), "the issued ticket is immutable");
    let tickets: i64 = conn
        .query_row("SELECT COUNT(*) FROM wash_tickets", [], |r| r.get(0))
        .unwrap();
    assert_eq!(tickets, 1, "the ticket is never deleted or reissued");
    assert_eq!(pos_svc::get_order(&conn, order_id).unwrap().status, "OPEN");
}

#[test]
fn a_manager_keeps_the_existing_discard_right_over_an_unticketed_order() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    let table = pos::list_tables(&conn, None).unwrap().remove(0);
    pos_svc::open_table(&conn, &staff, table.id).unwrap();
    let order_id = pos_svc::start_order(&conn, &staff, table.id).unwrap();

    // The elevated path the existing authorization model already grants: a
    // MANAGER may discard an empty order that belongs to a cashier.
    pos_svc::discard_order(&conn, &manager, order_id).unwrap();

    assert_eq!(
        pos_svc::get_order(&conn, order_id).unwrap().status,
        "CANCELLED"
    );
}

// ---- DAILY WASH TICKETS -----------------------------------------------------

#[test]
fn todays_issued_wash_ticket_is_returned_for_the_open_business_day() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let (day_id, order_id) =
        ticketed_wash_order(&conn, &manager, &staff, "أحمد محمود", "01000000001", "AAA111");

    let rows = pos_svc::daily_wash_tickets(&conn, Some(day_id), None, None).unwrap();

    assert_eq!(rows.len(), 1);
    let ticket = &rows[0];
    assert_eq!(ticket.order_id, order_id);
    assert_eq!(ticket.waiting_no, 1);
    assert_eq!(ticket.customer_name.as_deref(), Some("أحمد محمود"));
    assert_eq!(ticket.car_plate.as_deref(), Some("AAA111"));
    assert_eq!(ticket.order_status, "OPEN");
    assert_eq!(
        ticket.services.as_deref(),
        Some("غسيل كامل سيدان"),
        "the wash service comes from the order's own lines"
    );
}

#[test]
fn every_ticket_of_the_day_is_returned_not_just_the_last_one() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let (day_id, _) =
        ticketed_wash_order(&conn, &manager, &staff, "سارة", "01000000002", "BBB222");

    for (index, (name, phone, plate)) in [
        ("خالد", "01000000003", "CCC333"),
        ("منى", "01000000004", "DDD444"),
    ]
    .iter()
    .enumerate()
    {
        let table = pos::list_tables(&conn, None).unwrap().remove(index + 1);
        pos_svc::open_table(&conn, &staff, table.id).unwrap();
        let order_id = pos_svc::start_order(&conn, &staff, table.id).unwrap();
        pos_svc::add_line(
            &conn,
            &staff,
            order_id,
            wash_service(&conn, "غسيل كامل سيدان"),
            1,
        )
        .unwrap();
        let customer_id = customer_with_car(&conn, name, phone, plate);
        pos_svc::attach_customer(&conn, order_id, customer_id, Some(plate)).unwrap();
        pos_svc::issue_wash_ticket(&conn, order_id).unwrap();
    }

    let rows = pos_svc::daily_wash_tickets(&conn, Some(day_id), None, None).unwrap();

    assert_eq!(rows.len(), 3, "all three tickets of the day must appear");
    // Newest first: the same order the invoices page uses.
    let numbers: Vec<i64> = rows.iter().map(|r| r.waiting_no).collect();
    assert_eq!(numbers, vec![3, 2, 1]);
}

#[test]
fn a_ticket_carries_the_persisted_reference_to_its_own_invoice() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let (day_id, order_id) =
        ticketed_wash_order(&conn, &manager, &staff, "أحمد محمود", "01000000001", "AAA111");
    let paid = pay_cash(&conn, &staff, order_id);

    let rows = pos_svc::daily_wash_tickets(&conn, Some(day_id), None, None).unwrap();

    assert_eq!(rows.len(), 1);
    let ticket = &rows[0];
    assert_eq!(
        ticket.invoice_id,
        Some(paid.invoice_id),
        "the receipt is reached through invoices.order_id"
    );
    assert_eq!(ticket.invoice_no, Some(paid.invoice_no));
    assert_eq!(ticket.invoice_total, Some(paid.total));
    assert_eq!(ticket.invoice_status.as_deref(), Some("PAID"));
}

#[test]
fn a_ticket_without_an_invoice_still_appears() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let (day_id, _) =
        ticketed_wash_order(&conn, &manager, &staff, "سارة", "01000000002", "BBB222");

    // The wash job is still in the bay: ticketed, NOT invoiced. This is exactly
    // the row an INNER JOIN would silently disappear.
    let rows = pos_svc::daily_wash_tickets(&conn, Some(day_id), None, None).unwrap();

    assert_eq!(rows.len(), 1, "a ticket is not conditional on its invoice");
    assert_eq!(rows[0].invoice_id, None);
    assert_eq!(rows[0].invoice_no, None);
}

#[test]
fn two_orders_of_one_customer_keep_their_own_invoice() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let (day_id, first) =
        ticketed_wash_order(&conn, &manager, &staff, "سارة", "01000000002", "BBB222");

    // Same customer, same car, same service, minutes apart — the exact shape a
    // name / plate / timestamp match would confuse.
    let table = pos::list_tables(&conn, None).unwrap().remove(1);
    pos_svc::open_table(&conn, &staff, table.id).unwrap();
    let second = pos_svc::start_order(&conn, &staff, table.id).unwrap();
    pos_svc::add_line(
        &conn,
        &staff,
        second,
        wash_service(&conn, "غسيل كامل سيدان"),
        1,
    )
    .unwrap();
    // The same customer washing a second car minutes later — the exact shape a
    // customer-name / plate / timestamp match would confuse between two
    // perfectly real, separate receipts.
    let customer_id = customers::find_by_phone_key(&conn, "01000000002")
        .unwrap()
        .expect("the customer created above");
    pos_svc::attach_customer(&conn, second, customer_id, Some("BBB222")).unwrap();
    pos_svc::issue_wash_ticket(&conn, second).unwrap();

    let first_invoice = pay_cash(&conn, &staff, first);
    let second_invoice = pay_cash(&conn, &staff, second);

    let rows = pos_svc::daily_wash_tickets(&conn, Some(day_id), None, None).unwrap();

    assert_eq!(rows.len(), 2);
    let second_row = rows.iter().find(|r| r.order_id == second).unwrap();
    let first_row = rows.iter().find(|r| r.order_id == first).unwrap();
    assert_eq!(second_row.invoice_id, Some(second_invoice.invoice_id));
    assert_eq!(first_row.invoice_id, Some(first_invoice.invoice_id));
    assert_ne!(first_row.invoice_id, second_row.invoice_id);
}

#[test]
fn the_day_boundary_is_the_business_day_not_the_calendar_label() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let (first_day, first_order) =
        ticketed_wash_order(&conn, &manager, &staff, "سارة", "01000000002", "BBB222");
    pay_cash(&conn, &staff, first_order);
    shift_svc::close_shift(&conn, &staff, 0).unwrap();
    shift_svc::close_day(&conn, &manager).unwrap();

    // A SECOND operational day carrying the SAME calendar label — the exact case
    // a `day_date` filter would merge into one.
    let second_day = shift_svc::open_day(&conn, &manager).unwrap();
    assert_ne!(first_day, second_day, "two business days exist");
    let labels: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT day_date) FROM business_days WHERE id IN (?1, ?2)",
            rusqlite::params![first_day, second_day],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(labels, 1, "both days carry one calendar label");

    assert_eq!(
        pos_svc::daily_wash_tickets(&conn, Some(first_day), None, None)
            .unwrap()
            .len(),
        1
    );
    assert!(
        pos_svc::daily_wash_tickets(&conn, Some(second_day), None, None)
            .unwrap()
            .is_empty(),
        "the new day has no tickets of its own"
    );
}

#[test]
fn the_daily_read_is_narrowed_by_the_backend_only() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let (day_id, order_id) =
        ticketed_wash_order(&conn, &manager, &staff, "أحمد محمود", "01000000001", "AAA111");

    assert_eq!(
        pos_svc::daily_wash_tickets(&conn, Some(day_id), Some("AAA111"), None)
            .unwrap()
            .len(),
        1
    );
    assert!(
        pos_svc::daily_wash_tickets(&conn, Some(day_id), Some("ZZZ999"), None)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        pos_svc::daily_wash_tickets(&conn, Some(day_id), None, Some("OPEN"))
            .unwrap()
            .len(),
        1
    );
    assert!(
        pos_svc::daily_wash_tickets(&conn, Some(day_id), None, Some("CLOSED"))
            .unwrap()
            .is_empty()
    );

    pay_cash(&conn, &staff, order_id);
    assert_eq!(
        pos_svc::daily_wash_tickets(&conn, Some(day_id), None, Some("CLOSED"))
            .unwrap()
            .len(),
        1,
        "the order state is the ticket's only real status"
    );
}

#[test]
fn an_empty_business_day_returns_a_valid_empty_result() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let (day_id, _) = open_day_shift_and_order(&conn, &manager, &staff);

    let rows = pos_svc::daily_wash_tickets(&conn, Some(day_id), None, None).unwrap();

    assert!(
        rows.is_empty(),
        "no tickets is a valid answer, never an error"
    );
}

