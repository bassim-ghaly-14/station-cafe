//! Managerial (on-behalf) shift closure — authorization, state transitions,
//! ownership, financial parity with the cashier's own close, concurrency, the
//! audit distinction and the day-close relationship.
//!
//! This is the recovery path for a cashier who left without closing their
//! till. It must NEVER become a second financial implementation: every parity
//! assertion below exists so the managerial close cannot drift from the
//! cashier's close in any figure the closing documents report.

use crate::db::migrate;
use crate::demo_data::seed_for_development as run_if_empty;
use crate::error::ErrorKind;
use crate::repositories::{catalog, expenses, invoices, pos, shifts as shifts_repo};
use crate::services::reconciliation;
use crate::services::{auth, checkout, ops as ops_svc, pos as pos_svc, shifts as shift_svc};
use rusqlite::{params, Connection};

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

/// A manager, a cashier, one OPEN day and one ACTIVE cashier shift with a
/// cash sale in it — the state a forgotten shift actually looks like.
fn open_forgotten_shift(conn: &Connection) -> (auth::User, auth::User, i64) {
    let manager = login(conn, "manager", "2345");
    let cashier = login(conn, "cashier", "3456");
    shift_svc::open_day(conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(conn, &cashier, 5_000).unwrap();
    sell_cafe_cash(conn, &cashier, "مياه");
    (manager, cashier, shift_id)
}

// ---- authorization ----------------------------------------------------------

#[test]
fn admin_can_close_another_cashiers_open_shift() {
    let conn = fresh();
    let admin = login(&conn, "admin", "1234");
    let cashier = login(&conn, "cashier", "3456");
    shift_svc::open_day(&conn, &admin).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &cashier, 5_000).unwrap();
    sell_cafe_cash(&conn, &cashier, "مياه");
    let expected = shift_svc::preview_managed_shift_close(&conn, &admin, shift_id)
        .unwrap()
        .expected_cash;

    let closed = shift_svc::close_managed_shift(&conn, &admin, shift_id, expected).unwrap();

    // The shift belongs to the CASHIER and is recorded as closed by the ADMIN.
    assert_eq!(closed.shift.user_id, cashier.id);
    assert_eq!(closed.shift.status, "CLOSED");
    let row = shifts_repo::get_shift(&conn, shift_id).unwrap().unwrap();
    assert_eq!(row.user_id, cashier.id, "the owner must never be rewritten");
    assert_eq!(
        row.closed_by,
        Some(admin.id),
        "the actor is recorded separately"
    );
    assert_eq!(row.closed_by_name.as_deref(), Some("admin"));
}

#[test]
fn manager_can_close_another_cashiers_open_shift() {
    let conn = fresh();
    let (manager, cashier, shift_id) = open_forgotten_shift(&conn);
    let expected = shift_svc::preview_managed_shift_close(&conn, &manager, shift_id)
        .unwrap()
        .expected_cash;

    let closed = shift_svc::close_managed_shift(&conn, &manager, shift_id, expected).unwrap();

    assert_eq!(closed.shift.user_id, cashier.id);
    assert_eq!(closed.shift.status, "CLOSED");
    let row = shifts_repo::get_shift(&conn, shift_id).unwrap().unwrap();
    assert_eq!(row.user_id, cashier.id);
    assert_eq!(row.closed_by, Some(manager.id));
    assert_eq!(row.closed_by_name.as_deref(), Some("manager"));
}

#[test]
fn staff_cannot_close_a_shift_managerially() {
    let conn = fresh();
    let (manager, cashier, shift_id) = open_forgotten_shift(&conn);

    // Every entry point of the managerial flow refuses STAFF — including a
    // cashier trying it on their OWN shift, because the ROLE is the gate, not
    // the ownership.
    for err in [
        shift_svc::close_managed_shift(&conn, &cashier, shift_id, 0).unwrap_err(),
        shift_svc::preview_managed_shift_close(&conn, &cashier, shift_id).unwrap_err(),
        shift_svc::open_shift_detail(&conn, &cashier).unwrap_err(),
    ] {
        assert_eq!(err.kind(), ErrorKind::Unauthorized);
    }
    assert!(
        ops_svc::expenses_of_shift(&conn, &cashier, shift_id).is_err(),
        "the manager's expense review list is not a STAFF read either"
    );

    // Nothing moved: the shift is still open and the manager's own read works.
    let row = shifts_repo::get_shift(&conn, shift_id).unwrap().unwrap();
    assert_eq!(row.status, "ACTIVE");
    assert_eq!(row.closed_by, None);
    assert!(shift_svc::open_shift_detail(&conn, &manager)
        .unwrap()
        .is_some());
}

#[test]
fn an_unauthenticated_caller_cannot_reach_the_flow() {
    let conn = fresh();
    // The exact resolution every command performs first (`authorized` →
    // `require_user`): a token that does not exist never becomes a User, so no
    // service entry point is reachable without an authenticated identity.
    assert!(auth::require_user(&conn, "not-a-real-token").is_err());
}

#[test]
fn an_inactive_account_cannot_perform_the_operation() {
    let conn = fresh();
    let cashier = login(&conn, "cashier", "3456");
    let session = auth::login(
        &conn,
        &auth::LoginInput {
            name: "cashier".into(),
            password: "3456".into(),
        },
    )
    .unwrap();

    // The session is valid while the employee is active…
    assert_eq!(
        auth::require_user(&conn, &session.token).unwrap().id,
        cashier.id
    );

    // …and dies the moment the EMPLOYEE record is stopped — the exact check the
    // command layer runs before any service (managerial close included) sees a user.
    conn.execute(
        "UPDATE employees SET status = 'INACTIVE' WHERE user_id = ?1",
        params![cashier.id],
    )
    .unwrap();
    assert!(auth::require_user(&conn, &session.token).is_err());
}

// ---- state ------------------------------------------------------------------

#[test]
fn an_already_closed_shift_is_rejected_and_never_closed_twice() {
    let conn = fresh();
    let (manager, _cashier, shift_id) = open_forgotten_shift(&conn);
    let expected = shift_svc::preview_managed_shift_close(&conn, &manager, shift_id)
        .unwrap()
        .expected_cash;
    shift_svc::close_managed_shift(&conn, &manager, shift_id, expected).unwrap();

    // A second managerial attempt fails with the deterministic state error…
    let err = shift_svc::close_managed_shift(&conn, &manager, shift_id, 9_999).unwrap_err();
    match err {
        crate::error::AppError::BusinessRule(code) => assert_eq!(code, "shift.not_closable"),
        other => panic!("expected a business-rule refusal, got {other:?}"),
    }
    // …the preview refuses too, so no dialog can be reopened against it…
    let err = shift_svc::preview_managed_shift_close(&conn, &manager, shift_id).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::BusinessRule);
    // …and the rejected attempts left the FIRST closing's figures untouched.
    let row = shifts_repo::get_shift(&conn, shift_id).unwrap().unwrap();
    assert_eq!(row.expected_cash, expected);
    assert_eq!(row.actual_cash, Some(expected));
    assert_eq!(row.closed_by, Some(manager.id));
}

#[test]
fn a_shift_that_does_not_exist_is_reported_as_not_found() {
    let conn = fresh();
    let manager = login(&conn, "manager", "2345");
    let err = shift_svc::close_managed_shift(&conn, &manager, 999_999, 0).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::NotFound);
    let err = shift_svc::preview_managed_shift_close(&conn, &manager, 999_999).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::NotFound);
}

// ---- financial parity -------------------------------------------------------

/// The figures a closing reports — everything a drift between the two paths
/// could ever move. Comparing WHOLE sets (not a single number) is what makes
/// the parity claim meaningful.
#[derive(Debug, PartialEq, Eq)]
struct Figures {
    expected_cash: i64,
    difference: i64,
    invoices: i64,
    total_sales: i64,
    cash: i64,
    card: i64,
    credit: i64,
    expenses: i64,
    drawer_expected: i64,
    drawer_actual: i64,
    drawer_difference: i64,
    status: reconciliation::CashStatus,
}

fn figures(c: &shift_svc::ShiftClosing) -> Figures {
    Figures {
        expected_cash: c.expected_cash,
        difference: c.difference,
        invoices: c.report.invoices_count,
        total_sales: c.report.total_sales,
        cash: c.report.cash_sales,
        card: c.report.card_sales,
        credit: c.report.credit_sales,
        expenses: c.report.expenses,
        drawer_expected: c.report.cash.expected_cash,
        drawer_actual: c.report.cash.actual_cash,
        drawer_difference: c.report.cash.difference,
        status: c.report.cash.status,
    }
}

/// The identical scenario, closed by the cashier themself.
fn self_close_scenario() -> Figures {
    let conn = fresh();
    let manager = login(&conn, "manager", "2345");
    let cashier = login(&conn, "cashier", "3456");
    shift_svc::open_day(&conn, &manager).unwrap();
    let shift_id = shift_svc::open_shift(&conn, &cashier, 5_000).unwrap();
    let invoice = sell_cafe_cash(&conn, &cashier, "مياه");
    assert!(invoice_total(&conn, invoice) > 0);
    let expected = shift_svc::preview_shift_close(&conn, &cashier)
        .unwrap()
        .expected_cash;
    let closed = shift_svc::close_shift(&conn, &cashier, expected).unwrap();
    assert_eq!(closed.shift.id, shift_id);
    figures(&closed)
}

/// The identical scenario, closed by a MANAGER on the cashier's behalf.
fn managerial_close_scenario() -> Figures {
    let conn = fresh();
    let (manager, _cashier, shift_id) = open_forgotten_shift(&conn);
    let expected = shift_svc::preview_managed_shift_close(&conn, &manager, shift_id)
        .unwrap()
        .expected_cash;
    let closed = shift_svc::close_managed_shift(&conn, &manager, shift_id, expected).unwrap();
    figures(&closed)
}

#[test]
fn a_managerial_close_records_exactly_what_a_self_close_would() {
    let me = self_close_scenario();
    let on_behalf = managerial_close_scenario();
    assert_eq!(
        me, on_behalf,
        "the closer's identity must not move a single figure"
    );
    // And the drawer verdict is the same balanced state in both paths.
    assert_eq!(me.status, reconciliation::CashStatus::Balanced);
}

// ---- concurrency ------------------------------------------------------------

#[test]
fn only_one_closure_wins_and_every_loser_sees_a_state_error() {
    let conn = fresh();
    let (manager, cashier, shift_id) = open_forgotten_shift(&conn);

    // The repository guard admits a single writer: the second UPDATE matches
    // zero rows because the shift is no longer ACTIVE — the database-level rule
    // that makes a double close structurally impossible.
    let totals = shifts_repo::compute_shift_totals(&conn, shift_id).unwrap();
    let (exp, cash_exp) = expenses::shift_totals(&conn, shift_id).unwrap();
    assert!(
        shifts_repo::save_shift_closing(
            &conn,
            shift_id,
            &totals,
            exp,
            cash_exp,
            100,
            100,
            "2026-09-25 12:00:00",
            "[]",
            manager.id,
        )
        .unwrap(),
        "the first close must win"
    );
    assert!(
        !shifts_repo::save_shift_closing(
            &conn,
            shift_id,
            &totals,
            exp,
            cash_exp,
            100,
            100,
            "2026-09-25 12:00:01",
            "[]",
            cashier.id,
        )
        .unwrap(),
        "the second close must lose"
    );
    let row = shifts_repo::get_shift(&conn, shift_id).unwrap().unwrap();
    assert_eq!(
        row.closed_by,
        Some(manager.id),
        "the FIRST close owns the row"
    );

    // At service level, both kinds of loser get a deterministic state error.
    let err = shift_svc::close_managed_shift(&conn, &manager, shift_id, 0).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::BusinessRule);
    let err = shift_svc::close_shift(&conn, &cashier, 0).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::BusinessRule);
}

// ---- day-close relationship -------------------------------------------------

#[test]
fn a_managerial_closure_unblocks_the_day_close_including_the_money_once() {
    let conn = fresh();
    let (manager, _cashier, shift_id) = open_forgotten_shift(&conn);
    let cash_sales = shifts_repo::compute_shift_totals(&conn, shift_id)
        .unwrap()
        .cash;
    assert!(cash_sales > 0);

    // While the forgotten shift is open, the day cannot be closed — the
    // existing safety rule is NOT bypassed by this feature.
    let err = shift_svc::close_day(&conn, &manager).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::BusinessRule);

    // The managerial close is exactly what unblocks it…
    let expected = shift_svc::preview_managed_shift_close(&conn, &manager, shift_id)
        .unwrap()
        .expected_cash;
    shift_svc::close_managed_shift(&conn, &manager, shift_id, expected).unwrap();

    // …and the day then closes with this shift's money included EXACTLY once.
    let day = shift_svc::close_day(&conn, &manager).unwrap();
    assert_eq!(day.report.shift_count, 1);
    assert_eq!(day.report.included_shift_ids, vec![shift_id]);
    assert_eq!(day.totals.cash, cash_sales);
}

// ---- business date ----------------------------------------------------------

#[test]
fn a_managerial_close_never_moves_the_shift_to_another_business_day() {
    let conn = fresh();
    let (manager, _cashier, shift_id) = open_forgotten_shift(&conn);
    let day_id = shifts_repo::current_day(&conn).unwrap().unwrap().id;
    // Put the shift at the very end of its Cairo business day…
    conn.execute(
        "UPDATE shifts SET opened_at = ?2 WHERE id = ?1",
        params![shift_id, "2026-09-24 23:59:00"],
    )
    .unwrap();
    let expected = shift_svc::preview_managed_shift_close(&conn, &manager, shift_id)
        .unwrap()
        .expected_cash;
    // …and close it AFTER midnight: the closing instant crosses the boundary.
    let closed = shift_svc::close_managed_shift_at(
        &conn,
        &manager,
        shift_id,
        expected,
        "2026-09-25 00:30:00",
    )
    .unwrap();

    let row = shifts_repo::get_shift(&conn, shift_id).unwrap().unwrap();
    assert_eq!(row.business_day_id, day_id, "the business day never moves");
    assert_eq!(row.closed_at.as_deref(), Some("2026-09-25 00:30:00"));
    assert_eq!(closed.shift.business_day_id, day_id);
}

// ---- auditability -----------------------------------------------------------

#[test]
fn a_managerial_closure_is_recorded_distinctly_from_a_self_close() {
    let conn = fresh();
    let (manager, cashier, shift_id) = open_forgotten_shift(&conn);
    let expected = shift_svc::preview_managed_shift_close(&conn, &manager, shift_id)
        .unwrap()
        .expected_cash;
    shift_svc::close_managed_shift(&conn, &manager, shift_id, expected).unwrap();

    // The managerial close is its OWN audit action, and its actor is the
    // MANAGER — never the shift owner.
    let (action, actor_id, after): (String, Option<i64>, Option<String>) = conn
        .query_row(
            "SELECT action, actor_id, after_json FROM audit_log
             WHERE entity_type = 'shift' AND entity_id = ?1
             ORDER BY id DESC LIMIT 1",
            params![shift_id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(action, "shift.closed_by_manager");
    assert_eq!(
        actor_id,
        Some(manager.id),
        "the ACTOR, not the owner, is audited"
    );
    let payload: serde_json::Value = serde_json::from_str(&after.unwrap()).unwrap();
    assert_eq!(payload["shift_owner"].as_i64(), Some(cashier.id));
    assert_eq!(payload["closed_by"].as_i64(), Some(manager.id));

    // A cashier's own close keeps its original action — the two remain
    // distinguishable in the operations history forever.
    let conn2 = fresh();
    let (_m2, cashier2, shift2) = open_forgotten_shift(&conn2);
    let expected2 = shift_svc::preview_shift_close(&conn2, &cashier2)
        .unwrap()
        .expected_cash;
    shift_svc::close_shift(&conn2, &cashier2, expected2).unwrap();
    let action2: String = conn2
        .query_row(
            "SELECT action FROM audit_log
             WHERE entity_type = 'shift' AND entity_id = ?1
             ORDER BY id DESC LIMIT 1",
            params![shift2.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(action2, "shift.closed");
}
