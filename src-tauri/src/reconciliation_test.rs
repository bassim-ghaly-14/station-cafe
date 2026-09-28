//! Shift-closing and day-closing reconciliation business rules.
//!
//! Each test corresponds to a rule the closing documents depend on: cash
//! expenses reduce the drawer, card/credit never do, hybrid invoices are
//! counted once, services and discounts are explicit, and an OPEN SHIFT can
//! never leak into a day closing.

use crate::db::migrate;
use crate::repositories::shifts as shifts_repo;
use crate::repositories::{catalog, expenses, invoices, pos};
use crate::seed::run_if_empty;
use crate::services::reconciliation::{self, CashStatus};
use crate::services::{
    auth, checkout, ops as ops_svc, pos as pos_svc, reports, shifts as shift_svc,
};
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

fn expense_input(category: &str, amount: i64) -> ops_svc::NewExpense {
    ops_svc::NewExpense {
        category: category.into(),
        amount,
        description: None,
        expense_date: None,
        is_recurring: false,
        recurrence: None,
        paid_from_cash: true,
    }
}

/// Sell a cafe item for cash on the caller's active shift.
fn sell_cafe_cash(conn: &Connection, actor: &auth::User, product: &str) -> i64 {
    let table = pos::list_tables(conn, None).unwrap().remove(0);
    pos_svc::open_table(conn, actor, table.id).unwrap();
    let order_id = pos_svc::start_order(conn, actor, table.id).unwrap();
    pos_svc::add_line(conn, actor, order_id, cafe_product(conn, product), 1).unwrap();
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

fn invoice_total(conn: &Connection, invoice_id: i64) -> i64 {
    invoices::get_invoice_full(conn, invoice_id)
        .unwrap()
        .unwrap()
        .0
        .total
}

// ---- the drawer formula -----------------------------------------------------

#[test]
fn cash_reconciliation_formula_is_opening_plus_inflows_minus_outflows() {
    let r = reconciliation::CashReconciliation::build(10_000, 25_000, 4_000, 30_000);
    assert_eq!(r.expected_cash, 10_000 + 25_000 - 4_000);
    assert_eq!(r.expected_cash, 31_000);
    assert_eq!(r.difference, 30_000 - 31_000);
}

#[test]
fn reconciliation_status_distinguishes_shortage_from_surplus() {
    // A non-zero difference must NOT always be called a shortage.
    let short = reconciliation::CashReconciliation::build(0, 1_000, 0, 900);
    assert_eq!(short.status, CashStatus::Shortage);
    assert_eq!(short.shortage, 100);
    assert_eq!(short.surplus, 0);

    let over = reconciliation::CashReconciliation::build(0, 1_000, 0, 1_200);
    assert_eq!(over.status, CashStatus::Surplus);
    assert_eq!(over.surplus, 200);
    assert_eq!(over.shortage, 0);

    let even = reconciliation::CashReconciliation::build(500, 1_000, 200, 1_300);
    assert_eq!(even.status, CashStatus::Balanced);
    assert_eq!(even.difference, 0);
    assert_eq!(even.shortage, 0);
    assert_eq!(even.surplus, 0);
}

// ---- cashier expenses -------------------------------------------------------

#[test]
fn cashier_expense_is_persisted_and_linked_to_the_active_shift() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 0).unwrap();

    let id = ops_svc::create_expense(&conn, &staff, &expense_input("SUPPLIES", 3_000)).unwrap();
    let rows = expenses::list_for_shift(&conn, shift_id).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, id);
    assert_eq!(rows[0].amount, 3_000);
    assert_eq!(rows[0].shift_id, Some(shift_id));
    assert!(
        rows[0].paid_from_cash,
        "cashier spend defaults to the drawer"
    );
    // The category name comes from the table, not from a hardcoded string.
    assert_eq!(rows[0].category_name, "مشتريات");
}

#[test]
fn cashier_without_an_open_shift_cannot_record_an_expense() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    // No shift open for this cashier: the spend could never be reconciled.
    let err = ops_svc::create_expense(&conn, &staff, &expense_input("OTHER", 1_000)).unwrap_err();
    assert_eq!(err.kind(), crate::error::ErrorKind::BusinessRule);
}

#[test]
fn an_unknown_category_is_rejected() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let err =
        ops_svc::create_expense(&conn, &manager, &expense_input("NONSENSE", 1_000)).unwrap_err();
    assert_eq!(err.kind(), crate::error::ErrorKind::Validation);
}

#[test]
fn a_non_positive_expense_amount_is_rejected() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    assert!(ops_svc::create_expense(&conn, &manager, &expense_input("OTHER", 0)).is_err());
    assert!(ops_svc::create_expense(&conn, &manager, &expense_input("OTHER", -5)).is_err());
}

#[test]
fn an_expense_is_never_counted_against_a_shift_it_was_not_booked_to() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();

    let first = shift_svc::open_shift(&conn, &staff, 0).unwrap();
    ops_svc::create_expense(&conn, &staff, &expense_input("UTILITY", 5_000)).unwrap();
    shift_svc::close_shift(&conn, &staff, 0).unwrap();

    let second = shift_svc::open_shift(&conn, &staff, 0).unwrap();
    ops_svc::create_expense(&conn, &staff, &expense_input("MAINTENANCE", 7_000)).unwrap();

    let first_report = reconciliation::shift_report(&conn, first).unwrap();
    let second_report = reconciliation::shift_report(&conn, second).unwrap();
    assert_eq!(first_report.expenses, 5_000);
    assert_eq!(second_report.expenses, 7_000);
    // The first shift is CLOSED: its reconciliation is frozen, not re-read.
    assert_eq!(first_report.expense_breakdown.len(), 1);
    assert_eq!(first_report.expense_breakdown[0].category, "UTILITY");
}

#[test]
fn only_cash_expenses_reduce_the_drawer() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 10_000).unwrap();
    let total = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));

    ops_svc::create_expense(&conn, &staff, &expense_input("OTHER", 1_500)).unwrap();
    // Paid by card: an expense of the shift that never left the drawer.
    ops_svc::create_expense(
        &conn,
        &staff,
        &ops_svc::NewExpense {
            paid_from_cash: false,
            ..expense_input("SUPPLIES", 4_000)
        },
    )
    .unwrap();

    let (expenses_total, cash_expenses) = expenses::shift_totals(&conn, shift_id).unwrap();
    assert_eq!(expenses_total, 5_500, "both expenses belong to the shift");
    assert_eq!(cash_expenses, 1_500, "only the cash one left the drawer");

    let expected = 10_000 + total - 1_500;
    let closing = shift_svc::close_shift(&conn, &staff, expected).unwrap();
    assert_eq!(closing.expected_cash, expected);
    assert_eq!(closing.difference, 0);
    assert_eq!(closing.report.cash.status, CashStatus::Balanced);
    assert_eq!(closing.report.expenses, 5_500);
}

#[test]
fn the_expense_breakdown_groups_by_category_with_counts() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 0).unwrap();
    ops_svc::create_expense(&conn, &staff, &expense_input("UTILITY", 1_000)).unwrap();
    ops_svc::create_expense(&conn, &staff, &expense_input("UTILITY", 2_000)).unwrap();
    ops_svc::create_expense(&conn, &staff, &expense_input("SUPPLIES", 500)).unwrap();

    let rows = expenses::breakdown_for_shift(&conn, shift_id).unwrap();
    assert_eq!(rows.len(), 2);
    // Ordered by amount descending, so the largest category leads.
    assert_eq!(rows[0].category, "UTILITY");
    assert_eq!(rows[0].count, 2);
    assert_eq!(rows[0].amount, 3_000);
    assert_eq!(rows[0].category_name, "كهرباء ومياه");
    assert_eq!(rows[1].category, "SUPPLIES");
    assert_eq!(rows[1].count, 1);
    assert_eq!(rows[1].amount, 500);
}

// ---- shift closing ----------------------------------------------------------

#[test]
fn shift_closing_persists_every_reconciliation_figure() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 5_000).unwrap();
    let total = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    ops_svc::create_expense(&conn, &staff, &expense_input("OTHER", 1_000)).unwrap();

    let expected = 5_000 + total - 1_000;
    let closing = shift_svc::close_shift(&conn, &staff, expected - 250).unwrap();

    // A shortage, explicitly — not merely a negative number.
    assert_eq!(closing.difference, -250);
    assert_eq!(closing.report.cash.status, CashStatus::Shortage);
    assert_eq!(closing.report.cash.shortage, 250);
    assert_eq!(closing.report.cash.surplus, 0);
    assert_eq!(closing.report.cash.opening_cash, 5_000);
    assert_eq!(closing.report.cash.cash_inflows, total);
    assert_eq!(closing.report.cash.cash_outflows, 1_000);

    // The handover amount is persisted on the shift row itself.
    let stored = crate::repositories::shifts::get_shift(&conn, shift_id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.actual_cash, Some(expected - 250));
    assert_eq!(stored.cash_difference, Some(-250));
    assert_eq!(stored.expected_cash, expected);
    assert_eq!(stored.cash_expenses, 1_000);
    assert_eq!(stored.status, "CLOSED");
}

#[test]
fn a_surplus_is_never_reported_as_a_shortage() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    let total = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));

    let closing = shift_svc::close_shift(&conn, &staff, total + 500).unwrap();
    assert_eq!(closing.difference, 500);
    assert_eq!(closing.report.cash.status, CashStatus::Surplus);
    assert_eq!(closing.report.cash.surplus, 500);
    assert_eq!(closing.report.cash.shortage, 0);
}

#[test]
fn a_closed_shift_reconciliation_is_immutable() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 0).unwrap();
    sell_cafe_cash(&conn, &staff, "مياه");
    shift_svc::close_shift(&conn, &staff, 12_345).unwrap();

    let first = reconciliation::shift_report(&conn, shift_id).unwrap();
    let second = reconciliation::shift_report(&conn, shift_id).unwrap();
    assert_eq!(first.cash.expected_cash, second.cash.expected_cash);
    assert_eq!(first.cash.actual_cash, second.cash.actual_cash);
    assert_eq!(first.cash.actual_cash, 12_345);
    assert_eq!(first.total_sales, second.total_sales);
}

#[test]
fn a_double_close_is_rejected() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    shift_svc::close_shift(&conn, &staff, 0).unwrap();
    assert!(shift_svc::close_shift(&conn, &staff, 0).is_err());
}

#[test]
fn a_manager_cannot_close_a_shift_they_do_not_own() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    assert!(shift_svc::close_shift(&conn, &manager, 0).is_err());
}

#[test]
fn a_negative_handover_amount_is_rejected() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    assert!(shift_svc::close_shift(&conn, &staff, -1).is_err());
}

// ---- invoice areas, services and discounts ---------------------------------

/// Sell one order made of the given (department, product) lines for CASH.
fn sell_lines(
    conn: &Connection,
    actor: &auth::User,
    service_charge: Option<i64>,
    lines: &[(&str, &str)],
) -> i64 {
    let table = pos::list_tables(conn, None).unwrap().remove(0);
    pos_svc::open_table(conn, actor, table.id).unwrap();
    let order_id = pos_svc::start_order(conn, actor, table.id).unwrap();
    for (dept, name) in lines {
        let id = if *dept == "CAFE" {
            cafe_product(conn, name)
        } else {
            wash_service(conn, name)
        };
        pos_svc::add_line(conn, actor, order_id, id, 1).unwrap();
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
            service_charge_minor: service_charge,
            received: Some(1_000_000),
        },
    )
    .unwrap()
    .invoice_id
}

fn invoice_snap(conn: &Connection, invoice_id: i64) -> invoices::InvoiceRow {
    invoices::get_invoice_full(conn, invoice_id)
        .unwrap()
        .unwrap()
        .0
}

#[test]
fn a_hybrid_invoice_is_counted_once_in_the_areas_but_pays_both_departments() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 0).unwrap();

    // One cafe-only, one wash-only, one hybrid (both on one table).
    let cafe_only = sell_lines(&conn, &staff, None, &[("CAFE", "مياه")]);
    let wash_only = sell_lines(&conn, &staff, None, &[("WASH", "غسيل كامل سيدان")]);
    let hybrid = sell_lines(
        &conn,
        &staff,
        None,
        &[("CAFE", "مياه"), ("WASH", "غسيل كامل سيدان")],
    );

    let report = reconciliation::shift_report(&conn, shift_id).unwrap();
    assert_eq!(report.invoices_count, 3);
    // The three area counts are MUTUALLY EXCLUSIVE and sum to the total, so a
    // hybrid document is never counted twice.
    assert_eq!(report.areas.cafe_invoices, 1);
    assert_eq!(report.areas.wash_invoices, 1);
    assert_eq!(report.areas.hybrid_invoices, 1);
    assert_eq!(
        report.areas.cafe_invoices + report.areas.wash_invoices + report.areas.hybrid_invoices,
        report.invoices_count
    );
    // Money still splits per department: the hybrid pays into BOTH.
    let hybrid_snap = invoice_snap(&conn, hybrid);
    assert!(hybrid_snap.cafe_total > 0 && hybrid_snap.wash_total > 0);
    assert_eq!(
        report.cafe_sales,
        invoice_snap(&conn, cafe_only).cafe_total + hybrid_snap.cafe_total
    );
    assert_eq!(
        report.wash_sales,
        invoice_snap(&conn, wash_only).wash_total + hybrid_snap.wash_total
    );
}

#[test]
fn the_service_total_is_the_invoice_level_charge_and_is_explicit() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 0).unwrap();

    // Authorize a fixed service charge, then sell two invoices using it.
    crate::services::settings::set_service_charge(
        &conn,
        &manager,
        &crate::services::settings::ServiceChargeConfig {
            amounts: vec![2_000],
        },
    )
    .unwrap();
    let a = sell_lines(&conn, &staff, Some(2_000), &[("CAFE", "مياه")]);
    let b = sell_lines(&conn, &staff, Some(2_000), &[("CAFE", "مياه")]);

    // Authoritative source: the invoices' own snapshot column.
    assert_eq!(invoice_snap(&conn, a).service_charge, 2_000);
    assert_eq!(invoice_snap(&conn, b).service_charge, 2_000);

    let report = reconciliation::shift_report(&conn, shift_id).unwrap();
    assert_eq!(report.service_charges, 4_000);
    // It is its own line, and it is part of the invoice total.
    assert_eq!(
        report.total_sales,
        invoice_snap(&conn, a).total + invoice_snap(&conn, b).total
    );
    assert_eq!(report.discounts, 0, "no discount was granted");
}

#[test]
fn card_and_credit_sales_never_inflate_the_expected_drawer() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 20_000).unwrap();

    let cash_invoice = sell_cafe_cash(&conn, &staff, "مياه");
    // A CARD sale: real revenue that never enters the till.
    let card_invoice = sell_card(&conn, &staff);

    let cash_total = invoice_total(&conn, cash_invoice);
    let card_total = invoice_total(&conn, card_invoice);
    assert!(card_total > 0, "the card sale is real revenue");

    let report = reconciliation::shift_report(&conn, shift_id).unwrap();
    // Both appear in the sales totals...
    assert_eq!(report.cash_sales, cash_total);
    assert_eq!(report.card_sales, card_total);
    assert_eq!(report.invoices_count, 2);
    // ...but only the cash one is in the drawer.
    assert_eq!(report.cash.expected_cash, 20_000 + cash_total);
    assert_eq!(report.cash.cash_inflows, cash_total);
}

/// Every invoice is a real document, so the shift report counts them all and the
/// drawer's cash inflows match the invoices' money exactly.
#[test]
fn every_invoice_contributes_to_the_shift_and_its_money_to_the_drawer() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 0).unwrap();
    let first = sell_cafe_cash(&conn, &staff, "مياه");
    let second = sell_cafe_cash(&conn, &staff, "هوت شوكليت");

    let report = reconciliation::shift_report(&conn, shift_id).unwrap();
    assert_eq!(report.invoices_count, 2);
    assert_eq!(
        report.cash_sales,
        invoice_total(&conn, first) + invoice_total(&conn, second)
    );
    assert_eq!(report.cash.cash_inflows, report.cash_sales);
}

/// Sell one cafe item paid by CARD.
fn sell_card(conn: &Connection, actor: &auth::User) -> i64 {
    let table = pos::list_tables(conn, None).unwrap().remove(0);
    pos_svc::open_table(conn, actor, table.id).unwrap();
    let order_id = pos_svc::start_order(conn, actor, table.id).unwrap();
    pos_svc::add_line(conn, actor, order_id, cafe_product(conn, "مياه"), 1).unwrap();
    checkout::checkout(
        conn,
        actor,
        &checkout::CheckoutInput {
            order_id,
            method: "CARD".into(),
            discount_mode: None,
            discount_value: None,
            discount_pin: None,
            service_charge_minor: None,
            received: None,
        },
    )
    .unwrap()
    .invoice_id
}

// ---- day closing: the inclusion rule ---------------------------------------

#[test]
fn a_day_with_all_shifts_closed_includes_every_shift() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let day_id = crate::repositories::shifts::current_day(&conn)
        .unwrap()
        .unwrap()
        .id;

    let a = shift_svc::open_shift(&conn, &staff, 1_000).unwrap();
    let cash_a = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    shift_svc::close_shift(&conn, &staff, 1_000 + cash_a).unwrap();
    let b = shift_svc::open_shift(&conn, &staff, 2_000).unwrap();
    let cash_b = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    shift_svc::close_shift(&conn, &staff, 2_000 + cash_b).unwrap();

    let preview = shift_svc::day_close_preview(&conn, &manager).unwrap();
    assert!(preview.open_shifts.is_empty(), "nothing to warn about");
    assert_eq!(preview.report.shift_count, 2);
    assert_eq!(preview.report.included_shift_ids, vec![a, b]);

    let result = shift_svc::close_day(&conn, &manager).unwrap();
    assert_eq!(result.report.shift_count, 2);
    assert_eq!(result.totals.cash, cash_a + cash_b);
    assert_eq!(result.report.cash.opening_cash, 3_000);
    assert_eq!(result.report.cash.cash_inflows, cash_a + cash_b);
    assert_eq!(result.report.cash.status, CashStatus::Balanced);

    // The historical report reproduces the same figures.
    let stored = reports::day_report(&conn, day_id).unwrap();
    assert_eq!(stored.total_sales, result.totals.total_sales);
    assert_eq!(stored.cash.expected_cash, result.report.cash.expected_cash);
}

#[test]
fn an_open_shift_is_excluded_from_the_day_closing() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();

    // Settled shift with real money in it.
    let settled = shift_svc::open_shift(&conn, &staff, 1_000).unwrap();
    let settled_cash = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    ops_svc::create_expense(&conn, &staff, &expense_input("OTHER", 300)).unwrap();
    shift_svc::close_shift(&conn, &staff, 1_000 + settled_cash - 300).unwrap();

    // A second shift is opened and left OPEN, with its own sales and expense.
    let open = shift_svc::open_shift(&conn, &staff, 0).unwrap();
    let open_cash = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    ops_svc::create_expense(&conn, &staff, &expense_input("SUPPLIES", 700)).unwrap();
    assert!(open_cash > 0);

    // The manager is told, and may continue.
    let preview = shift_svc::day_close_preview(&conn, &manager).unwrap();
    assert_eq!(preview.open_shifts.len(), 1);
    assert_eq!(preview.open_shifts[0].id, open);
    assert_eq!(preview.report.open_shift_count, 1);
    // Only the settled shift is in the preview totals.
    assert_eq!(preview.report.included_shift_ids, vec![settled]);
    assert_eq!(preview.report.shift_count, 1);

    // Confirming closes the day over the settled shift only.
    let result = shift_svc::close_day(&conn, &manager).unwrap();
    assert_eq!(result.report.shift_count, 1);
    assert_eq!(
        result.totals.cash, settled_cash,
        "open-shift sales excluded"
    );
    assert_eq!(result.totals.expenses, 300, "only the settled expense");
    assert_eq!(result.report.expenses, 300);
    assert_eq!(result.report.open_shift_count, 1);
    // The open shift's expense must not appear anywhere in the day.
    assert_eq!(result.report.expense_breakdown.len(), 1);
    assert_eq!(result.report.expense_breakdown[0].category, "OTHER");
}

#[test]
fn several_closed_shifts_plus_one_open_shift_include_only_the_closed_ones() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();

    let mut totals = Vec::new();
    let mut ids = Vec::new();
    for opening in [1_000, 2_000, 3_000] {
        let id = shift_svc::open_shift(&conn, &staff, opening).unwrap();
        let cash = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
        ops_svc::create_expense(&conn, &staff, &expense_input("OTHER", 100)).unwrap();
        shift_svc::close_shift(&conn, &staff, opening + cash - 100).unwrap();
        ids.push(id);
        totals.push(cash);
    }
    // The fourth shift stays open.
    shift_svc::open_shift(&conn, &staff, 9_000).unwrap();
    sell_cafe_cash(&conn, &staff, "مياه");
    ops_svc::create_expense(&conn, &staff, &expense_input("UTILITY", 5_000)).unwrap();

    let preview = shift_svc::day_close_preview(&conn, &manager).unwrap();
    assert_eq!(preview.open_shifts.len(), 1);
    assert_eq!(preview.report.included_shift_ids, ids);

    let result = shift_svc::close_day(&conn, &manager).unwrap();
    assert_eq!(result.report.shift_count, 3);
    assert_eq!(result.report.included_shift_ids, ids);
    assert_eq!(result.totals.cash, totals.iter().sum::<i64>());
    assert_eq!(result.totals.expenses, 300, "3 × 100, never the open 5,000");
    assert_eq!(result.report.cash.opening_cash, 6_000);
    assert_eq!(result.report.cash.cash_outflows, 300);
}

#[test]
fn a_day_with_only_an_open_shift_cannot_be_closed() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 5_000).unwrap();
    sell_cafe_cash(&conn, &staff, "مياه");

    // There is nothing settled to record, so the closing stays blocked rather
    // than freezing an empty report and stranding the open shift.
    let preview = shift_svc::day_close_preview(&conn, &manager).unwrap();
    assert_eq!(preview.report.shift_count, 0);
    assert_eq!(preview.open_shifts.len(), 1);
    let err = shift_svc::close_day(&conn, &manager).unwrap_err();
    assert_eq!(err.kind(), crate::error::ErrorKind::BusinessRule);
    assert_eq!(
        err.to_string(),
        "business rule violation: day.no_settled_shifts"
    );
    // The day is still open, so the running shift can still be settled later.
    assert!(crate::repositories::shifts::current_day(&conn)
        .unwrap()
        .is_some());
}

#[test]
fn a_day_can_be_closed_after_its_shifts_were_settled() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let day_id = crate::repositories::shifts::current_day(&conn)
        .unwrap()
        .unwrap()
        .id;
    let shift_id = shift_svc::open_shift(&conn, &staff, 0).unwrap();
    let cash = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    shift_svc::close_shift(&conn, &staff, cash).unwrap();

    // Incremental settlement first.
    let settlement = shift_svc::settle_day(&conn, &manager).unwrap();
    assert_eq!(settlement.shift_ids, vec![shift_id]);

    // Then the final closing still records that shift, exactly once.
    let result = shift_svc::close_day(&conn, &manager).unwrap();
    assert_eq!(result.report.included_shift_ids, vec![shift_id]);
    assert_eq!(result.report.shift_count, 1);
    let stored = reports::day_report(&conn, day_id).unwrap();
    assert_eq!(stored.included_shift_ids, vec![shift_id]);
}

/// A business day that saw NO activity at all is still a legitimate closing.
///
/// Nothing is invented to make it look busy: the shift never happened, so the
/// closing genuinely includes no shift and every total is genuinely zero. What
/// must be true is that the closing is PERSISTED, COUNTS as a closed business
/// day, and is listed by the reports like any other.
#[test]
fn a_business_day_with_no_activity_is_closed_and_recorded_as_an_empty_closing() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let day_id = shift_svc::open_day(&conn, &manager).unwrap();

    let result = shift_svc::close_day(&conn, &manager).unwrap();

    assert_eq!(result.report.shift_count, 0);
    assert_eq!(result.report.included_shift_ids, Vec::<i64>::new());
    assert_eq!(result.totals.invoices_count, 0);
    assert_eq!(result.totals.total_sales, 0);
    assert_eq!(result.totals.expenses, 0);

    // The business day is genuinely CLOSED, not stranded.
    assert!(shifts_repo::current_day(&conn).unwrap().is_none());

    // It is a real, countable closing: the reports read it from the persisted
    // final snapshot, so the day cannot vanish from history.
    let days = shifts_repo::closed_business_days(&conn, None, None).unwrap();
    assert_eq!(days.len(), 1, "an empty closing is still counted");
    assert_eq!(days[0].business_day_id, day_id);
    assert_eq!(days[0].shift_count, 0);
    assert_eq!(days[0].totals.total_sales, 0);

    // And the immutable snapshot reproduces the same zeroed report.
    let stored = reports::day_report(&conn, day_id).unwrap();
    assert_eq!(stored.invoices_count, 0);
    assert_eq!(stored.total_sales, 0);
    assert_eq!(stored.shift_count, 0);
}

/// A shift that ran with no invoices, no wash tickets and no expenses is a
/// legitimate closing in its own right, and the day must be able to include it.
#[test]
fn an_empty_shift_closing_is_persisted_and_settles_its_day() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let day_id = shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 5_000).unwrap();

    let closed = shift_svc::close_shift(&conn, &staff, 5_000).unwrap();

    assert_eq!(closed.shift.id, shift_id);
    assert_eq!(closed.shift.status, "CLOSED");
    assert_eq!(closed.shift.invoices_count, 0);
    assert_eq!(closed.expected_cash, 5_000);

    let shifts = shifts_repo::closed_shifts(&conn, None, None).unwrap();
    assert_eq!(shifts.len(), 1, "an empty shift closing is listed");
    assert_eq!(shifts[0].invoices_count, 0);

    let result = shift_svc::close_day(&conn, &manager).unwrap();
    assert_eq!(result.report.included_shift_ids, vec![shift_id]);
    assert_eq!(result.report.shift_count, 1);
    assert_eq!(result.totals.invoices_count, 0);
    assert_eq!(result.totals.total_sales, 0);
    // The drawer is still a real reconciliation of the float that was counted.
    assert_eq!(result.report.cash.opening_cash, 5_000);
    assert_eq!(result.report.cash.expected_cash, 5_000);
    let _ = day_id;
}

/// An empty closing must never leave the till unable to start a new day.
#[test]
fn closing_an_empty_day_unblocks_the_next_business_day() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    shift_svc::close_shift(&conn, &staff, 0).unwrap();
    shift_svc::close_day(&conn, &manager).unwrap();

    // Only ONE business day may be open, so a day that could never be closed
    // would silently block every day after it.
    let next = shift_svc::open_day(&conn, &manager).unwrap();
    assert!(next > 0);
}

#[test]
fn closing_an_already_closed_day_is_rejected() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    shift_svc::close_shift(&conn, &staff, 0).unwrap();
    shift_svc::close_day(&conn, &manager).unwrap();
    assert!(shift_svc::close_day(&conn, &manager).is_err());
}

#[test]
fn an_expense_is_included_in_the_day_totals_exactly_once() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let day_id = shift_svc::open_day(&conn, &manager).unwrap();

    // The shifts open with enough float that the handover is never negative.
    let a = shift_svc::open_shift(&conn, &staff, 5_000).unwrap();
    ops_svc::create_expense(&conn, &staff, &expense_input("UTILITY", 1_500)).unwrap();
    let cash_a = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    shift_svc::close_shift(&conn, &staff, 5_000 + cash_a - 1_500).unwrap();

    // Settle each shift separately: the expense follows ITS shift, so neither
    // settlement may claim the other's spend.
    let first = shift_svc::settle_day(&conn, &manager).unwrap();
    assert_eq!(first.shift_ids, vec![a]);
    assert_eq!(first.totals.expenses, 1_500, "only shift A's expense");

    let b = shift_svc::open_shift(&conn, &staff, 5_000).unwrap();
    ops_svc::create_expense(&conn, &staff, &expense_input("SUPPLIES", 2_500)).unwrap();
    let cash_b = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    shift_svc::close_shift(&conn, &staff, 5_000 + cash_b - 2_500).unwrap();

    // The second checkpoint sees only the new shift: shift A is already
    // claimed and must not reappear, so no expense can be reported twice.
    let second = shift_svc::settle_day(&conn, &manager).unwrap();
    assert_eq!(second.shift_ids, vec![b]);
    assert_eq!(second.totals.expenses, 2_500, "only shift B's expense");

    let result = shift_svc::close_day(&conn, &manager).unwrap();
    assert_eq!(result.totals.expenses, 4_000, "each expense counted once");
    assert_eq!(result.report.expenses, 4_000);
    let stored = reports::day_report(&conn, day_id).unwrap();
    assert_eq!(stored.expenses, 4_000);
    let breakdown_total: i64 = stored.expense_breakdown.iter().map(|r| r.amount).sum();
    assert_eq!(breakdown_total, 4_000, "the breakdown sums to the total");
}

#[test]
fn the_day_report_stays_stable_after_the_day_is_closed() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let day_id = shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    let cash = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    ops_svc::create_expense(&conn, &staff, &expense_input("OTHER", 1_000)).unwrap();
    shift_svc::close_shift(&conn, &staff, cash - 1_000).unwrap();
    shift_svc::close_day(&conn, &manager).unwrap();

    let before = reports::day_report(&conn, day_id).unwrap();
    // A later configuration change must not move a historical closing.
    crate::services::settings::set_service_charge(
        &conn,
        &manager,
        &crate::services::settings::ServiceChargeConfig {
            amounts: vec![9_999],
        },
    )
    .unwrap();
    let after = reports::day_report(&conn, day_id).unwrap();
    assert_eq!(before.total_sales, after.total_sales);
    assert_eq!(before.expenses, after.expenses);
    assert_eq!(before.cash.expected_cash, after.cash.expected_cash);
    assert_eq!(before.cash.actual_cash, after.cash.actual_cash);
    assert_eq!(before.cash.status, after.cash.status);
    assert_eq!(after.expenses, 1_000);
}

#[test]
fn only_a_manager_may_close_the_business_day() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    shift_svc::close_shift(&conn, &staff, 0).unwrap();
    // The cashier cannot close the business day, nor read its closing preview.
    assert!(shift_svc::close_day(&conn, &staff).is_err());
    assert!(shift_svc::day_close_preview(&conn, &staff).is_err());
    // The manager can.
    assert!(shift_svc::day_close_preview(&conn, &manager).is_ok());
    assert!(shift_svc::close_day(&conn, &manager).is_ok());
}

#[test]
fn the_day_closing_aggregates_a_shared_cash_reconciliation() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();

    // Shift 1 balances, shift 2 is short: the day nets them off.
    let a = shift_svc::open_shift(&conn, &staff, 1_000).unwrap();
    let cash_a = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    shift_svc::close_shift(&conn, &staff, 1_000 + cash_a).unwrap();
    let b = shift_svc::open_shift(&conn, &staff, 500).unwrap();
    let cash_b = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    shift_svc::close_shift(&conn, &staff, 500 + cash_b - 400).unwrap();

    let result = shift_svc::close_day(&conn, &manager).unwrap();
    let c = &result.report.cash;
    assert_eq!(c.opening_cash, 1_500);
    assert_eq!(c.cash_inflows, cash_a + cash_b);
    assert_eq!(c.expected_cash, 1_500 + cash_a + cash_b);
    assert_eq!(c.actual_cash, 1_500 + cash_a + cash_b - 400);
    assert_eq!(c.difference, -400);
    assert_eq!(c.status, CashStatus::Shortage);
    assert_eq!(c.shortage, 400);
    assert_eq!(result.report.included_shift_ids, vec![a, b]);
}

// ---- printing --------------------------------------------------------------

/// Every piece of text the document puts in front of the operator.
///
/// This reads the PREVIEW representation — the same data the on-screen print
/// preview and the ESC/POS output are generated from — rather than decoding
/// printer bytes, so the test asserts what a human actually reads.
fn printed_text(doc: &crate::printing::ir::PrintDoc) -> String {
    use crate::printing::ir::PreviewOp;
    doc.ops
        .iter()
        .flat_map(|op| match op {
            PreviewOp::Text { text, .. } => vec![text.clone()],
            PreviewOp::Financial { label, value, .. } => {
                vec![format!("{label} {value}")]
            }
            PreviewOp::Meta { label, value, .. } => vec![format!("{label} {value}")],
            _ => Vec::new(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn the_printed_shift_closing_carries_every_reconciliation_line() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 10_000).unwrap();
    let cash = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    ops_svc::create_expense(&conn, &staff, &expense_input("UTILITY", 2_500)).unwrap();
    let expected = 10_000 + cash - 2_500;
    shift_svc::close_shift(&conn, &staff, expected - 100).unwrap();

    let report = reconciliation::shift_report(&conn, shift_id).unwrap();
    let doc = crate::printing::templates::shift_closing(
        crate::printing::escpos::ArabicMode::Cp1256,
        0,
        &report,
        false,
    );
    let text = printed_text(&doc);
    for expected_line in [
        "المبيعات",
        "عدد فواتير الكافيه",
        "مبيعات الكافيه",
        "عدد فواتير المغسلة",
        "مبيعات المغسلة",
        "إجمالي الخدمات",
        "إجمالي الخصومات",
        "إجمالي المصروفات",
        "كهرباء ومياه",
        "تسوية العهدة",
        "رصيد افتتاح الوردية",
        "إجمالي النقدية الداخلة",
        "إجمالي المصروفات النقدية",
        "رصيد الإقفال المتوقع",
        "النقدية الفعلية المسلّمة",
        "الفرق",
        "حالة التسوية",
    ] {
        assert!(
            text.contains(expected_line),
            "printed shift closing is missing {expected_line}"
        );
    }
    // The Arabic status word for a shortage, not just a negative number.
    assert!(
        text.contains("عجز"),
        "printed document must state the status"
    );
}

#[test]
fn the_printed_day_closing_reports_only_the_included_shifts() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let day_id = crate::repositories::shifts::current_day(&conn)
        .unwrap()
        .unwrap()
        .id;

    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    let cash = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    shift_svc::close_shift(&conn, &staff, cash).unwrap();
    // An open shift exists but is excluded from the closing.
    shift_svc::open_shift(&conn, &staff, 0).unwrap();
    sell_cafe_cash(&conn, &staff, "مياه");
    shift_svc::close_day(&conn, &manager).unwrap();

    let report = reports::day_report(&conn, day_id).unwrap();
    let doc = crate::printing::templates::day_report(
        crate::printing::escpos::ArabicMode::Cp1256,
        0,
        &report,
        false,
    );
    let text = printed_text(&doc);
    for expected_line in [
        "عدد الورديات المغلقة",
        "ورديات مفتوحة (غير محتسبة)",
        "مبيعات الكافيه",
        "إجمالي الخدمات",
        "إجمالي الخصومات",
        "إجمالي المصروفات",
        "تسوية العهدة",
        "رصيد افتتاح الوردية",
        "رصيد الإقفال المتوقع",
        "النقدية الفعلية المسلّمة",
        "حالة التسوية",
    ] {
        assert!(
            text.contains(expected_line),
            "printed day closing is missing {expected_line}"
        );
    }
    assert_eq!(report.shift_count, 1);
    assert_eq!(report.open_shift_count, 1);
}

// ---- payment fan-out --------------------------------------------------------

/// One invoice settled by TWO payment rows (split cash + card). This is the shape
/// that multiplied every invoice-level figure once per payment row when invoices
/// and payments were joined in a single aggregate.
#[test]
fn an_invoice_with_several_payment_rows_is_counted_once_at_invoice_level() {
    use invoices::InvoiceLine;
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let day_id = shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 0).unwrap();

    // A normal single-payment sale: the baseline that must not move.
    let baseline = sell_cafe_cash(&conn, &staff, "مياه");
    let baseline_total = invoice_total(&conn, baseline);

    // A second invoice for the same order, settled with two payment rows.
    let order_id: i64 = conn
        .query_row(
            "SELECT order_id FROM invoices WHERE id = ?1",
            [baseline],
            |r| r.get(0),
        )
        .unwrap();
    let subtotal = 10_000;
    let discount = 1_000;
    let service = 2_000;
    let total = subtotal - discount + service;
    let cash_part = 4_000;
    let lines = vec![InvoiceLine {
        department: "CAFE".into(),
        product_name: "مياه".into(),
        unit_price: subtotal,
        quantity: 1,
        discount_minor: 0,
        line_total: subtotal,
    }];
    let split = invoices::insert_invoice(
        &conn,
        invoices::next_invoice_no(&conn).unwrap(),
        order_id,
        None,
        day_id,
        Some(shift_id),
        staff.id,
        "TABLE",
        None,
        None,
        subtotal,
        discount,
        Some("FIXED"),
        Some(discount),
        service,
        total,
        subtotal,
        0,
        &lines,
    )
    .unwrap();
    invoices::insert_payment(&conn, split, "CASH", cash_part, None, None, staff.id).unwrap();
    invoices::insert_payment(
        &conn,
        split,
        "CARD",
        total - cash_part,
        None,
        None,
        staff.id,
    )
    .unwrap();
    invoices::apply_payment_to_invoice(&conn, split, total).unwrap();

    let report = reconciliation::shift_report(&conn, shift_id).unwrap();
    // Counts and invoice-level money belong to the DOCUMENT: two invoices, never
    // one per payment row.
    assert_eq!(report.invoices_count, 2);
    assert_eq!(report.areas.cafe_invoices, 2);
    assert_eq!(
        report.areas.cafe_invoices + report.areas.wash_invoices + report.areas.hybrid_invoices,
        report.invoices_count
    );
    assert_eq!(
        report.subtotal,
        baseline_total + subtotal,
        "subtotal double-counted"
    );
    assert_eq!(report.discounts, discount, "discount double-counted");
    assert_eq!(
        report.service_charges, service,
        "service charge double-counted"
    );
    assert_eq!(
        report.total_sales,
        baseline_total + total,
        "total double-counted"
    );
    // Money per method is the sum of the payment ROWS.
    assert_eq!(report.cash_sales, baseline_total + cash_part);
    assert_eq!(report.card_sales, total - cash_part);
    assert_eq!(report.credit_sales, 0);
    assert_eq!(
        report.cash_sales + report.card_sales + report.credit_sales,
        report.total_sales
    );
}

// ---- area classification edge cases ----------------------------------------

/// The three buckets must partition EVERY invoice. A document whose lines are all
/// zero-priced (a free item plus a service charge) carries no department MONEY at
/// all, yet it is still a document of the departments it contains — the money
/// based definition could not classify it and the counts stopped adding up.
#[test]
fn area_counts_partition_every_invoice_including_zero_money_documents() {
    use invoices::InvoiceLine;
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let day_id = shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 0).unwrap();
    let seed = sell_cafe_cash(&conn, &staff, "مياه");
    let order_id: i64 = conn
        .query_row("SELECT order_id FROM invoices WHERE id = ?1", [seed], |r| {
            r.get(0)
        })
        .unwrap();

    let free_line = |dept: &str| InvoiceLine {
        department: dept.into(),
        product_name: "هدية".into(),
        unit_price: 0,
        quantity: 1,
        discount_minor: 0,
        line_total: 0,
    };
    let insert_free = |dept: &str| {
        let id = invoices::insert_invoice(
            &conn,
            invoices::next_invoice_no(&conn).unwrap(),
            order_id,
            None,
            day_id,
            Some(shift_id),
            staff.id,
            "TABLE",
            None,
            None,
            0,
            0,
            None,
            None,
            2_000,
            2_000,
            0,
            0,
            &[free_line(dept)],
        )
        .unwrap();
        invoices::insert_payment(&conn, id, "CASH", 2_000, None, None, staff.id).unwrap();
        id
    };
    insert_free("CAFE");
    insert_free("WASH");

    let report = reconciliation::shift_report(&conn, shift_id).unwrap();
    // The seeded sale plus the two zero-money documents: three documents.
    assert_eq!(report.invoices_count, 3);
    assert_eq!(
        report.areas.cafe_invoices, 2,
        "a zero-priced cafe line is still a cafe invoice"
    );
    assert_eq!(
        report.areas.wash_invoices, 1,
        "a zero-priced wash line is still a wash invoice"
    );
    assert_eq!(report.areas.hybrid_invoices, 0);
    assert_eq!(
        report.areas.cafe_invoices + report.areas.wash_invoices + report.areas.hybrid_invoices,
        report.invoices_count
    );
    // Department MONEY stays the sum of the persisted invoice columns…
    assert_eq!(report.cafe_sales, invoice_total(&conn, seed));
    assert_eq!(report.wash_sales, 0);
    // …and the service charge of the free documents is its own explicit line.
    assert_eq!(report.service_charges, 4_000);
    assert_eq!(report.total_sales, invoice_total(&conn, seed) + 4_000);
}

// ---- day-level (shift-less) manager expenses --------------------------------

/// A manager spend that belongs to no till is part of the DAY's expenses, so the
/// day closing must report it — and it must never reduce a drawer or be counted
/// twice.
#[test]
fn a_day_level_manager_expense_enters_the_day_closing_exactly_once() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let day_id = shift_svc::open_day(&conn, &manager).unwrap();

    // The manager owns no shift: this expense belongs to the day, not a drawer.
    let day_expense =
        ops_svc::create_expense(&conn, &manager, &expense_input("UTILITY", 3_000)).unwrap();
    let stored = expenses::list_for_day_without_shift(&conn, day_id).unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].shift_id, None);

    // A settled shift with its own sale and its own cash expense.
    shift_svc::open_shift(&conn, &staff, 5_000).unwrap();
    let cash = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    ops_svc::create_expense(&conn, &staff, &expense_input("SUPPLIES", 1_000)).unwrap();
    shift_svc::close_shift(&conn, &staff, 5_000 + cash - 1_000).unwrap();

    let preview = shift_svc::day_close_preview(&conn, &manager).unwrap();
    assert_eq!(
        preview.report.expenses, 4_000,
        "the day expense is in the preview"
    );
    assert_eq!(
        preview.report.cash_expenses, 1_000,
        "only the shift's own cash expense left a drawer"
    );

    let result = shift_svc::close_day(&conn, &manager).unwrap();
    assert_eq!(result.report.expenses, 4_000);
    assert_eq!(result.report.cash_expenses, 1_000);
    assert_eq!(result.report.cash.cash_outflows, 1_000);
    // The day-level spend belongs to no drawer, so the drawer is untouched.
    assert_eq!(result.report.cash.expected_cash, 5_000 + cash - 1_000);
    // The breakdown still sums to the total shown next to it.
    let breakdown: i64 = result
        .report
        .expense_breakdown
        .iter()
        .map(|r| r.amount)
        .sum();
    assert_eq!(breakdown, 4_000);

    // The claim is recorded exactly once…
    let claimed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM day_closing_expenses WHERE expense_id = ?1",
            [day_expense],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(claimed, 1);

    // …and the historical report keeps reporting it exactly once, whatever is
    // recorded afterwards.
    let report = reports::day_report(&conn, day_id).unwrap();
    assert_eq!(report.expenses, 4_000);
    assert_eq!(
        report
            .expense_breakdown
            .iter()
            .map(|r| r.amount)
            .sum::<i64>(),
        4_000
    );
    ops_svc::create_expense(&conn, &manager, &expense_input("OTHER", 9_999)).unwrap();
    let after = reports::day_report(&conn, day_id).unwrap();
    assert_eq!(
        after.expenses, 4_000,
        "a later expense never moves a closed day"
    );
}

/// The manager's warning must state the money that is being left out, so the
/// excluded amount comes from the open shift's LIVE figures.
#[test]
fn the_open_shift_warning_reports_the_excluded_money() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 1_000).unwrap();
    let cash = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    ops_svc::create_expense(&conn, &staff, &expense_input("OTHER", 700)).unwrap();

    let preview = shift_svc::day_close_preview(&conn, &manager).unwrap();
    assert_eq!(preview.open_shifts.len(), 1);
    assert_eq!(preview.open_shifts[0].cash_sales, cash);
    assert_eq!(preview.open_shifts[0].expenses, 700);
    // Nothing settled → nothing in the closing itself.
    assert_eq!(preview.report.shift_count, 0);
    assert_eq!(preview.report.expenses, 0);
}

/// The live operational header must agree with the POS card, and it accounts for
/// every invoice the day actually raised.
#[test]
fn the_live_day_view_matches_the_shift_drawer() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 5_000).unwrap();
    let first = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    let second = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "هوت شوكليت"));
    ops_svc::create_expense(&conn, &staff, &expense_input("OTHER", 500)).unwrap();

    let summary = reports::today_summary(&conn).unwrap();
    assert_eq!(summary.totals.cash, first + second);
    assert_eq!(
        summary.expected_drawer_cash,
        5_000 + first + second - 500,
        "the open shift's cash expense must reduce the live drawer"
    );
    // The header and the shift card are the same figure, from the same formula.
    assert_eq!(
        summary.shifts[0].expected_cash,
        summary.expected_drawer_cash
    );
}

// ---- printing width & language ---------------------------------------------

/// Every rendered line of a closing document, in the order the printer receives
/// it. `PreviewOp::Text` carries the composed physical line for `line`/`kv_line`.
fn printed_lines(doc: &crate::printing::ir::PrintDoc) -> Vec<String> {
    use crate::printing::ir::PreviewOp;
    doc.ops
        .iter()
        .filter_map(|op| match op {
            PreviewOp::Text { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn every_printed_closing_line_fits_the_printer_width() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let day_id = shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 10_000).unwrap();
    let cash = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    ops_svc::create_expense(&conn, &staff, &expense_input("UTILITY", 2_500)).unwrap();
    shift_svc::close_shift(&conn, &staff, 10_000 + cash - 2_500 - 100).unwrap();
    shift_svc::close_day(&conn, &manager).unwrap();

    let shift_report = reconciliation::shift_report(&conn, shift_id).unwrap();
    let shift_doc = crate::printing::templates::shift_closing(
        crate::printing::escpos::ArabicMode::Cp1256,
        0,
        &shift_report,
        false,
    );
    for line in printed_lines(&shift_doc) {
        assert!(
            line.chars().count() <= crate::printing::templates::WIDTH,
            "shift closing line is wider than the printer: {line:?}"
        );
    }

    let mut day = reports::day_report(&conn, day_id).unwrap();
    // The worst case: an operator whose name is far longer than the column.
    day.shifts[0].user_name = Some("عبدالرحمن محمد عبدالحميد الطويل جدًا".into());
    let day_doc = crate::printing::templates::day_report(
        crate::printing::escpos::ArabicMode::Cp1256,
        0,
        &day,
        false,
    );
    for line in printed_lines(&day_doc) {
        assert!(
            line.chars().count() <= crate::printing::templates::WIDTH,
            "day closing line is wider than the printer: {line:?}"
        );
    }
    // The shift list names the state in Arabic, never the stored status code.
    let text = printed_text(&day_doc);
    assert!(text.contains("مغلقة"), "the shift list must be Arabic");
    assert!(
        !text.contains("| CLOSED |"),
        "the stored status code must never reach the paper"
    );
}

#[test]
fn the_printed_settlement_status_uses_the_backends_own_magnitudes() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 0).unwrap();
    let cash = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    // Short by 1.25, then over by 2.00 in a second shift.
    shift_svc::close_shift(&conn, &staff, cash - 125).unwrap();
    let short = reconciliation::shift_report(&conn, shift_id).unwrap();
    let short_doc = crate::printing::templates::shift_closing(
        crate::printing::escpos::ArabicMode::Cp1256,
        0,
        &short,
        false,
    );
    let text = printed_text(&short_doc);
    assert_eq!(short.cash.status, CashStatus::Shortage);
    assert!(
        text.contains("عجز 1.25"),
        "the shortage magnitude is printed"
    );

    let second = shift_svc::open_shift(&conn, &staff, 0).unwrap();
    let cash_b = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    shift_svc::close_shift(&conn, &staff, cash_b + 200).unwrap();
    let over = reconciliation::shift_report(&conn, second).unwrap();
    let over_doc = crate::printing::templates::shift_closing(
        crate::printing::escpos::ArabicMode::Cp1256,
        0,
        &over,
        false,
    );
    let text = printed_text(&over_doc);
    assert_eq!(over.cash.status, CashStatus::Surplus);
    assert!(
        text.contains("زيادة 2.00"),
        "the surplus magnitude is printed"
    );
    assert!(
        !text.contains("عجز"),
        "a surplus is never labelled a shortage"
    );
}

/// A closed shift's expense figures AND its category breakdown are read from the
/// closing snapshot, never from live `expenses` rows.
///
/// Regression for a real defect: the document used to rebuild both with a live
/// query every time it was printed, so a row that changed after the closing
/// silently moved a document the cashier had already signed — and the printed
/// TOTAL and the printed BREAKDOWN could come from two different moments.
#[test]
fn a_closed_shift_document_ignores_expense_rows_changed_after_the_closing() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 10_000).unwrap();
    let cash = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    ops_svc::create_expense(&conn, &staff, &expense_input("UTILITY", 2_000)).unwrap();
    shift_svc::close_shift(&conn, &staff, 10_000 + cash - 2_000).unwrap();

    let before = reconciliation::shift_report(&conn, shift_id).unwrap();
    assert_eq!(before.expenses, 2_000);
    assert_eq!(before.expense_breakdown.len(), 1);
    assert_eq!(before.expense_breakdown[0].category_name, "كهرباء ومياه");

    // Data that changed after the shift was closed: the row's amount AND its
    // category both move. Neither may reach the document.
    conn.execute(
        "UPDATE expenses SET amount = 9_999, category = 'SALARY' WHERE shift_id = ?1",
        [shift_id],
    )
    .unwrap();
    conn.execute(
        "UPDATE expense_categories SET name_ar = 'اسم جديد' WHERE code = 'UTILITY'",
        [],
    )
    .unwrap();

    let after = reconciliation::shift_report(&conn, shift_id).unwrap();
    assert_eq!(after.expenses, 2_000, "the snapshot total is frozen");
    assert_eq!(
        after.cash_expenses, 2_000,
        "the snapshot cash part is frozen"
    );
    assert_eq!(after.cash.expected_cash, 10_000 + cash - 2_000);
    assert_eq!(after.cash.actual_cash, 10_000 + cash - 2_000);
    assert_eq!(after.cash.status, CashStatus::Balanced);
    assert_eq!(after.expense_breakdown.len(), 1);
    assert_eq!(
        after.expense_breakdown[0].category, "UTILITY",
        "the breakdown is the closing snapshot, not today's rows"
    );
    assert_eq!(
        after.expense_breakdown[0].category_name, "كهرباء ومياه",
        "the Arabic label is frozen at closing time"
    );
    assert_eq!(after.expense_breakdown[0].amount, 2_000);
}

/// The same rule one level up: a CLOSED DAY's breakdown is its own snapshot, so
/// the printed total and the printed category lines can never disagree.
#[test]
fn a_closed_day_breakdown_is_the_closing_snapshot_not_a_live_query() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let day_id = shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 5_000).unwrap();
    let cash = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    ops_svc::create_expense(&conn, &staff, &expense_input("SUPPLIES", 1_000)).unwrap();
    shift_svc::close_shift(&conn, &staff, 5_000 + cash - 1_000).unwrap();
    shift_svc::close_day(&conn, &manager).unwrap();

    // A row attached to the closed day AFTER its closing, and a renamed label.
    conn.execute(
        "INSERT INTO expenses (category, amount, expense_date, business_day_id, user_id)
         SELECT 'OTHER', 7_777, '2026-09-26', ?1, id FROM users WHERE role = 'MANAGER' LIMIT 1",
        [day_id],
    )
    .unwrap();
    conn.execute(
        "UPDATE expense_categories SET name_ar = 'مشتريات معدّلة' WHERE code = 'SUPPLIES'",
        [],
    )
    .unwrap();

    let report = reports::day_report(&conn, day_id).unwrap();
    assert_eq!(report.expenses, 1_000, "the snapshot total is frozen");
    assert_eq!(report.expense_breakdown.len(), 1);
    assert_eq!(report.expense_breakdown[0].amount, 1_000);
    assert_eq!(report.expense_breakdown[0].category, "SUPPLIES");
    assert_eq!(
        report.expense_breakdown[0].category_name, "مشتريات",
        "the printed label is the one that was true at closing"
    );
    // The breakdown still adds up to the total printed beside it.
    let sum: i64 = report.expense_breakdown.iter().map(|r| r.amount).sum();
    assert_eq!(sum, report.expenses);
}

/// The day closing is built from the INCLUDED shifts' own snapshots, so its
/// expense total is the sum of the individual shift documents — never a second
/// live aggregation that could disagree with them.
#[test]
fn the_day_expense_total_is_the_sum_of_the_included_shift_snapshots() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();

    let mut ids = Vec::new();
    let mut expected = 0;
    for (opening, expense) in [(1_000, 1_500), (2_000, 2_500), (500, 300)] {
        let id = shift_svc::open_shift(&conn, &staff, opening).unwrap();
        ops_svc::create_expense(&conn, &staff, &expense_input("UTILITY", expense)).unwrap();
        let cash = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
        shift_svc::close_shift(&conn, &staff, opening + cash - expense).unwrap();
        ids.push(id);
        expected += expense;
    }

    let result = shift_svc::close_day(&conn, &manager).unwrap();
    assert_eq!(result.report.included_shift_ids, ids);
    assert_eq!(result.report.expenses, expected);
    let from_shifts: i64 = result.report.shifts.iter().map(|s| s.expenses).sum();
    assert_eq!(
        from_shifts, expected,
        "the day total is the sum of the shifts' own snapshots"
    );
    let breakdown: i64 = result
        .report
        .expense_breakdown
        .iter()
        .map(|r| r.amount)
        .sum();
    assert_eq!(breakdown, expected, "the breakdown sums to the total");
    assert_eq!(
        result.report.expense_breakdown[0].count, 3,
        "one category line covering all three shifts"
    );
}

/// Sell one cafe item on credit. It creates a payment row of method CREDIT, so
/// it must be reported as credit money — and must never reach the drawer.
fn sell_credit(conn: &Connection, actor: &auth::User, manager: &auth::User) -> i64 {
    // Credit is an explicit, manager-authorized customer relationship.
    let customer_id =
        crate::repositories::customers::insert(conn, "شركة النور", Some("01111111111"), None)
            .unwrap();
    crate::services::settings::set_credit_config(
        conn,
        manager,
        &crate::services::settings::CreditConfig {
            enabled: true,
            mode: "LIST".into(),
            allowed_customer_ids: vec![customer_id],
        },
    )
    .unwrap();
    let table = pos::list_tables(conn, None).unwrap().remove(0);
    pos_svc::open_table(conn, actor, table.id).unwrap();
    let order_id = pos_svc::start_order(conn, actor, table.id).unwrap();
    pos_svc::add_line(conn, actor, order_id, cafe_product(conn, "مياه"), 1).unwrap();
    pos_svc::attach_customer(conn, order_id, customer_id, None).unwrap();
    checkout::checkout(
        conn,
        actor,
        &checkout::CheckoutInput {
            order_id,
            method: "CREDIT".into(),
            discount_mode: None,
            discount_value: None,
            discount_pin: None,
            service_charge_minor: None,
            received: None,
        },
    )
    .unwrap()
    .invoice_id
}

/// A credit sale is a payment of method CREDIT, everywhere. The live day header
/// used to re-derive it from `invoices.status` instead, which is a second
/// expression of the same business fact; both must now follow the payment rows.
#[test]
fn the_live_day_header_and_the_closing_agree_on_credit() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    let day_id = shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 0).unwrap();

    let cash_invoice = sell_cafe_cash(&conn, &staff, "مياه");
    let credit = sell_credit(&conn, &staff, &manager);
    let cash_total = invoice_total(&conn, cash_invoice);
    let credit_total = invoice_total(&conn, credit);
    assert!(credit_total > 0);

    // The live header, before anything is closed.
    let summary = reports::today_summary(&conn).unwrap();
    assert_eq!(summary.totals.cash, cash_total);
    assert_eq!(summary.totals.credit, credit_total);
    // Credit money never entered the drawer.
    assert_eq!(summary.expected_drawer_cash, cash_total);

    shift_svc::close_shift(&conn, &staff, cash_total).unwrap();
    let result = shift_svc::close_day(&conn, &manager).unwrap();
    assert_eq!(result.totals.credit, credit_total);
    assert_eq!(result.report.cash.cash_inflows, cash_total);
    let stored = reports::day_report(&conn, day_id).unwrap();
    assert_eq!(stored.credit_sales, credit_total);
}

/// Scenario H, continued: the special case where a day has no settled shift is
/// blocked — and the business day must NOT be left in an impossible state. The
/// running shift can still be closed and the day then closed normally.
#[test]
fn a_day_blocked_for_lack_of_a_settled_shift_can_still_be_closed_afterwards() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &staff, 4_000).unwrap();
    let cash = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));
    ops_svc::create_expense(&conn, &staff, &expense_input("OTHER", 400)).unwrap();

    // Blocked, and the day is untouched: still open, still owning the shift.
    assert!(shift_svc::close_day(&conn, &manager).is_err());
    assert!(shifts_repo::current_day(&conn).unwrap().is_some());
    let still_active = shifts_repo::get_shift(&conn, shift_id).unwrap().unwrap();
    assert_eq!(still_active.status, "ACTIVE", "the shift was not settled");

    // The cashier closes the shift, and the SAME day then closes normally.
    shift_svc::close_shift(&conn, &staff, 4_000 + cash - 400).unwrap();
    let result = shift_svc::close_day(&conn, &manager).unwrap();
    assert_eq!(result.report.included_shift_ids, vec![shift_id]);
    assert_eq!(result.report.expenses, 400);
    assert_eq!(result.report.cash.expected_cash, 4_000 + cash - 400);
    assert_eq!(result.report.cash.status, CashStatus::Balanced);
}

/// Scenario I, and the read → calculate → write gap of the closing transaction:
/// the dialog shows one expected cash, but the shift is closed AFTER a further
/// expense is booked. The closing must recompute inside its own transaction, so
/// the persisted document reflects the state at COMMIT — not the stale preview.
#[test]
fn a_shift_closing_persists_the_state_at_commit_not_a_stale_preview() {
    let conn = fresh();
    let manager = login(&conn, "manager", "manager123");
    let staff = login(&conn, "cashier", "cashier123");
    shift_svc::open_day(&conn, &manager).unwrap();
    shift_svc::open_shift(&conn, &staff, 10_000).unwrap();
    let cash = invoice_total(&conn, sell_cafe_cash(&conn, &staff, "مياه"));

    // What the cashier saw when the dialog opened.
    let preview = shift_svc::preview_shift_close(&conn, &staff).unwrap();
    assert_eq!(preview.expected_cash, 10_000 + cash);

    // …then a further cash expense is booked before they confirm.
    ops_svc::create_expense(&conn, &staff, &expense_input("UTILITY", 1_500)).unwrap();

    // The closing is computed at commit, so the extra expense IS in it.
    let expected = 10_000 + cash - 1_500;
    let closing = shift_svc::close_shift(&conn, &staff, expected).unwrap();
    assert_eq!(closing.expected_cash, expected);
    assert_eq!(closing.difference, 0);
    assert_eq!(closing.report.expenses, 1_500);
    assert_eq!(closing.report.cash.cash_outflows, 1_500);
    assert_eq!(closing.report.cash.status, CashStatus::Balanced);

    // And the stored document agrees — a stale preview cannot rewrite it.
    let stored = reconciliation::shift_report(&conn, closing.shift.id).unwrap();
    assert_eq!(stored.cash.expected_cash, expected);
    assert_eq!(stored.cash.actual_cash, expected);
    assert_eq!(stored.expenses, 1_500);
    // A closed shift accepts no further expense at all.
    let err = ops_svc::create_expense(&conn, &staff, &expense_input("OTHER", 900)).unwrap_err();
    assert_eq!(err.kind(), crate::error::ErrorKind::BusinessRule);
}
