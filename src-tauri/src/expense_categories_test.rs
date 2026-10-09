//! Expense category authorization — the permission matrix, enforced by the
//! SERVICE, not by a hidden button.
//!
//! The rule under test is narrow and business-shaped: a MANAGER owns the expense
//! vocabulary (create and rename a category), while permanent removal is ADMIN's
//! alone. So this file asserts the two halves separately:
//!
//!  - **authorization** — MANAGER/ADMIN may create and rename; only ADMIN may
//!    delete. Each refusal also asserts NOTHING was written, because "denied"
//!    must mean "no category appeared, no name changed, no row disappeared".
//!  - **integrity** — the usage protection and the historical expenses behind a
//!    category. A category that still holds expenses cannot be deleted, and the
//!    expenses themselves are re-read afterwards to prove not one row moved.
//!
//! It also pins the validation and audit contract that must not drift by role:
//! create and rename share ONE name rule, and each of the three operations
//! writes its own audit entry with the AUTHENTICATED user as the actor.
//!
//! Every test runs against a migrated, seeded in-memory database with
//! `foreign_keys = ON`, so the suite exercises the real foreign keys: the
//! usage check in the service is a deliberate, readable pre-check of what SQLite
//! would otherwise enforce, and these tests are what prove the two agree.

use crate::db::migrate;
use crate::demo_data::seed_for_development as run_if_empty;
use crate::error::AppError;
use crate::repositories::expenses;
use crate::services::auth::{self, User};
use crate::services::ops as ops_svc;
use rusqlite::Connection;

fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    run_if_empty(&conn).unwrap();
    conn
}

fn login(conn: &Connection, name: &str, password: &str) -> User {
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

fn admin(conn: &Connection) -> User {
    login(conn, "admin", "1234")
}

fn manager(conn: &Connection) -> User {
    login(conn, "manager", "2345")
}

fn staff(conn: &Connection) -> User {
    login(conn, "cashier", "3456")
}

/// A category created through the service, so no test starts from a fixture the
/// production path could not have produced.
fn create(conn: &Connection, actor: &User, name: &str) -> String {
    ops_svc::create_category(conn, actor, name).expect("MANAGER+ may create a category")
}

fn name_of(conn: &Connection, code: &str) -> String {
    expenses::get_category(conn, code)
        .unwrap()
        .expect("category still there")
        .name_ar
}

fn count(conn: &Connection, sql: &str, args: impl rusqlite::Params) -> i64 {
    conn.query_row(sql, args, |r| r.get(0)).unwrap()
}

fn expenses_count(conn: &Connection) -> i64 {
    count(conn, "SELECT COUNT(*) FROM expenses", [])
}

fn audit_entries(conn: &Connection, action: &str) -> i64 {
    count(
        conn,
        "SELECT COUNT(*) FROM audit_log WHERE action = ?1",
        [action],
    )
}

/// The actor recorded on the newest entry for an action, so "the audit actor is
/// the authenticated user" is asserted rather than assumed.
fn audit_actor(conn: &Connection, action: &str) -> (Option<i64>, Option<String>) {
    conn.query_row(
        "SELECT actor_id, actor_role FROM audit_log WHERE action = ?1
         ORDER BY id DESC LIMIT 1",
        [action],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

fn is_unauthorized(err: &AppError) -> bool {
    matches!(err, AppError::Unauthorized(_))
}

fn expense_on(conn: &Connection, actor: &User, category: &str, amount: i64) {
    ops_svc::create_expense(
        conn,
        actor,
        &ops_svc::NewExpense {
            category: category.into(),
            amount,
            description: None,
            expense_date: None,
            is_recurring: false,
            recurrence: None,
            paid_from_cash: true,
            employee_id: None,
        },
    )
    .expect("a manager may record an expense");
}

/// Rows returned by a foreign-key check, i.e. every dangling reference left in
/// the database. Zero after a delete is the proof that nothing was orphaned.
fn dangling_references(conn: &Connection) -> Vec<(String, i64)> {
    let mut stmt = conn.prepare("PRAGMA foreign_key_check").unwrap();
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .unwrap();
    rows.collect::<Result<Vec<_>, _>>().unwrap()
}

// ---- the matrix ------------------------------------------------------------

#[test]
fn manager_can_create_and_rename_a_category() {
    let conn = fresh();
    let manager = manager(&conn);

    let code = create(&conn, &manager, "فاتورة كهرباء");
    assert!(
        !code.is_empty(),
        "the service hands back the new category's code"
    );
    assert_eq!(name_of(&conn, &code), "فاتورة كهرباء");

    // A rename is a NORMAL edit for a manager, not a privileged one.
    ops_svc::rename_category(&conn, &manager, &code, "فاتورة كهرباء شهرية").unwrap();
    assert_eq!(name_of(&conn, &code), "فاتورة كهرباء شهرية");

    // The new category is immediately usable: the list the UI reads contains it,
    // with no frontend change.
    assert!(ops_svc::list_categories(&conn)
        .unwrap()
        .iter()
        .any(|c| c.code == code));
}

#[test]
fn admin_can_create_rename_and_delete_a_category() {
    let conn = fresh();
    let admin = admin(&conn);

    let code = create(&conn, &admin, "أدوات نظافة");
    ops_svc::rename_category(&conn, &admin, &code, "مواد نظافة").unwrap();
    assert_eq!(name_of(&conn, &code), "مواد نظافة");

    ops_svc::delete_category(&conn, &admin, &code).unwrap();

    assert!(
        expenses::get_category(&conn, &code).unwrap().is_none(),
        "an ADMIN delete removes the category"
    );
    // The list the UI reads no longer offers it either.
    assert!(!ops_svc::list_categories(&conn)
        .unwrap()
        .iter()
        .any(|c| c.code == code));
}

#[test]
fn manager_cannot_delete_a_category_even_through_the_service_directly() {
    let conn = fresh();
    let manager = manager(&conn);
    let code = create(&conn, &manager, "صيانة أجهزة");

    // The UI hides the destructive action for a manager; THIS is the boundary,
    // so the test calls the service the command calls, with no React in sight.
    let err = ops_svc::delete_category(&conn, &manager, &code).unwrap_err();

    assert!(
        is_unauthorized(&err),
        "a MANAGER delete is refused: {err:?}"
    );
    // "Denied" must mean "nothing happened".
    assert_eq!(name_of(&conn, &code), "صيانة أجهزة");
    assert_eq!(
        audit_entries(&conn, "expenses.category_deleted"),
        0,
        "a refused delete leaves no audit entry claiming it happened"
    );
}

#[test]
fn staff_may_not_change_a_category_at_all() {
    let conn = fresh();
    let staff = staff(&conn);
    let manager = manager(&conn);
    let code = create(&conn, &manager, "ديزل");

    for err in [
        ops_svc::create_category(&conn, &staff, "مصاريف").unwrap_err(),
        ops_svc::rename_category(&conn, &staff, &code, "مخرجه").unwrap_err(),
        ops_svc::delete_category(&conn, &staff, &code).unwrap_err(),
    ] {
        assert!(is_unauthorized(&err), "a cashier is refused: {err:?}");
    }

    assert_eq!(name_of(&conn, &code), "ديزل");
    assert_eq!(audit_entries(&conn, "expenses.category_created"), 1);
    assert_eq!(audit_entries(&conn, "expenses.category_updated"), 0);
    assert_eq!(audit_entries(&conn, "expenses.category_deleted"), 0);
}

// ---- the data lifecycle must not change ------------------------------------

#[test]
fn a_category_holding_expenses_cannot_be_deleted_and_the_expenses_survive() {
    let conn = fresh();
    let admin = admin(&conn);
    let manager = manager(&conn);

    // A category with no expenses IS removable…
    let unused = create(&conn, &manager, "فئة غير مستخدمة");
    ops_svc::delete_category(&conn, &admin, &unused).unwrap();

    // …but one that HOLDS expenses is not, and the refusal costs nothing.
    let used = create(&conn, &manager, "قطع غيار");
    expense_on(&conn, &manager, &used, 5_000);
    let before = expenses_count(&conn);

    let err = ops_svc::delete_category(&conn, &admin, &used).unwrap_err();
    assert!(
        matches!(err, AppError::BusinessRule(ref code) if code == "expenses.category_in_use"),
        "a used category is a business-rule refusal: {err:?}"
    );

    // Neither side was lost: the category is still addressable and every expense
    // — historical rows included — is untouched.
    assert_eq!(name_of(&conn, &used), "قطع غيار");
    assert_eq!(expenses_count(&conn), before);
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM expenses WHERE category = ?1",
            [used.as_str()]
        ),
        1
    );
    assert!(
        dangling_references(&conn).is_empty(),
        "no expense was orphaned"
    );
}

#[test]
fn a_rename_relabels_today_without_touching_a_recorded_expense() {
    let conn = fresh();
    let manager = manager(&conn);
    let code = create(&conn, &manager, "كواكيل");
    expense_on(&conn, &manager, &code, 2_500);

    ops_svc::rename_category(&conn, &manager, &code, "مطبخ").unwrap();

    // The expense kept its code, so it is still linked…
    assert_eq!(expenses::category_expense_count(&conn, &code).unwrap(), 1);
    // …and it now READS under the new label, which is the whole point of
    // renaming a category rather than replacing it.
    let row = expenses::list(&conn, None, None, false)
        .unwrap()
        .into_iter()
        .find(|e| e.category == code)
        .expect("the expense is still there");
    assert_eq!(row.category_name, "مطبخ");
    assert_eq!(row.amount, 2_500);
}

#[test]
fn a_system_category_is_not_removable() {
    let conn = fresh();
    let admin = admin(&conn);

    // The seeded categories are the fallback vocabulary the whole app was
    // migrated onto, so an ADMIN may rename them but not remove them.
    let err = ops_svc::delete_category(&conn, &admin, "SUPPLIES").unwrap_err();
    assert!(
        matches!(err, AppError::BusinessRule(ref code) if code == "expenses.category_is_system"),
        "a system category is a business-rule refusal: {err:?}"
    );
    assert!(expenses::get_category(&conn, "SUPPLIES").unwrap().is_some());

    // Renaming one is allowed, and is the normal way to relabel it.
    ops_svc::rename_category(&conn, &admin, "SUPPLIES", "مشتريات المقهى").unwrap();
    assert_eq!(name_of(&conn, "SUPPLIES"), "مشتريات المقهى");
}

// ---- the shared name rule --------------------------------------------------

#[test]
fn create_and_rename_share_one_name_rule_for_every_role() {
    let conn = fresh();
    let manager = manager(&conn);
    let admin = admin(&conn);
    let code = create(&conn, &manager, "مستلزمات");

    for (actor, who) in [(&manager, "MANAGER"), (&admin, "ADMIN")] {
        // Empty and whitespace-only names are refused for BOTH roles, by the
        // same helper — validation never depends on who is typing.
        for name in ["", "   ", "\t\n "] {
            let create_err = ops_svc::create_category(&conn, actor, name).unwrap_err();
            assert!(
                matches!(create_err, AppError::Validation(ref c) if c == "expenses.category_name_required"),
                "{who} create of {name:?} is refused: {create_err:?}"
            );
            let rename_err = ops_svc::rename_category(&conn, actor, &code, name).unwrap_err();
            assert!(
                matches!(rename_err, AppError::Validation(ref c) if c == "expenses.category_name_required"),
                "{who} rename to {name:?} is refused: {rename_err:?}"
            );
        }

        // A name already taken is refused too, and the existing category keeps
        // its own name.
        let err = ops_svc::create_category(&conn, actor, "رواتب").unwrap_err();
        assert!(
            matches!(err, AppError::Validation(ref c) if c == "expenses.category_name_taken"),
            "{who} cannot create a duplicate name: {err:?}"
        );
        assert_eq!(name_of(&conn, "SALARY"), "رواتب");
    }

    // Surrounding whitespace is TRIMMED, not stored, and the save succeeds.
    let trimmed = create(&conn, &manager, "  أدوات مكتبية  ");
    assert_eq!(name_of(&conn, &trimmed), "أدوات مكتبية");

    // Renaming a category to its OWN unchanged name is not a duplicate of itself.
    ops_svc::rename_category(&conn, &manager, &code, "مستلزمات").unwrap();
    assert_eq!(name_of(&conn, &code), "مستلزمات");

    // An unknown code is a not-found on both writes, never a silent success.
    assert!(matches!(
        ops_svc::rename_category(&conn, &manager, "NO_SUCH_CODE", "أي اسم").unwrap_err(),
        AppError::NotFound(_)
    ));
    assert!(matches!(
        ops_svc::delete_category(&conn, &admin, "NO_SUCH_CODE").unwrap_err(),
        AppError::NotFound(_)
    ));
}

// ---- the audit trail -------------------------------------------------------

#[test]
fn every_category_mutation_is_audited_with_the_authenticated_actor() {
    let conn = fresh();
    let manager = manager(&conn);
    let admin = admin(&conn);

    let code = create(&conn, &manager, "وقود");
    ops_svc::rename_category(&conn, &manager, &code, "وقود مولد").unwrap();
    ops_svc::delete_category(&conn, &admin, &code).unwrap();

    // One mechanism, three actions — the existing `audit_log`, not a new one.
    assert_eq!(audit_entries(&conn, "expenses.category_created"), 1);
    assert_eq!(audit_entries(&conn, "expenses.category_updated"), 1);
    assert_eq!(audit_entries(&conn, "expenses.category_deleted"), 1);

    let (created_by, created_role) = audit_actor(&conn, "expenses.category_created");
    assert_eq!(created_by, Some(manager.id));
    assert_eq!(created_role.as_deref(), Some("MANAGER"));

    let (deleted_by, deleted_role) = audit_actor(&conn, "expenses.category_deleted");
    assert_eq!(deleted_by, Some(admin.id));
    assert_eq!(deleted_role.as_deref(), Some("ADMIN"));

    // The rename records both sides of the change, so the trail says what it was.
    let (before, after): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT before_json, after_json FROM audit_log WHERE action = 'expenses.category_updated'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(before.expect("before").contains("وقود"));
    assert!(after.expect("after").contains("مولد"));
}
