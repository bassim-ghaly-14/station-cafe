/**
 * INVOICE IDENTITY SNAPSHOTS — the cashier, the customer, and the open shift.
 *
 * An invoice is a financial document: who served the sale and who bought it are
 * facts about the moment it was raised, not facts that may be re-read from
 * mutable master records later. These tests pin that contract end to end —
 * persistence, retrieval, printing and historical stability — plus the
 * one-open-shift rule the POS open-shift card reports on.
 */
use crate::db::migrate;
use crate::demo_data::seed_for_development as run_if_empty;
use crate::printing;
use crate::repositories::{catalog, customers, employees, invoices, pos};
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

fn cafe_product(conn: &Connection, name: &str) -> i64 {
    catalog::list(conn, Some("CAFE"), true)
        .unwrap()
        .into_iter()
        .find(|p| p.name == name)
        .expect("seeded cafe product")
        .id
}

/// Sell one cafe line, optionally against a customer, and return the invoice id.
fn sell(conn: &Connection, actor: &auth::User, customer_id: Option<i64>) -> i64 {
    let table = pos::list_tables(conn, None).unwrap().remove(0);
    pos_svc::open_table(conn, actor, table.id).unwrap();
    let order_id = pos_svc::start_order(conn, actor, table.id).unwrap();
    pos_svc::add_line(conn, actor, order_id, cafe_product(conn, "هوت شوكليت"), 1).unwrap();
    if let Some(cid) = customer_id {
        pos_svc::attach_customer(conn, order_id, cid, None).unwrap();
    }
    checkout::checkout(
        conn,
        actor,
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
    .invoice_id
}

fn snapshot(conn: &Connection, invoice_id: i64) -> invoices::InvoiceRow {
    invoices::get_invoice_full(conn, invoice_id)
        .unwrap()
        .unwrap()
        .0
}

/// The employee row backing a login — the person as the business knows them.
fn employee_of(conn: &Connection, user_id: i64) -> i64 {
    conn.query_row(
        "SELECT id FROM employees WHERE user_id = ?1",
        [user_id],
        |r| r.get(0),
    )
    .unwrap()
}

fn employee_name(conn: &Connection, user_id: i64) -> String {
    conn.query_row(
        "SELECT name FROM employees WHERE user_id = ?1",
        [user_id],
        |r| r.get(0),
    )
    .unwrap()
}

/// A selling till: an open business day and an open shift for `staff`.
fn open_till(conn: &Connection, staff: &auth::User) {
    let manager = login(conn, "manager", "manager123");
    shift_svc::open_day(conn, &manager).unwrap();
    shift_svc::open_shift(conn, staff, 0).unwrap();
}

#[test]
fn an_invoice_persists_the_cashier_who_raised_it() {
    let conn = fresh();
    let staff = login(&conn, "cashier", "cashier123");
    open_till(&conn, &staff);

    let inv = snapshot(&conn, sell(&conn, &staff, None));

    // The snapshot is the EMPLOYEE's name (the person), not the login name, and
    // it is persisted rather than resolved when the document is printed.
    assert_eq!(
        inv.cashier_name.as_deref(),
        Some(employee_name(&conn, staff.id).as_str())
    );
}

#[test]
fn an_invoice_persists_the_customer_identity_and_details() {
    let conn = fresh();
    let staff = login(&conn, "cashier", "cashier123");
    open_till(&conn, &staff);

    let customer_id = customers::insert(&conn, "عميل مسجّل", Some("01001234567"), None).unwrap();
    customers::insert_car(&conn, customer_id, "ABC123", Some("تويوتا"), None).unwrap();

    let inv = snapshot(&conn, sell(&conn, &staff, Some(customer_id)));

    assert_eq!(inv.customer_name.as_deref(), Some("عميل مسجّل"));
    assert_eq!(inv.customer_phone.as_deref(), Some("01001234567"));
    assert_eq!(inv.car_plate.as_deref(), Some("ABC123"));
    assert_eq!(inv.car_model.as_deref(), Some("تويوتا"));
    // Both identities coexist on the same document.
    assert!(inv.cashier_name.is_some());
}

#[test]
fn a_customer_less_invoice_still_carries_its_explicit_identity_and_cashier() {
    let conn = fresh();
    let staff = login(&conn, "cashier", "cashier123");
    open_till(&conn, &staff);

    let inv = snapshot(&conn, sell(&conn, &staff, None));

    assert_eq!(
        inv.customer_name.as_deref(),
        Some(checkout::NO_CUSTOMER_LABEL)
    );
    assert!(inv.cashier_name.is_some());
}

/// The core historical-correctness rule: a later rename of the employee or the
/// customer must not rewrite what an already-issued invoice says about them.
#[test]
fn a_renamed_employee_or_customer_does_not_change_an_existing_invoice() {
    let conn = fresh();
    let staff = login(&conn, "cashier", "cashier123");
    open_till(&conn, &staff);

    let customer_id = customers::insert(&conn, "اسم قديم", Some("01001234567"), None).unwrap();
    let invoice_id = sell(&conn, &staff, Some(customer_id));
    let before = snapshot(&conn, invoice_id);

    employees::update_profile(
        &conn,
        employee_of(&conn, staff.id),
        "اسم كاشير جديد",
        None,
        None,
    )
    .unwrap();
    customers::update(
        &conn,
        customer_id,
        "اسم عميل جديد",
        Some("01001234567"),
        None,
    )
    .unwrap();

    let after = snapshot(&conn, invoice_id);
    assert_eq!(
        after.cashier_name, before.cashier_name,
        "a renamed employee must not rewrite the invoice"
    );
    assert_eq!(
        after.customer_name.as_deref(),
        Some("اسم قديم"),
        "a renamed customer must not rewrite the invoice"
    );
}

/// Printing is a pure function of the persisted row, so the printed document is
/// stable across sessions, devices and repeat prints.
#[test]
fn the_printed_invoice_is_stable_when_the_employee_and_customer_change() {
    let conn = fresh();
    let staff = login(&conn, "cashier", "cashier123");
    open_till(&conn, &staff);

    let customer_id = customers::insert(&conn, "عميل أول", Some("01001234567"), None).unwrap();
    let invoice_id = sell(&conn, &staff, Some(customer_id));

    let identity = |invoice_id: i64| -> Vec<(String, String)> {
        printing::preview_invoice(&conn, invoice_id)
            .unwrap()
            .ops
            .into_iter()
            .filter_map(|op| match op {
                printing::ir::PreviewOp::Meta { label, value, .. } => Some((label, value)),
                _ => None,
            })
            .collect()
    };

    let first = identity(invoice_id);
    assert!(
        first
            .iter()
            .any(|(label, value)| label == "الكاشير" && !value.is_empty()),
        "the invoice names its cashier: {first:?}"
    );
    assert!(first
        .iter()
        .any(|(label, value)| label == "العميل" && value == "عميل أول"));

    employees::update_profile(
        &conn,
        employee_of(&conn, staff.id),
        "كاشير مُغيَّر",
        None,
        None,
    )
    .unwrap();
    customers::update(&conn, customer_id, "عميل ثانٍ", Some("01001234567"), None).unwrap();

    assert_eq!(
        first,
        identity(invoice_id),
        "a reprint of a historical invoice must be identical"
    );
}

/// A second shift cannot be opened while one is open — the rule the POS card
/// reports on — and the state command identifies WHO opened the open one.
#[test]
fn the_open_shift_identifies_its_cashier_and_blocks_a_second_shift() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();

    let shift_id = shift_svc::open_shift(&conn, &staff, 0).unwrap();
    let state = shift_svc::state(&conn, &staff).unwrap();

    let open = state.open_shift.expect("the open shift is reported");
    assert_eq!(open.id, shift_id);
    assert_eq!(
        open.user_name.as_deref(),
        Some(employee_name(&conn, staff.id).as_str())
    );

    // The rule itself: a second shift is refused, whoever asks.
    assert!(
        shift_svc::open_shift(&conn, &manager, 0).is_err(),
        "a second shift cannot be opened while one is open"
    );

    // Closing it frees the till again, and the state command stops reporting it.
    shift_svc::close_shift(&conn, &staff, 0).unwrap();
    assert!(shift_svc::state(&conn, &staff)
        .unwrap()
        .open_shift
        .is_none());
    assert!(shift_svc::open_shift(&conn, &manager, 0).is_ok());
}
