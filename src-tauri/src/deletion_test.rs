//! Permanent-deletion tests — employees and customers.
//!
//! Deletion is the only operation in Station that can LOSE history, so this file
//! asserts the two halves of the contract separately:
//!
//!  - **authorization** — ADMIN is allowed; MANAGER and CASHIER are refused by
//!    the SERVICE, not merely by a hidden button. Each refusal also asserts the
//!    row is still there, because "denied" must mean "nothing happened".
//!  - **integrity** — a record that participates in history is REFUSED with a
//!    domain error, and the test then re-reads that history to prove not one row
//!    of it moved. A customer with cars, and an employee with no login, are the
//!    two cases where a real delete is safe and must therefore SUCCEED.
//!
//! Every test runs against a migrated, seeded in-memory database with
//! `foreign_keys = ON`, so the suite exercises the real foreign keys. That
//! matters here: the dependency check in the service is a deliberate, readable
//! pre-check of what SQLite would enforce anyway, and these tests are what prove
//! the two can never disagree.

use crate::db::migrate;
use crate::error::AppError;
use crate::repositories::employee_analytics;
use crate::repositories::employees;
use crate::repositories::{catalog, customers, pos};
use crate::demo_data::seed_for_development as run_if_empty;
use crate::services::attendance::AttendanceAction;
use crate::services::auth::{self, User};
use crate::services::customers as customer_svc;
use crate::services::employees as employee_svc;
use crate::services::{checkout, pos as pos_svc, shifts as shift_svc};
use rusqlite::Connection;

fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    run_if_empty(&conn).unwrap();
    conn
}

fn login(conn: &Connection, name: &str) -> User {
    auth::login(
        conn,
        &auth::LoginInput {
            name: name.into(),
            password: format!("{name}123"),
        },
    )
    .unwrap()
    .user
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

/// Rows returned by a foreign-key check, i.e. every dangling reference left in
/// the database. Zero after a delete is the proof that nothing was orphaned.
fn fk_violations(conn: &Connection) -> i64 {
    let mut stmt = conn.prepare("PRAGMA foreign_key_check").unwrap();
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .unwrap();
    let violations: Vec<(String, i64)> = rows.collect::<Result<_, _>>().unwrap();
    assert!(violations.is_empty(), "dangling references: {violations:?}");
    0
}

/// The `audit_log` rows for one action. Uses a bound parameter, so the action
/// name is data rather than SQL.
fn audit_entries(conn: &Connection, action: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM audit_log WHERE action = ?1",
        [action],
        |r| r.get(0),
    )
    .unwrap()
}

/// A wash worker: no login, ever.
fn wash_worker(conn: &Connection, manager: &User, name: &str) -> i64 {
    employee_svc::create_employee(
        conn,
        manager,
        &employee_svc::EmployeeInput {
            name: name.into(),
            phone: None,
            employee_type: employee_svc::WASH_WORKER.into(),
            base_salary: Some(0),
            notes: None,
            user_id: None,
            role: None,
            password: None,
        },
    )
    .unwrap()
}

/// A cashier employee with a FRESH login that has never been used, so nothing
/// references the account and the delete may take it with the employee.
fn unused_cashier(conn: &Connection, manager: &User, name: &str) -> (i64, i64) {
    let user_id = crate::repositories::users::insert(
        conn,
        &crate::repositories::users::NewUser {
            name,
            phone: None,
            role: "STAFF",
            password_hash: &auth::hash_password("unused123").unwrap(),
            is_seed: false,
        },
    )
    .unwrap()
    .expect("unique login name");
    let employee_id = employee_svc::create_employee(
        conn,
        manager,
        &employee_svc::EmployeeInput {
            name: name.into(),
            phone: None,
            employee_type: employee_svc::CASHIER.into(),
            base_salary: Some(0),
            notes: None,
            user_id: Some(user_id),
            role: None,
            password: None,
        },
    )
    .unwrap();
    (employee_id, user_id)
}

fn new_customer(conn: &Connection, name: &str) -> i64 {
    customers::insert(conn, name, None, None).unwrap()
}

/// Real money against a real customer: open a day and a shift, take an order on a
/// table, add a line, attach the customer, and pay it. Produces a closed invoice
/// whose customer link is genuine business history, not a hand-written row.
fn sell_to(conn: &Connection, customer_id: i64) -> i64 {
    let manager = login(conn, "manager");
    let staff = login(conn, "cashier");
    shift_svc::open_day(conn, &manager).unwrap();
    shift_svc::open_shift(conn, &staff, 50_000).unwrap();
    let table = pos::list_tables(conn, None).unwrap().remove(0);
    pos_svc::open_table(conn, &staff, table.id).unwrap();
    let order_id = pos_svc::start_order(conn, &staff, table.id).unwrap();
    pos_svc::attach_customer(conn, order_id, customer_id, None).unwrap();
    let product = catalog::list(conn, Some("CAFE"), true)
        .unwrap()
        .into_iter()
        .find(|p| p.name == "مياه")
        .expect("seeded cafe product")
        .id;
    pos_svc::add_line(conn, &staff, order_id, product, 1).unwrap();
    checkout::checkout(
        conn,
        &staff,
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

/* ========================================================================== */
/* EMPLOYEE — authorization                                                    */
/* ========================================================================== */

#[test]
fn manager_and_cashier_cannot_delete_an_employee() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let admin = login(&conn, "admin");
    let id = wash_worker(&conn, &manager, "عامل للتجربة");

    for actor in [&manager, &cashier] {
        let err = employee_svc::delete_employee(&conn, actor, id).unwrap_err();
        assert!(
            matches!(err, AppError::Unauthorized(_)),
            "{} must be refused, got {err:?}",
            actor.role
        );
        // A refusal must leave the database exactly as it was.
        assert!(employees::find(&conn, id).unwrap().is_some());
    }

    // The ADMIN the refusals were made against can still delete it, so the guard
    // is about the ROLE and not about the record being undeletable.
    employee_svc::delete_employee(&conn, &admin, id).unwrap();
    assert!(employees::find(&conn, id).unwrap().is_none());
}

#[test]
fn an_employee_cannot_delete_their_own_record() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let own = employees::find_by_user(&conn, admin.id).unwrap().unwrap();

    let err = employee_svc::delete_employee(&conn, &admin, own.id).unwrap_err();
    assert!(matches!(err, AppError::BusinessRule(_)), "{err:?}");
    assert!(employees::find(&conn, own.id).unwrap().is_some());
}

#[test]
fn deleting_an_unknown_employee_is_a_not_found_not_a_silent_success() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    assert!(matches!(
        employee_svc::delete_employee(&conn, &admin, 999_999).unwrap_err(),
        AppError::NotFound(_)
    ));
    assert_eq!(audit_entries(&conn, "employee.deleted"), 0);
}

/* ========================================================================== */
/* EMPLOYEE — integrity                                                       */
/* ========================================================================== */

#[test]
fn an_employee_with_attendance_history_cannot_be_deleted() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let admin = login(&conn, "admin");
    let id = wash_worker(&conn, &manager, "عامل له حضور");

    let recorded =
        employee_svc::record_attendance(&conn, &manager, id, AttendanceAction::CheckIn, None)
            .unwrap();

    let err = employee_svc::delete_employee(&conn, &admin, id).unwrap_err();
    assert!(matches!(err, AppError::BusinessRule(_)), "{err:?}");

    // The employee AND the attendance record are both untouched.
    assert!(employees::find(&conn, id).unwrap().is_some());
    let day = employee_analytics::day_of_employee(&conn, id, &recorded.business_date)
        .unwrap()
        .expect("the attendance day must still be readable");
    assert_eq!(day.state, recorded.state);
}

#[test]
fn an_employee_with_payroll_history_cannot_be_deleted() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let admin = login(&conn, "admin");
    let id = wash_worker(&conn, &manager, "عامل له راتب");

    employee_svc::create_payroll_run(&conn, &manager, id, "2026-01", 0).unwrap();
    let before = count(&conn, "SELECT COUNT(*) FROM payroll_runs");

    let err = employee_svc::delete_employee(&conn, &admin, id).unwrap_err();
    assert!(matches!(err, AppError::BusinessRule(_)), "{err:?}");

    // The payroll snapshot — a money document — is still on disk.
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM payroll_runs"), before);
    assert!(employees::find(&conn, id).unwrap().is_some());
}

#[test]
fn an_employee_with_an_advance_cannot_be_deleted() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let admin = login(&conn, "admin");
    let id = wash_worker(&conn, &manager, "عامل له سلفة");

    employee_svc::create_advance(
        &conn,
        &manager,
        id,
        &employee_svc::AdvanceInput {
            amount: 5_000,
            advance_date: None,
            reason: "سلفة اختبار".into(),
        },
    )
    .unwrap();

    let err = employee_svc::delete_employee(&conn, &admin, id).unwrap_err();
    assert!(matches!(err, AppError::BusinessRule(_)), "{err:?}");
    // The employee survives and the advance is still on the books.
    assert!(employees::find(&conn, id).unwrap().is_some());
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM employee_advances WHERE employee_id = \
             (SELECT id FROM employees WHERE name = 'عامل له سلفة')"
        ),
        1
    );
}

#[test]
fn a_wash_worker_with_no_history_is_deleted_and_audited() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let admin = login(&conn, "admin");
    let id = wash_worker(&conn, &manager, "عامل بلا سجل");
    let before = count(&conn, "SELECT COUNT(*) FROM employees");

    employee_svc::delete_employee(&conn, &admin, id).unwrap();

    assert!(employees::find(&conn, id).unwrap().is_none());
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM employees"), before - 1);
    assert_eq!(audit_entries(&conn, "employee.deleted"), 1);
}

/* ========================================================================== */
/* EMPLOYEE — the linked login account                                        */
/* ========================================================================== */

#[test]
fn an_unused_login_is_deleted_with_the_employee() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let admin = login(&conn, "admin");
    let (id, user_id) = unused_cashier(&conn, &manager, "كاشير جديد");

    employee_svc::delete_employee(&conn, &admin, id).unwrap();

    assert!(employees::find(&conn, id).unwrap().is_none());
    // Exclusively owned by this employee and referenced by nothing, so it goes
    // too: the account must not outlive the person it authenticates.
    assert!(crate::repositories::users::find_by_id(&conn, user_id)
        .unwrap()
        .is_none());
}

#[test]
fn a_login_referenced_by_history_is_preserved_rather_than_orphaned() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let cashier = login(&conn, "cashier");
    let employee_id = employees::find_by_user(&conn, cashier.id)
        .unwrap()
        .unwrap()
        .id;

    // The premise: a login that has worked is referenced by real records, so it
    // is a historical actor and not an owned child.
    assert!(crate::repositories::users::reference_count(&conn, cashier.id).unwrap() > 0);

    // Whatever the outcome, the login is never left broken: either the delete is
    // refused and both survive, or it succeeds and the login is preserved.
    match employee_svc::delete_employee(&conn, &admin, employee_id) {
        Ok(()) => {
            assert!(employees::find(&conn, employee_id).unwrap().is_none());
            assert!(
                crate::repositories::users::find_by_id(&conn, cashier.id)
                    .unwrap()
                    .is_some(),
                "a login with history must be preserved, not deleted"
            );
        }
        Err(e) => {
            assert!(matches!(e, AppError::BusinessRule(_)), "{e:?}");
            assert!(employees::find(&conn, employee_id).unwrap().is_some());
            assert!(crate::repositories::users::find_by_id(&conn, cashier.id)
                .unwrap()
                .is_some());
        }
    }
    assert_eq!(fk_violations(&conn), 0);
}

/* ========================================================================== */
/* TRANSACTION SAFETY                                                         */
/* ========================================================================== */

#[test]
fn a_refused_employee_delete_writes_no_audit_entry() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let admin = login(&conn, "admin");
    let id = wash_worker(&conn, &manager, "عامل له سجل");

    employee_svc::record_attendance(&conn, &manager, id, AttendanceAction::CheckIn, None).unwrap();
    assert_eq!(audit_entries(&conn, "employee.deleted"), 0);

    assert!(employee_svc::delete_employee(&conn, &admin, id).is_err());
    // The audit entry shares the transaction, so a refused delete leaves no
    // trace of an action that never happened.
    assert_eq!(audit_entries(&conn, "employee.deleted"), 0);
}

#[test]
fn an_employee_delete_leaves_the_database_integrity_intact() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let admin = login(&conn, "admin");

    wash_worker(&conn, &manager, "عامل بلا سجل");
    let id = wash_worker(&conn, &manager, "عامل آخر");

    employee_svc::delete_employee(&conn, &admin, id).unwrap();
    // Only this employee went; the one beside them is untouched, and nothing
    // anywhere is left dangling.
    assert!(employees::find(&conn, id).unwrap().is_none());
    assert_eq!(fk_violations(&conn), 0);
}

/* ========================================================================== */
/* CUSTOMER — authorization                                                   */
/* ========================================================================== */

#[test]
fn manager_and_cashier_cannot_delete_a_customer() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let admin = login(&conn, "admin");
    let id = new_customer(&conn, "عميل للتجربة");

    for actor in [&manager, &cashier] {
        let err = customer_svc::delete(&conn, actor, id).unwrap_err();
        assert!(
            matches!(err, AppError::Unauthorized(_)),
            "{} must be refused, got {err:?}",
            actor.role
        );
        assert!(customers::find_by_id(&conn, id).unwrap().is_some());
    }

    customer_svc::delete(&conn, &admin, id).unwrap();
    assert!(customers::find_by_id(&conn, id).unwrap().is_none());
}

#[test]
fn deleting_an_unknown_customer_is_a_not_found() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    assert!(matches!(
        customer_svc::delete(&conn, &admin, 999_999).unwrap_err(),
        AppError::NotFound(_)
    ));
    assert_eq!(audit_entries(&conn, "customer.deleted"), 0);
}

/* ========================================================================== */
/* CUSTOMER — integrity                                                       */
/* ========================================================================== */

#[test]
fn a_customer_with_no_history_is_deleted() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let id = new_customer(&conn, "عميل جديد");

    customer_svc::delete(&conn, &admin, id).unwrap();

    assert!(customers::find_by_id(&conn, id).unwrap().is_none());
    assert_eq!(audit_entries(&conn, "customer.deleted"), 1);
}

#[test]
fn a_customers_cars_are_deleted_with_them() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let id = new_customer(&conn, "عميل بسيارة");
    customers::insert_car(&conn, id, "أ ب ج 1234", Some("ساندانا"), None).unwrap();
    customers::insert_car(&conn, id, "د هـ و 5678", None, None).unwrap();
    assert_eq!(customers::cars_of(&conn, id).unwrap().len(), 2);

    customer_svc::delete(&conn, &admin, id).unwrap();

    assert!(customers::find_by_id(&conn, id).unwrap().is_none());
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM cars"), 0);
    // No orphaned plate survives its owner.
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM cars WHERE customer_id NOT IN (SELECT id FROM customers)"
        ),
        0,
        "a deleted customer must not orphan a vehicle"
    );
}

#[test]
fn a_customer_with_invoices_cannot_be_deleted_and_the_invoice_survives() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let id = new_customer(&conn, "عميل له فاتورة");
    let invoice_id = sell_to(&conn, id);

    let err = customer_svc::delete(&conn, &admin, id).unwrap_err();
    assert!(matches!(err, AppError::BusinessRule(_)), "{err:?}");

    // The customer is still listed AND the paid invoice is still readable with
    // its snapshot intact: the delete was refused, not forced.
    assert!(customers::find_by_id(&conn, id).unwrap().is_some());
    let (total, name): (i64, String) = conn
        .query_row(
            "SELECT i.total, ic.customer_name FROM invoices i
             JOIN invoice_customers ic ON ic.invoice_id = i.id WHERE i.id = ?1",
            [invoice_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(total > 0);
    assert_eq!(name, "عميل له فاتورة");
    assert_eq!(audit_entries(&conn, "customer.deleted"), 0);
}

#[test]
fn a_customer_with_a_credit_account_cannot_be_deleted() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let id = new_customer(&conn, "عميل آجل");
    // A credit account is financial history in its own right, because its
    // payments are the money movement.
    conn.execute(
        "INSERT INTO credit_accounts (customer_id, original_total, paid_total, status)
         VALUES (?1, 5000, 0, 'UNPAID')",
        [id],
    )
    .unwrap();

    let err = customer_svc::delete(&conn, &admin, id).unwrap_err();
    assert!(matches!(err, AppError::BusinessRule(_)), "{err:?}");
    assert!(customers::find_by_id(&conn, id).unwrap().is_some());
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM credit_accounts"), 1);
}

#[test]
fn a_refused_customer_delete_leaves_the_cars_in_place() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let id = new_customer(&conn, "عميل له سيارة وفاتورة");
    customers::insert_car(&conn, id, "أ ب ج 9999", None, None).unwrap();
    sell_to(&conn, id);

    assert!(customer_svc::delete(&conn, &admin, id).is_err());

    // The dependency check runs BEFORE any write, so the plates are still there
    // and the audit is clean: there is no partial deletion.
    assert_eq!(customers::cars_of(&conn, id).unwrap().len(), 1);
    assert!(customers::find_by_id(&conn, id).unwrap().is_some());
    assert_eq!(audit_entries(&conn, "customer.deleted"), 0);
}

#[test]
fn a_customer_delete_leaves_the_database_integrity_intact() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let id = new_customer(&conn, "عميل");
    customers::insert_car(&conn, id, "أ ب ج 4321", None, None).unwrap();

    customer_svc::delete(&conn, &admin, id).unwrap();
    assert_eq!(fk_violations(&conn), 0);
}
