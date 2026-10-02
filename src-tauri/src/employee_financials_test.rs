//! Advances, deductions and salary figures — the employee financial system.
//!
//! An advance is BOTH an expense and a salary reduction, so one user action must
//! produce both records in ONE transaction, linked 1:1. A deduction is a salary
//! reduction and NOTHING else: it is never an expense and moves no expense total.
//!
//! Everything here runs against the real migrated schema through the real
//! services, so the CHECK constraints, the foreign keys and the unique indexes are
//! exercised as well — several of these tests deliberately bypass the service to
//! prove the DATABASE refuses what the service would.

use crate::db::migrate;
use crate::demo_data::seed_for_development as run_if_empty;
use crate::repositories::employee_analytics;
use crate::repositories::employees;
use crate::repositories::expenses as expenses_repo;
use crate::services::auth::{self, User};
use crate::services::employees::{self as emp, AdvanceInput, EmployeePeriod};
use crate::services::ops as ops_svc;
use rusqlite::Connection;

/// A migrated + seeded in-memory database, exactly the fixture the employees suite
/// uses: the starter accounts are needed because authorization is a real part of
/// every rule asserted below.
fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    run_if_empty(&conn).unwrap();
    conn
}

/// Log in as one of the seeded starter accounts.
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

fn employee_of(conn: &Connection, user: &User) -> i64 {
    employees::find_by_user(conn, user.id).unwrap().unwrap().id
}

/// The seeded system category that requires an employee. Read from the category
/// TABLE rather than hardcoded, so renaming the label cannot break the suite while
/// the RULE (`requires_employee`) is still asserted.
fn advance_category(conn: &Connection) -> String {
    expenses_repo::list_categories(conn, true)
        .unwrap()
        .into_iter()
        .find(|c| c.requires_employee)
        .expect("a seeded employee-linked category")
        .code
}

/// An ordinary, non-employee-linked category.
fn plain_category(conn: &Connection) -> String {
    expenses_repo::list_categories(conn, true)
        .unwrap()
        .into_iter()
        .find(|c| !c.requires_employee)
        .expect("a seeded ordinary category")
        .code
}

fn spend(category: &str, amount: i64, date: &str, employee_id: Option<i64>) -> ops_svc::NewExpense {
    ops_svc::NewExpense {
        category: category.into(),
        amount,
        description: None,
        expense_date: Some(date.into()),
        is_recurring: false,
        recurrence: None,
        paid_from_cash: true,
        employee_id,
    }
}

/// Pin the employee record's creation instant, so the unbounded-range month count
/// is asserted against a known floor rather than against the test clock.
fn set_created_at(conn: &Connection, employee_id: i64, value: &str) {
    conn.execute(
        "UPDATE employees SET created_at = ?2 WHERE id = ?1",
        rusqlite::params![employee_id, value],
    )
    .unwrap();
}

fn period(from: &str, to: &str) -> EmployeePeriod {
    EmployeePeriod {
        from: Some(from.into()),
        to: Some(to.into()),
    }
}

fn expense_total(conn: &Connection, from: &str, to: &str) -> i64 {
    expenses_repo::overview(conn, Some(from), Some(to))
        .unwrap()
        .total_amount
}

fn salary(conn: &Connection, employee_id: i64, from: &str, to: &str) -> emp::EmployeeFinancials {
    let employee = employees::require(conn, employee_id).unwrap();
    emp::financials(conn, &employee, &period(from, to)).unwrap()
}

fn advance_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM employee_advances", [], |r| r.get(0))
        .unwrap()
}

/// One employee's advances, so a test can prove the person it measures starts with
/// no history of its own.
fn advance_count_for(conn: &Connection, employee_id: i64) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM employee_advances WHERE employee_id = ?1",
        [employee_id],
        |r| r.get(0),
    )
    .unwrap()
}

fn expense_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM expenses", [], |r| r.get(0))
        .unwrap()
}

/// An employee with a 10,000 EGP monthly salary, created inside a month the test
/// controls, so the month count is deterministic.
///
/// A FRESH record, never a seeded one: the demo dataset already gives its own
/// employees advances and deductions, and asserting an exact salary total on top
/// of someone else's history would measure the seed rather than this feature.
fn salaried_employee(conn: &Connection, created_at: &str) -> (User, i64) {
    let manager = login(conn, "manager");
    let id = emp::create_employee(
        conn,
        &manager,
        &emp::EmployeeInput {
            name: "موظف الاختبار".into(),
            phone: None,
            employee_type: emp::WASH_WORKER.into(),
            base_salary: Some(1_000_000),
            notes: None,
            user_id: None,
            role: None,
            password: None,
        },
    )
    .unwrap();
    set_created_at(conn, id, created_at);
    (manager, id)
}

fn deduct(conn: &Connection, manager: &User, id: i64, amount: i64, date: &str) -> i64 {
    emp::create_deduction(
        conn,
        manager,
        id,
        &emp::DeductionInput {
            amount,
            deduction_date: Some(date.into()),
            reason: Some("سبب".into()),
        },
    )
    .unwrap()
}

/// The month the seeded employee joined, as a stored instant.
const CREATED_IN_SEPTEMBER: &str = "2026-09-15 08:00:00Z";

fn legacy_advance(amount: i64, date: &str, reason: &str) -> AdvanceInput {
    AdvanceInput {
        amount,
        advance_date: Some(date.into()),
        reason: reason.into(),
    }
}

/// A cashier's shift, opened the way the POS opens one.
fn open_cashier_shift(conn: &Connection) -> User {
    let manager = login(conn, "manager");
    let cashier = login(conn, "cashier");
    crate::services::shifts::open_day(conn, &manager).unwrap();
    crate::services::shifts::open_shift(conn, &cashier, 10_000).unwrap();
    cashier
}

// ===========================================================================
// ADVANCE CREATION — validity, linkage and atomicity
// ===========================================================================

#[test]
fn an_advance_expense_creates_both_records_linked_one_to_one() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    let category = advance_category(&conn);

    let expense_id = ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 200_000, "2026-10-10", Some(id)),
    )
    .unwrap();

    // 1. The expense exists, names the employee, and carries the money.
    let expense = expenses_repo::list(&conn, None, None, false)
        .unwrap()
        .into_iter()
        .find(|e| e.id == expense_id)
        .unwrap();
    assert_eq!(expense.amount, 200_000);
    assert_eq!(expense.expense_date, "2026-10-10");
    assert_eq!(expense.employee_id, Some(id));

    // 2. The advance exists, is linked to THAT expense, and is RECORDED.
    let advance = employee_analytics::advances_of(&conn, id, None, None, 10)
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    let linked: Option<i64> = conn
        .query_row(
            "SELECT expense_id FROM employee_advances WHERE id = ?1",
            [advance.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        linked,
        Some(expense_id),
        "the advance must claim the expense"
    );
    assert_eq!(advance.status, "RECORDED");
    // The ledger READS the expense's money and date, so the two cannot disagree.
    assert_eq!(advance.amount, 200_000);
    assert_eq!(advance.advance_date, "2026-10-10");
}

#[test]
fn an_advance_expense_without_an_employee_is_refused() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let category = advance_category(&conn);
    let before_expenses = expense_count(&conn);
    let before_advances = advance_count(&conn);

    let missing = ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 200_000, "2026-10-10", None),
    )
    .unwrap_err();
    assert_eq!(
        missing.to_string(),
        "validation error: expenses.employee_required"
    );

    // The same refusal for a non-positive id, which is what a stale selection
    // would send.
    for stale in [Some(0), Some(-3)] {
        assert!(ops_svc::create_expense(
            &conn,
            &manager,
            &spend(&category, 200_000, "2026-10-10", stale)
        )
        .is_err());
    }

    // Nothing was written: not the expense, and not the advance.
    assert_eq!(expense_count(&conn), before_expenses);
    assert_eq!(advance_count(&conn), before_advances);
}

#[test]
fn an_advance_expense_for_a_nonexistent_employee_writes_nothing() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let category = advance_category(&conn);
    let before_expenses = expense_count(&conn);
    let before_advances = advance_count(&conn);

    assert!(ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 200_000, "2026-10-10", Some(9_999_999))
    )
    .is_err());

    assert_eq!(expense_count(&conn), before_expenses);
    assert_eq!(advance_count(&conn), before_advances);
}

#[test]
fn an_advance_refuses_a_zero_or_negative_amount_without_writing_anything() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    let category = advance_category(&conn);
    let before_expenses = expense_count(&conn);
    let before_advances = advance_count(&conn);

    for amount in [0, -1, -200_000] {
        assert!(ops_svc::create_expense(
            &conn,
            &manager,
            &spend(&category, amount, "2026-10-10", Some(id))
        )
        .is_err());
    }

    assert_eq!(expense_count(&conn), before_expenses);
    assert_eq!(advance_count(&conn), before_advances);
}

#[test]
fn an_advance_refuses_a_malformed_date_without_writing_anything() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    let category = advance_category(&conn);
    let before_expenses = expense_count(&conn);
    let before_advances = advance_count(&conn);

    for bad in ["10/10/2026", "2026-13-01", "2026-02-30"] {
        assert!(ops_svc::create_expense(
            &conn,
            &manager,
            &spend(&category, 200_000, bad, Some(id))
        )
        .is_err());
    }

    assert_eq!(expense_count(&conn), before_expenses);
    assert_eq!(advance_count(&conn), before_advances);
}

#[test]
fn an_ordinary_expense_is_never_employee_linked() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    let category = plain_category(&conn);

    // Even when the caller SENDS an employee, a category that does not require one
    // stores none: the CATEGORY decides, not the payload.
    let expense_id = ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 50_000, "2026-10-10", Some(id)),
    )
    .unwrap();

    let stored = expenses_repo::list(&conn, None, None, false)
        .unwrap()
        .into_iter()
        .find(|e| e.id == expense_id)
        .unwrap();
    assert_eq!(stored.employee_id, None);
    // And it created no advance at all.
    assert_eq!(advance_count(&conn), 0);
}

#[test]
fn a_cashier_may_create_an_advance_with_the_same_result_as_a_manager() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = open_cashier_shift(&conn);
    let category = advance_category(&conn);
    let manager_employee = employee_of(&conn, &manager);
    let cashier_employee = employee_of(&conn, &cashier);

    let from_manager = ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 200_000, "2026-10-10", Some(manager_employee)),
    )
    .unwrap();
    let from_cashier = ops_svc::create_expense(
        &conn,
        &cashier,
        &spend(&category, 100_000, "2026-10-20", Some(cashier_employee)),
    )
    .unwrap();

    // Both produced the same KIND of record: an expense plus a linked advance.
    // This is the parity claim — the only difference between the two paths is the
    // existing role permission, never a second set of business rules.
    for (expense_id, employee_id) in [
        (from_manager, manager_employee),
        (from_cashier, cashier_employee),
    ] {
        let linked: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM employee_advances WHERE expense_id = ?1 AND employee_id = ?2",
                rusqlite::params![expense_id, employee_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(linked, 1, "one expense, exactly one linked advance");
    }
}

#[test]
fn a_cashier_with_no_open_shift_is_still_refused_an_advance() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    let category = advance_category(&conn);

    // The PRE-EXISTING cashier rule, not a new one: an expense belonging to no
    // shift could never be reconciled against a drawer.
    assert!(ops_svc::create_expense(
        &conn,
        &cashier,
        &spend(&category, 100_000, "2026-10-20", Some(id))
    )
    .is_err());
    assert_eq!(advance_count(&conn), 0);
}

#[test]
fn an_advance_is_a_real_expense_in_every_expense_aggregate() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    let category = advance_category(&conn);

    let before = expense_total(&conn, "2026-10-01", "2026-10-31");
    ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 200_000, "2026-10-10", Some(id)),
    )
    .unwrap();

    // The period total moved by exactly the advance.
    assert_eq!(
        expense_total(&conn, "2026-10-01", "2026-10-31"),
        before + 200_000
    );

    // The category ranking carries it under its own category, resolved by name.
    let overview = expenses_repo::overview(&conn, Some("2026-10-01"), Some("2026-10-31")).unwrap();
    let slice = overview
        .categories
        .iter()
        .find(|c| c.category == category)
        .expect("the advance must appear under its own category");
    assert_eq!(slice.amount, 200_000);
    assert_eq!(slice.count, 1);
}

// ===========================================================================
// DEDUCTIONS
// ===========================================================================

#[test]
fn a_deduction_is_never_an_expense() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    let before_total = expense_total(&conn, "2026-10-01", "2026-10-31");
    let before_rows = expense_count(&conn);

    deduct(&conn, &manager, id, 50_000, "2026-10-25");

    // No expense row, and no change to any expense total.
    assert_eq!(expense_count(&conn), before_rows);
    assert_eq!(
        expense_total(&conn, "2026-10-01", "2026-10-31"),
        before_total
    );

    // It is in its own table, linked to the employee, with its recorder.
    let stored = employee_analytics::deductions_of(&conn, id, None, None, 10).unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].amount, 50_000);
    assert_eq!(stored[0].deduction_date, "2026-10-25");
    assert_eq!(stored[0].created_by_name, "manager");
}

#[test]
fn a_deduction_must_be_a_positive_amount_on_a_real_date_for_a_real_employee() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    let input = |amount, date: Option<&str>| emp::DeductionInput {
        amount,
        deduction_date: date.map(str::to_string),
        reason: None,
    };

    for (amount, date) in [
        (0, Some("2026-10-25")),
        (-500, Some("2026-10-25")),
        (500, Some("25/10/2026")),
        (500, Some("2026-13-01")),
    ] {
        assert!(emp::create_deduction(&conn, &manager, id, &input(amount, date)).is_err());
    }
    // A nonexistent employee is refused by name, not by a raw FK failure.
    assert!(
        emp::create_deduction(&conn, &manager, 9_999_999, &input(500, Some("2026-10-25"))).is_err()
    );

    // A reason is OPTIONAL: only the amount, the date and the employee are rules.
    assert!(emp::create_deduction(&conn, &manager, id, &input(500, Some("2026-10-25"))).is_ok());
}

#[test]
fn only_a_manager_may_record_a_deduction() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    let err = emp::create_deduction(
        &conn,
        &cashier,
        id,
        &emp::DeductionInput {
            amount: 50_000,
            deduction_date: Some("2026-10-25".into()),
            reason: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.to_string(), "unauthorized: auth.forbidden");
    assert_eq!(
        employee_analytics::deductions_total(&conn, id, None, None).unwrap(),
        0
    );
}

// ===========================================================================
// THE SALARY FIGURES
// ===========================================================================

#[test]
fn the_salary_figures_are_base_minus_advances_minus_deductions() {
    let conn = fresh();
    let (manager, id) = salaried_employee(&conn, CREATED_IN_SEPTEMBER);
    let category = advance_category(&conn);

    // Neither: the net IS the salary.
    let plain = salary(&conn, id, "2026-10-01", "2026-10-31");
    assert_eq!(plain.base_salary, 1_000_000);
    assert_eq!(plain.advances, 0);
    assert_eq!(plain.deductions, 0);
    assert_eq!(plain.net_salary, 1_000_000);
    assert_eq!(plain.months, 1);

    // Advances only.
    ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 200_000, "2026-10-12", Some(id)),
    )
    .unwrap();
    let advanced = salary(&conn, id, "2026-10-01", "2026-10-31");
    assert_eq!(advanced.advances, 200_000);
    assert_eq!(advanced.net_salary, 800_000);

    // Deductions only, on a second clean employee.
    let (_, other) = salaried_employee(&conn, CREATED_IN_SEPTEMBER);
    deduct(&conn, &manager, other, 50_000, "2026-10-05");
    let deducted = salary(&conn, other, "2026-10-01", "2026-10-31");
    assert_eq!(deducted.advances, 0);
    assert_eq!(deducted.deductions, 50_000);
    assert_eq!(deducted.net_salary, 950_000);

    // Both.
    deduct(&conn, &manager, id, 50_000, "2026-10-20");
    let both = salary(&conn, id, "2026-10-01", "2026-10-31");
    assert_eq!(both.base_salary, 1_000_000);
    assert_eq!(both.advances, 200_000);
    assert_eq!(both.deductions, 50_000);
    assert_eq!(both.net_salary, 750_000);
}

#[test]
fn the_net_salary_never_goes_below_zero() {
    let conn = fresh();
    let (manager, id) = salaried_employee(&conn, CREATED_IN_SEPTEMBER);
    let category = advance_category(&conn);

    // An advance larger than the whole salary is floored, never negative.
    ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 1_500_000, "2026-10-10", Some(id)),
    )
    .unwrap();
    let figures = salary(&conn, id, "2026-10-01", "2026-10-31");
    assert_eq!(figures.advances, 1_500_000);
    assert_eq!(figures.net_salary, 0);
}

#[test]
fn several_advances_and_deductions_in_one_month_are_summed() {
    let conn = fresh();
    let (manager, id) = salaried_employee(&conn, CREATED_IN_SEPTEMBER);
    let category = advance_category(&conn);

    for (amount, date) in [
        (50_000, "2026-10-02"),
        (120_000, "2026-10-15"),
        (30_000, "2026-10-28"),
    ] {
        ops_svc::create_expense(&conn, &manager, &spend(&category, amount, date, Some(id)))
            .unwrap();
    }
    for (amount, date) in [(20_000, "2026-10-05"), (30_000, "2026-10-22")] {
        deduct(&conn, &manager, id, amount, date);
    }

    let figures = salary(&conn, id, "2026-10-01", "2026-10-31");
    assert_eq!(figures.advances, 200_000);
    assert_eq!(figures.deductions, 50_000);
    assert_eq!(figures.net_salary, 750_000);
}

#[test]
fn a_multi_month_period_multiplies_the_monthly_salary_without_prorating() {
    let conn = fresh();
    let (manager, id) = salaried_employee(&conn, "2026-09-01 08:00:00Z");
    let category = advance_category(&conn);

    // October: 2,000 advance, 500 deduction.
    ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 200_000, "2026-10-10", Some(id)),
    )
    .unwrap();
    deduct(&conn, &manager, id, 50_000, "2026-10-15");
    // November: 1,000 advance, 300 deduction.
    ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 100_000, "2026-11-10", Some(id)),
    )
    .unwrap();
    deduct(&conn, &manager, id, 30_000, "2026-11-18");

    let figures = salary(&conn, id, "2026-10-01", "2026-11-30");
    assert_eq!(figures.months, 2);
    assert_eq!(figures.base_salary, 2_000_000, "monthly salary x 2 months");
    assert_eq!(figures.advances, 300_000);
    assert_eq!(figures.deductions, 80_000);
    assert_eq!(figures.net_salary, 1_620_000);
}

// ===========================================================================
// THE DATE FILTER
// ===========================================================================

#[test]
fn an_advance_is_scoped_by_its_own_expense_date_not_by_today() {
    let conn = fresh();
    let (manager, id) = salaried_employee(&conn, "2026-09-01 08:00:00Z");
    let category = advance_category(&conn);

    // A September advance and an October advance: two months, two answers.
    ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 200_000, "2026-09-25", Some(id)),
    )
    .unwrap();
    ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 100_000, "2026-10-10", Some(id)),
    )
    .unwrap();

    let october = salary(&conn, id, "2026-10-01", "2026-10-31");
    assert_eq!(
        october.advances, 100_000,
        "September must not reduce October"
    );
    assert_eq!(october.net_salary, 900_000);

    let september = salary(&conn, id, "2026-09-01", "2026-09-30");
    assert_eq!(september.advances, 200_000);
    assert_eq!(september.net_salary, 800_000);
}

#[test]
fn the_period_bounds_are_inclusive_on_both_month_edges() {
    let conn = fresh();
    let (manager, id) = salaried_employee(&conn, "2026-09-01 08:00:00Z");
    let category = advance_category(&conn);

    for (amount, date) in [
        (1_000, "2026-09-30"), // the day before October
        (2_000, "2026-10-01"), // October's FIRST day
        (3_000, "2026-10-31"), // October's LAST day
        (4_000, "2026-11-01"), // the day after October
    ] {
        ops_svc::create_expense(&conn, &manager, &spend(&category, amount, date, Some(id)))
            .unwrap();
    }

    let october = salary(&conn, id, "2026-10-01", "2026-10-31");
    assert_eq!(
        october.advances, 5_000,
        "both October edges are inside; neither neighbour is"
    );
}

#[test]
fn an_arbitrary_range_selects_exactly_itself_and_is_never_widened() {
    let conn = fresh();
    let (manager, id) = salaried_employee(&conn, "2026-09-01 08:00:00Z");
    let category = advance_category(&conn);

    for (amount, date) in [
        (10_000, "2026-10-01"),
        (20_000, "2026-10-15"),
        (40_000, "2026-10-31"),
    ] {
        ops_svc::create_expense(&conn, &manager, &spend(&category, amount, date, Some(id)))
            .unwrap();
    }

    // A window that is NOT a month, and is never widened into one.
    let figures = salary(&conn, id, "2026-10-10", "2026-10-20");
    assert_eq!(figures.advances, 20_000);
    // It still touches ONE month, so the salary is counted once.
    assert_eq!(figures.months, 1);
}

#[test]
fn a_deduction_is_scoped_by_its_own_date() {
    let conn = fresh();
    let (manager, id) = salaried_employee(&conn, "2026-09-01 08:00:00Z");

    for (amount, date) in [
        (10_000, "2026-09-30"),
        (20_000, "2026-10-01"),
        (40_000, "2026-10-31"),
        (80_000, "2026-11-01"),
    ] {
        deduct(&conn, &manager, id, amount, date);
    }

    let october = salary(&conn, id, "2026-10-01", "2026-10-31");
    assert_eq!(october.deductions, 60_000, "both October edges only");
    assert_eq!(october.net_salary, 940_000);
}

// ===========================================================================
// THE UNBOUNDED RANGE (the Employees page's own default)
// ===========================================================================

#[test]
fn an_unbounded_range_counts_months_from_the_employees_own_creation() {
    let conn = fresh();
    // Created this month: exactly one month can be counted.
    let today = crate::time::today_business_date();
    let (manager, id) = salaried_employee(&conn, &format!("{today} 08:00:00Z"));

    let figures = salary(&conn, id, "", "");
    assert_eq!(figures.from, None);
    assert_eq!(figures.to, None);
    assert_eq!(figures.months, 1, "only the month they joined so far");
    assert_eq!(figures.base_salary, 1_000_000);

    // Everything ever recorded is inside an unbounded window.
    let category = advance_category(&conn);
    ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 100_000, &today, Some(id)),
    )
    .unwrap();
    let with_advance = salary(&conn, id, "", "");
    assert_eq!(with_advance.advances, 100_000);
    assert_eq!(with_advance.net_salary, 900_000);
}

#[test]
fn an_unbounded_range_reaches_back_to_the_creation_month_and_no_further() {
    let conn = fresh();
    // Hired two months before the current one: the count is deterministic.
    let created = crate::time::business_date_months_ago(2);
    let (manager, id) = salaried_employee(&conn, &format!("{created} 08:00:00Z"));
    let category = advance_category(&conn);
    ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 100_000, &created, Some(id)),
    )
    .unwrap();

    let figures = salary(&conn, id, "", "");
    assert_eq!(
        figures.months, 3,
        "creation month through the current month"
    );
    assert_eq!(figures.base_salary, 3_000_000);
    assert_eq!(figures.advances, 100_000, "the creation month is inside");
}

#[test]
fn a_window_ending_before_the_employee_joined_still_counts_one_month() {
    let conn = fresh();
    let (_, id) = salaried_employee(&conn, CREATED_IN_SEPTEMBER);

    // A September window that ENDS before the 15th they joined.
    let figures = salary(&conn, id, "2026-09-01", "2026-09-10");
    assert_eq!(figures.months, 1, "never zero months of a real employee");
    assert_eq!(figures.base_salary, 1_000_000);
}

// ===========================================================================
// DATA INTEGRITY
// ===========================================================================

#[test]
fn one_expense_can_never_be_claimed_by_two_advances() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    let category = advance_category(&conn);
    let expense_id = ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 200_000, "2026-10-10", Some(id)),
    )
    .unwrap();

    // A second advance claiming the same expense is refused BY THE DATABASE,
    // which is what makes the link incapable of fanning out.
    let clash = conn.execute(
        "INSERT INTO employee_advances (employee_id, amount, advance_date, reason, created_by, expense_id)
         VALUES (?1, 1, '2026-10-10', 'x', ?2, ?3)",
        rusqlite::params![id, manager.id, expense_id],
    );
    assert!(
        clash.is_err(),
        "the unique index must refuse the second claim"
    );
}

#[test]
fn an_expense_referenced_by_an_advance_keeps_its_amount_and_date_frozen() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    let category = advance_category(&conn);
    let expense_id = ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 200_000, "2026-10-10", Some(id)),
    )
    .unwrap();

    // The expense owns the money and the date, so a linked expense cannot be
    // re-priced or re-dated behind the salary's back.
    assert!(conn
        .execute("UPDATE expenses SET amount = 1 WHERE id = ?1", [expense_id])
        .is_err());
    assert!(conn
        .execute(
            "UPDATE expenses SET expense_date = '2026-12-01' WHERE id = ?1",
            [expense_id]
        )
        .is_err());

    // An UNLINKED expense stays freely editable, exactly as before.
    let plain = plain_category(&conn);
    let free = ops_svc::create_expense(&conn, &manager, &spend(&plain, 50_000, "2026-10-10", None))
        .unwrap();
    assert!(conn
        .execute("UPDATE expenses SET amount = 60_000 WHERE id = ?1", [free])
        .is_ok());
}

#[test]
fn an_expense_cannot_reference_an_employee_who_does_not_exist() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let category = advance_category(&conn);
    // The foreign key is the last line of defence, under the service check.
    let written = conn.execute(
        "INSERT INTO expenses (category, amount, expense_date, user_id, employee_id)
         VALUES (?1, 1, '2026-10-10', ?2, 9_999_999)",
        rusqlite::params![category, manager.id],
    );
    assert!(written.is_err());
}

#[test]
fn an_employee_with_financial_history_cannot_be_deleted() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let (manager, id) = salaried_employee(&conn, CREATED_IN_SEPTEMBER);
    let category = advance_category(&conn);

    // A deduction is history too: the person is not deletable afterwards.
    deduct(&conn, &manager, id, 50_000, "2026-10-05");
    assert!(emp::delete_employee(&conn, &admin, id).is_err());

    ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 200_000, "2026-10-10", Some(id)),
    )
    .unwrap();
    assert!(emp::delete_employee(&conn, &admin, id).is_err());
}

// ===========================================================================
// LEGACY ADVANCES AND REVERSAL
// ===========================================================================

#[test]
fn a_legacy_advance_without_an_expense_still_reads_its_own_money_and_date() {
    let conn = fresh();
    let (manager, id) = salaried_employee(&conn, CREATED_IN_SEPTEMBER);
    // The direct ledger path — no expense, `expense_id` NULL — is exactly what a
    // pre-migration row looks like, and it must keep working unchanged.
    emp::create_advance(
        &conn,
        &manager,
        id,
        &legacy_advance(200_000, "2026-10-10", "سلفة"),
    )
    .unwrap();

    let row: Option<i64> = conn
        .query_row("SELECT expense_id FROM employee_advances", [], |r| r.get(0))
        .unwrap();
    assert_eq!(row, None, "the direct path must not fabricate an expense");

    let figures = salary(&conn, id, "2026-10-01", "2026-10-31");
    assert_eq!(
        figures.advances, 200_000,
        "a legacy advance still reduces pay"
    );
    assert_eq!(figures.net_salary, 800_000);
}

#[test]
fn a_legacy_and_a_linked_advance_are_read_identically() {
    let conn = fresh();
    let (manager, id) = salaried_employee(&conn, CREATED_IN_SEPTEMBER);
    let category = advance_category(&conn);

    emp::create_advance(
        &conn,
        &manager,
        id,
        &legacy_advance(100_000, "2026-10-05", "legacy"),
    )
    .unwrap();
    ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 200_000, "2026-10-10", Some(id)),
    )
    .unwrap();

    let figures = salary(&conn, id, "2026-10-01", "2026-10-31");
    assert_eq!(figures.advances, 300_000, "both kinds count the same way");
    assert_eq!(figures.net_salary, 700_000);
}

#[test]
fn a_reversed_advance_stops_reducing_the_salary() {
    let conn = fresh();
    let (manager, id) = salaried_employee(&conn, CREATED_IN_SEPTEMBER);
    let category = advance_category(&conn);
    ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 200_000, "2026-10-10", Some(id)),
    )
    .unwrap();
    let advance_id: i64 = conn
        .query_row("SELECT id FROM employee_advances", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        salary(&conn, id, "2026-10-01", "2026-10-31").advances,
        200_000
    );

    emp::reverse_advance(&conn, &manager, advance_id).unwrap();

    // The SALARY half stops counting.
    let figures = salary(&conn, id, "2026-10-01", "2026-10-31");
    assert_eq!(figures.advances, 0);
    assert_eq!(figures.net_salary, 1_000_000);

    // The EXPENSE half is deliberately left alone: Station's expense ledger is
    // append-only with no reversal mechanism, and the money really did leave the
    // till. Inventing one here would be a second, competing correction model.
    assert_eq!(
        expense_total(&conn, "2026-10-01", "2026-10-31"),
        200_000,
        "the recorded spend is a fact, not a figure the advance owns"
    );
}

// ===========================================================================
// THE DRAWER PAYLOAD
// ===========================================================================

#[test]
fn the_drawer_payload_carries_the_salary_block_and_the_period_ledgers() {
    let conn = fresh();
    let (manager, id) = salaried_employee(&conn, "2026-09-01 08:00:00Z");
    let category = advance_category(&conn);
    ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 200_000, "2026-10-10", Some(id)),
    )
    .unwrap();
    // A September record the October selection must NOT show.
    ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 999_000, "2026-09-10", Some(id)),
    )
    .unwrap();

    let details = emp::details(&conn, &manager, id, &period("2026-10-01", "2026-10-31")).unwrap();
    assert_eq!(details.financials.advances, 200_000);
    assert_eq!(details.financials.net_salary, 800_000);
    assert_eq!(details.financials.months, 1);
    assert_eq!(details.financials.from.as_deref(), Some("2026-10-01"));
    assert_eq!(details.financials.to.as_deref(), Some("2026-10-31"));
    // The ledger the drawer LISTS is the same period as the cards above it.
    assert_eq!(details.advances.len(), 1);
    assert_eq!(details.advances[0].amount, 200_000);
}

#[test]
fn a_cashier_may_not_read_the_drawer_salary_block() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    assert!(emp::details(&conn, &cashier, id, &EmployeePeriod::default()).is_err());
}

// ===========================================================================
// MIGRATION 34 — fresh install and the upgrade from the previous schema
// ===========================================================================

#[test]
fn a_fresh_database_gets_the_advance_category_and_the_deduction_table() {
    let conn = fresh();

    // The category exists, is a SYSTEM one, and is the only one requiring an
    // employee today.
    let categories = expenses_repo::list_categories(&conn, true).unwrap();
    let linked: Vec<_> = categories.iter().filter(|c| c.requires_employee).collect();
    assert_eq!(
        linked.len(),
        1,
        "exactly one seeded employee-linked category"
    );
    assert!(
        linked[0].is_system,
        "it must not be an ADMIN-deletable category"
    );
    assert!(
        !linked[0].name_ar.trim().is_empty(),
        "it carries its Arabic label"
    );

    // The deduction table is empty and available on a fresh install.
    let deductions: i64 = conn
        .query_row("SELECT COUNT(*) FROM employee_deductions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(deductions, 0);
}

/// The upgrade path a REAL installation takes: a database written by migration 33,
/// with real expenses, employees and a historical advance, upgraded to 34.
///
/// The contract under test is that nothing existing is rewritten, re-dated,
/// re-priced, re-categorised or deleted — the migration only ADDS.
#[test]
fn the_upgrade_from_the_previous_schema_preserves_every_existing_row() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    // Build a pre-upgrade database, exactly as an installation that shipped
    // migration 33 would have it.
    crate::db::migrate_up_to(&conn, Some(33)).unwrap();

    // A minimal pre-upgrade world: one manager login, its employee, one ordinary
    // expense and one historical advance.
    let user_id = crate::repositories::users::insert(
        &conn,
        &crate::repositories::users::NewUser {
            name: "مدير",
            phone: None,
            role: "MANAGER",
            password_hash: &auth::hash_password("secret123").unwrap(),
            is_seed: false,
        },
    )
    .unwrap()
    .unwrap();
    let employee = employees::insert(
        &conn,
        &crate::repositories::employees::NewEmployee {
            name: "مدير",
            phone: None,
            employee_type: "CASHIER",
            base_salary: 1_000_000,
            notes: None,
            user_id: Some(user_id),
        },
    )
    .unwrap();
    // The category code, read with the old schema's column list: at version 33
    // the `requires_employee` column does not exist yet.
    let category: String = conn
        .query_row(
            "SELECT code FROM expense_categories WHERE code = 'SUPPLIES'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    // An ordinary expense and a historical advance, written with the OLD schema's
    // column list — which is the whole point: at version 33 neither `employee_id`
    // nor `expense_id` exists yet.
    conn.execute(
        "INSERT INTO expenses (category, amount, description, expense_date, is_recurring,
             recurrence, business_day_id, shift_id, paid_from_cash, user_id)
         VALUES (?1, 55000, 'مصروف قديم', '2026-09-11', 0, NULL, NULL, NULL, 1, ?2)",
        rusqlite::params![category, user_id],
    )
    .unwrap();
    let expense_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO employee_advances (employee_id, amount, advance_date, reason, created_by)
         VALUES (?1, 123456, '2026-09-10', 'سلفة', ?2)",
        rusqlite::params![employee, user_id],
    )
    .unwrap();

    let expenses_before: i64 = conn
        .query_row("SELECT COUNT(*) FROM expenses", [], |r| r.get(0))
        .unwrap();
    let advances_before: i64 = conn
        .query_row("SELECT COUNT(*) FROM employee_advances", [], |r| r.get(0))
        .unwrap();
    assert_eq!(expenses_before, 1);
    assert_eq!(advances_before, 1);

    // Now the real upgrade.
    crate::db::migrate_up_to(&conn, None).unwrap();

    // Every pre-existing row is still there, unchanged.
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM expenses", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        expenses_before
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM employee_advances", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap(),
        advances_before
    );
    let stored = expenses_repo::list(&conn, None, None, false)
        .unwrap()
        .into_iter()
        .find(|e| e.id == expense_id)
        .unwrap();
    assert_eq!(
        stored.amount, 55_000,
        "an existing expense is not re-priced"
    );
    assert_eq!(stored.expense_date, "2026-09-11", "nor re-dated");
    assert_eq!(stored.description.as_deref(), Some("مصروف قديم"));
    assert_eq!(stored.employee_id, None, "and is not invented an employee");

    // The historical advance is NOT reinterpreted: it gains no expense, and keeps
    // its own amount and date.
    let legacy = employee_analytics::advances_of(&conn, employee, None, None, 50)
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    assert_eq!(legacy.amount, 123_456);
    assert_eq!(legacy.advance_date, "2026-09-10");
    let linked: Option<i64> = conn
        .query_row(
            "SELECT expense_id FROM employee_advances WHERE id = ?1",
            [legacy.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        linked, None,
        "history must never be back-filled with a guess"
    );

    // The new schema is there, and the new behaviour works on the upgraded file.
    let linked_category = advance_category(&conn);
    let manager = auth::login(
        &conn,
        &auth::LoginInput {
            name: "مدير".into(),
            password: "secret123".into(),
        },
    )
    .unwrap()
    .user;
    ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&linked_category, 10_000, "2026-10-10", Some(employee)),
    )
    .unwrap();
    deduct(&conn, &manager, employee, 5_000, "2026-10-11");

    let figures = salary(&conn, employee, "2026-10-01", "2026-10-31");
    assert_eq!(figures.advances, 10_000);
    assert_eq!(figures.deductions, 5_000);
    assert_eq!(figures.net_salary, 985_000);
}

// ===========================================================================
// THE REQUIRED END-TO-END SCENARIO
// ===========================================================================
//
// Ahmed, base salary 10,000 EGP, October selected:
//   * a MANAGER creates an advance of 2,000
//   * a CASHIER creates an advance of 1,000
//   * a MANAGER creates a deduction of 500
// then the page filter moves to September and back to October.
//
// This walks the real services in the real order a manager and a cashier would,
// so it is the feature's acceptance test end to end rather than a unit assertion.

#[test]
fn the_acceptance_scenario_from_the_specification() {
    let conn = fresh();

    // --- Ahmed, hired in September, on a 10,000 EGP monthly salary -----------
    // The id is whatever the schema hands out; what matters is that this is a
    // FRESH employee with no seeded advances or deductions of its own.
    let (manager, ahmed) = salaried_employee(&conn, "2026-09-05 08:00:00Z");
    assert_eq!(advance_count_for(&conn, ahmed), 0, "Ahmed starts clean");

    let advance = advance_category(&conn);
    let ordinary = plain_category(&conn);

    // --- What the Expenses page already shows in October, before anything ----
    let october_from = "2026-10-01";
    let october_to = "2026-10-31";
    let expenses_before = expense_total(&conn, october_from, october_to);

    // --- Scenario 1: the MANAGER creates a 2,000 advance on 10 October -------
    ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&advance, 200_000, "2026-10-10", Some(ahmed)),
    )
    .unwrap();
    assert_eq!(
        expense_total(&conn, october_from, october_to),
        expenses_before + 200_000,
        "scenario 1: expenses +2000"
    );
    let figures = salary(&conn, ahmed, october_from, october_to);
    assert_eq!(figures.advances, 200_000);
    assert_eq!(figures.net_salary, 800_000, "10000 - 2000 = 8000");

    // --- Scenario 2: the CASHIER creates a 1,000 advance on 20 October ------
    let cashier = open_cashier_shift(&conn);
    ops_svc::create_expense(
        &conn,
        &cashier,
        &spend(&advance, 100_000, "2026-10-20", Some(ahmed)),
    )
    .unwrap();
    assert_eq!(
        expense_total(&conn, october_from, october_to),
        expenses_before + 300_000,
        "scenario 2: expenses +3000 in total"
    );
    let figures = salary(&conn, ahmed, october_from, october_to);
    assert_eq!(figures.advances, 300_000);
    assert_eq!(figures.net_salary, 700_000, "10000 - 3000 = 7000");

    // --- Scenario 3: the MANAGER deducts 500 on 25 October ------------------
    deduct(&conn, &manager, ahmed, 50_000, "2026-10-25");
    assert_eq!(
        expense_total(&conn, october_from, october_to),
        expenses_before + 300_000,
        "scenario 3: a deduction must NOT increase expenses"
    );

    let figures = salary(&conn, ahmed, october_from, october_to);
    assert_eq!(figures.base_salary, 1_000_000, "base 10,000");
    assert_eq!(figures.advances, 300_000, "advances 3,000");
    assert_eq!(figures.deductions, 50_000, "deductions 500");
    assert_eq!(figures.net_salary, 650_000, "net 6,500");

    // --- Scenario 4: the page filter moves to SEPTEMBER ----------------------
    let september = salary(&conn, ahmed, "2026-09-01", "2026-09-30");
    assert_eq!(
        september.advances, 0,
        "October advances leave the selection"
    );
    assert_eq!(
        september.deductions, 0,
        "and the October deduction with them"
    );
    assert_eq!(
        september.net_salary, 1_000_000,
        "September shows the salary untouched"
    );
    // The expense side moves with the same filter, and the advance really is a spend.
    assert_eq!(expense_total(&conn, "2026-09-01", "2026-09-30"), 0);

    // --- ...and back to OCTOBER: the values return exactly --------------------
    let back = salary(&conn, ahmed, october_from, october_to);
    assert_eq!(back.base_salary, 1_000_000);
    assert_eq!(back.advances, 300_000);
    assert_eq!(back.deductions, 50_000);
    assert_eq!(back.net_salary, 650_000);
    assert_eq!(
        expense_total(&conn, october_from, october_to),
        expenses_before + 300_000
    );

    // The drawer shows exactly the same figures, through its own payload.
    let details = emp::details(&conn, &manager, ahmed, &period(october_from, october_to)).unwrap();
    assert_eq!(details.financials.base_salary, 1_000_000);
    assert_eq!(details.financials.advances, 300_000);
    assert_eq!(details.financials.deductions, 50_000);
    assert_eq!(details.financials.net_salary, 650_000);
    assert_eq!(details.financials.months, 1);
    // Both advances and the deduction appear in the drawer's period ledgers.
    assert_eq!(details.advances.len(), 2);
    assert_eq!(details.deductions.len(), 1);

    // And the advance expenses are ordinary expenses: they carry the category the
    // manager and the cashier each chose, and they are listed like any other spend.
    let october_expenses = expenses_repo::list(&conn, Some(october_from), Some(october_to), false)
        .unwrap()
        .into_iter()
        .filter(|e| e.employee_id == Some(ahmed))
        .collect::<Vec<_>>();
    assert_eq!(october_expenses.len(), 2);
    assert!(october_expenses.iter().all(|e| e.category == advance));
    assert_eq!(
        october_expenses.iter().map(|e| e.amount).sum::<i64>(),
        300_000
    );

    // Nothing here invented an employee for an ordinary expense.
    let ordinary_rows = expenses_repo::list(&conn, Some(october_from), Some(october_to), false)
        .unwrap()
        .into_iter()
        .filter(|e| e.category == ordinary)
        .collect::<Vec<_>>();
    assert!(
        ordinary_rows.iter().all(|e| e.employee_id.is_none()),
        "no ordinary expense may be employee-linked"
    );
}

// ===========================================================================
// A FINALIZED PAYROLL RUN IS A POINT OF NO RETURN — FOR BOTH SIDES
// ===========================================================================

/// A deduction may NOT be dated inside a month whose payroll run is already
/// FINALIZED.
///
/// This is the SAME invariant an advance reversal already enforced, seen from
/// the other side, and it is asserted here as one rule rather than two: reversing
/// an advance out of a paid month, and recording a deduction into one, both move a
/// month whose net figure has already been published. The asymmetry was real and
/// observable: the drawer would report a different net salary for a month the
/// employee had already been paid, and — because a deduction is append-only with
/// no reversal of its own — nothing could ever put that month back.
///
/// The test proves the DRAWER and the FROZEN DOCUMENT would otherwise disagree,
/// so it cannot pass just because the guard happens to be in the code.
#[test]
fn a_deduction_cannot_be_recorded_into_a_month_already_paid() {
    let conn = fresh();
    let (manager, id) = salaried_employee(&conn, "2026-09-05 08:00:00Z");

    let run = emp::create_payroll_run(&conn, &manager, id, "2026-10", 0).unwrap();
    emp::finalize_payroll_run(&conn, &manager, run.id).unwrap();
    let paid_net = run.net_salary;

    let refused = emp::create_deduction(
        &conn,
        &manager,
        id,
        &emp::DeductionInput {
            amount: 300_000,
            deduction_date: Some("2026-10-15".into()),
            reason: Some("متأخر".into()),
        },
    );
    assert!(
        refused.is_err(),
        "a paid month must not accept a new deduction"
    );
    // Nothing was written: the refusal is a refusal, not a warning.
    assert_eq!(
        salary(&conn, id, "2026-10-01", "2026-10-31").deductions,
        0,
        "the refused deduction left no trace"
    );
    // The published document still states the figure it was issued with.
    let stored = employee_analytics::find_run(&conn, run.id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.net_salary, paid_net);
    assert_eq!(stored.deductions, 0);
    // The drawer's net for that month agrees with the document that was issued.
    assert_eq!(
        salary(&conn, id, "2026-10-01", "2026-10-31").net_salary,
        paid_net
    );
}

/// The guard is about the MONTH, not about the record: a deduction in any other
/// month is still accepted, so the rule cannot be satisfied by blocking the
/// feature outright.
#[test]
fn a_deduction_outside_the_paid_month_is_still_accepted() {
    let conn = fresh();
    let (manager, id) = salaried_employee(&conn, "2026-09-05 08:00:00Z");

    let run = emp::create_payroll_run(&conn, &manager, id, "2026-10", 0).unwrap();
    emp::finalize_payroll_run(&conn, &manager, run.id).unwrap();

    // The month BEFORE the paid one.
    deduct(&conn, &manager, id, 10_000, "2026-09-10");
    // The month AFTER it.
    deduct(&conn, &manager, id, 20_000, "2026-11-10");

    assert_eq!(
        salary(&conn, id, "2026-09-01", "2026-09-30").deductions,
        10_000
    );
    assert_eq!(
        salary(&conn, id, "2026-10-01", "2026-10-31").deductions,
        0,
        "the paid month is untouched"
    );
    assert_eq!(
        salary(&conn, id, "2026-11-01", "2026-11-30").deductions,
        20_000
    );
}

/// Both directions of the invariant share ONE implementation, so they cannot
/// drift apart again. Asserted at the service boundary: an advance in a paid
/// month is refused for the same reason a deduction is.
#[test]
fn an_advance_and_a_deduction_agree_on_which_months_are_closed() {
    let conn = fresh();
    let (manager, id) = salaried_employee(&conn, "2026-09-05 08:00:00Z");
    let category = advance_category(&conn);

    let run = emp::create_payroll_run(&conn, &manager, id, "2026-10", 0).unwrap();
    emp::finalize_payroll_run(&conn, &manager, run.id).unwrap();

    let advance_in_paid_month = ops_svc::create_expense(
        &conn,
        &manager,
        &spend(&category, 10_000, "2026-10-20", Some(id)),
    );
    assert!(
        advance_in_paid_month.is_ok(),
        "a NEW advance in a paid month is a new fact, not a rewrite — only \
         reversing one is refused"
    );

    // Reversing it is refused...
    let advance_id = conn
        .query_row(
            "SELECT id FROM employee_advances WHERE employee_id = ?1 AND status = 'RECORDED'",
            [id],
            |r| r.get::<_, i64>(0),
        )
        .unwrap();
    assert!(emp::reverse_advance(&conn, &manager, advance_id).is_err());

    // ...and so is a deduction in the very same month.
    assert!(
        emp::create_deduction(
            &conn,
            &manager,
            id,
            &emp::DeductionInput {
                amount: 10_000,
                deduction_date: Some("2026-10-21".into()),
                reason: None,
            },
        )
        .is_err(),
        "both sides of the same invariant must agree on a closed month"
    );
}
