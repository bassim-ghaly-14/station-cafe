//! Employees domain tests — attendance, authorization, performance, advances,
//! payroll, migrations and transaction behaviour.
//!
//! Everything runs against a migrated in-memory SQLite file, so the suite
//! exercises the real schema, the real CHECK constraints and the real SQL — not
//! a mock. There is no network anywhere in this file, by construction: the only
//! I/O is the in-memory database.

use crate::db::migrate;
use crate::demo_data::seed_for_development as run_if_empty;
use crate::error::AppError;
use crate::repositories::employee_analytics::{self, Period};
use crate::repositories::employees;
use crate::services::attendance::{self, AttendanceAction};
use crate::services::auth::{self, User};
use crate::services::employees::{self as emp, EmployeeInput, EmployeePeriod};
use rusqlite::Connection;

/// Migrated + seeded in-memory database.
fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    run_if_empty(&conn).unwrap();
    conn
}

/// Log in as one of the seeded starter accounts. The password is explicit
/// because the starter list is not uniform (`momo` / `foly` use short PINs).
fn login_as(conn: &Connection, name: &str, password: &str) -> User {
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

/// Log in as one of the seeded starter accounts.
///
/// The PIN is read from the demo table rather than reconstructed as
/// `{name}123`: that construction matched an older, looser credential policy and
/// would now build a value the policy refuses, so a helper that guessed would
/// make every test using it fail for a reason that has nothing to do with what
/// the test is about.
fn login(conn: &Connection, name: &str) -> User {
    login_as(
        conn,
        name,
        crate::demo_data::demo_password_of(name)
            .unwrap_or_else(|| panic!("{name} is not a seeded demo account")),
    )
}

/// The employee record behind a seeded login.
fn employee_of(conn: &Connection, user: &User) -> i64 {
    employees::find_by_user(conn, user.id).unwrap().unwrap().id
}

/// A wash worker: no login, ever.
fn wash_worker(conn: &Connection, name: &str) -> i64 {
    emp::create_employee(
        conn,
        &login(conn, "manager"),
        &EmployeeInput {
            name: name.into(),
            phone: None,
            employee_type: emp::WASH_WORKER.into(),
            base_salary: Some(0),
            notes: None,
            user_id: None,
            role: None,
            password: None,
        },
    )
    .unwrap()
}

fn rows(
    conn: &Connection,
    from: Option<&str>,
    to: Option<&str>,
) -> Vec<employee_analytics::EmployeeRow> {
    employee_analytics::list_rows(
        conn,
        &Period {
            from: from.map(str::to_string),
            to: to.map(str::to_string),
        },
        true,
        true,
        "",
    )
    .unwrap()
}

fn row_for(conn: &Connection, id: i64) -> employee_analytics::EmployeeRow {
    rows(conn, None, None)
        .into_iter()
        .find(|r| r.id == id)
        .expect("employee row")
}

/// The headcount the fixture actually created, as `(employees, cashiers, wash)`.
///
/// Derived from the employee rows rather than hardcoded, because the fixture is
/// the DEVELOPMENT seeder: it contributes the official starter logins AND the
/// demo accounts / demo wash workers on top of them, so a literal would silently
/// rot the next time either list changes. Counting distinct `id`s here is also
/// the very property these tests exist to protect, so the expectation and the
/// production reduction are measured against the same "one person, one row" rule
/// while remaining independent of how the KPI figures are computed.
/// The ACTIVE roster — the exact population the KPI band reduces.
///
/// A separate helper from `rows` because the two genuinely differ: `rows`
/// includes inactive employees, which is what the "show inactive" filter needs,
/// while the overview is computed over the active roster only. A test that
/// compares a figure derived from one against a figure derived from the other
/// is comparing two different populations.
fn rows_active(conn: &Connection) -> Vec<employee_analytics::EmployeeRow> {
    employee_analytics::list_rows(
        conn,
        &Period {
            from: None,
            to: None,
        },
        true,
        false,
        "",
    )
    .unwrap()
}

/// The fixture headcount, derived from the SAME population the KPI band reads.
///
/// See [`rows_active`]: this counts active employees only, so it agrees with
/// `emp::overview` by construction rather than by coincidence. The demo dataset
/// deliberately contains an inactive employee and an inactive wash worker, so the
/// difference between the two populations is real rather than theoretical.
fn fixture_headcount(conn: &Connection) -> (i64, i64, i64) {
    let mut seen = std::collections::BTreeSet::new();
    let mut cashiers = 0;
    let mut wash_workers = 0;
    for row in rows_active(conn) {
        if !seen.insert(row.id) {
            continue;
        }
        // "كاشير" is the STAFF LOGIN ROLE, never the CASHIER employee type.
        if row.login_role.as_deref() == Some("STAFF") {
            cashiers += 1;
        }
        // A wash worker has no login at all.
        if row.login_role.is_none() && row.employee_type == emp::WASH_WORKER {
            wash_workers += 1;
        }
    }
    (seen.len() as i64, cashiers, wash_workers)
}

// ---------------------------------------------------------------- migrations

#[test]
fn every_migration_applies_and_is_recorded() {
    let conn = fresh();
    let applied: i64 = conn
        .query_row("SELECT COUNT(*) FROM _migrations", [], |r| r.get(0))
        .unwrap();
    assert_eq!(applied, crate::db::migration_count());
}

#[test]
fn an_existing_login_became_a_cashier_employee() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let employee = employees::find_by_user(&conn, cashier.id).unwrap().unwrap();
    assert_eq!(employee.employee_type, emp::CASHIER);
    assert_eq!(employee.name, cashier.name);
    assert_eq!(employee.status, "ACTIVE");
}

#[test]
fn a_wash_worker_may_never_be_given_a_login() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let user_id = login(&conn, "cashier").id;
    // The service refuses it...
    let err = emp::create_employee(
        &conn,
        &manager,
        &EmployeeInput {
            name: "محمود".into(),
            phone: None,
            employee_type: emp::WASH_WORKER.into(),
            base_salary: Some(0),
            notes: None,
            user_id: Some(user_id),
            role: None,
            password: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)));
    // ...and so does the database, for a writer that bypasses the service.
    let direct = conn.execute(
        "INSERT INTO employees (name, employee_type, user_id) VALUES ('x', 'WASH_WORKER', ?1)",
        [user_id],
    );
    assert!(direct.is_err());
}

#[test]
fn a_cashier_may_never_exist_without_a_login() {
    let conn = fresh();
    assert!(conn
        .execute(
            "INSERT INTO employees (name, employee_type) VALUES ('x', 'CASHIER')",
            []
        )
        .is_err());
}

#[test]
fn the_database_refuses_an_impossible_attendance_state() {
    let conn = fresh();
    let id = wash_worker(&conn, "محمود");
    // A PRESENT day with no check-in is not representable.
    assert!(conn
        .execute(
            "INSERT INTO attendance_days (employee_id, business_date, state, recorded_by_user_id)
             VALUES (?1, '2026-09-27', 'PRESENT', 1)",
            [id]
        )
        .is_err());
    // Nor is an ABSENT day carrying a punch pair.
    assert!(conn
        .execute(
            "INSERT INTO attendance_days (employee_id, business_date, state, check_in_actual_at,
                 check_in_effective_at, recorded_by_user_id)
             VALUES (?1, '2026-09-27', 'ABSENT', '2026-09-27 06:00:00Z',
                 '2026-09-27 06:00:00Z', 1)",
            [id]
        )
        .is_err());
}

#[test]
fn only_one_live_attendance_row_per_employee_per_day() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    let today = crate::time::today_business_date();
    let insert = |date: &str| {
        conn.execute(
            "INSERT INTO attendance_days (employee_id, business_date, state,
                 check_in_actual_at, check_in_effective_at, recorded_by_user_id)
             VALUES (?1, ?2, 'PRESENT', '2026-09-27 06:00:00Z', '2026-09-27 06:00:00Z', ?3)",
            rusqlite::params![id, date, cashier.id],
        )
    };
    assert!(insert(&today).is_ok());
    // The partial unique index is what makes the second write fail, not a
    // service convention — so even a concurrent writer cannot both win.
    assert!(insert(&today).is_err());
}

// ---------------------------------------------------------------- attendance

#[test]
fn a_check_in_stores_both_the_actual_and_the_effective_instant() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    let day = emp::record_attendance(&conn, &cashier, id, AttendanceAction::CheckIn, None).unwrap();

    let actual = day.check_in_actual_at.clone().unwrap();
    let effective = day.check_in_effective_at.clone().unwrap();
    let actual_dt = crate::time::parse_timestamp(&actual).unwrap();
    let effective_dt = crate::time::parse_timestamp(&effective).unwrap();
    // The actual instant is the untouched clock reading; the effective one is
    // that same instant put on the attendance grid by the BACKEND. Two distinct
    // facts, and the rounding is applied to the business wall clock — never in
    // the UI, which sends an intent and not a time.
    assert_eq!(
        effective_dt,
        attendance::effective_instant(actual_dt, AttendanceAction::CheckIn)
    );
    // And the invariant the rule exists for: a check-in is never dated later than
    // the moment the button was pressed.
    assert!(effective_dt <= actual_dt);
    assert_eq!(day.state, "PRESENT");
    assert!(day.check_out_actual_at.is_none());
}

#[test]
fn a_check_out_stores_an_effective_instant_that_is_never_in_the_past() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    emp::record_attendance(&conn, &cashier, id, AttendanceAction::CheckIn, None).unwrap();
    let day =
        emp::record_attendance(&conn, &cashier, id, AttendanceAction::CheckOut, None).unwrap();

    let actual = crate::time::parse_timestamp(day.check_out_actual_at.as_ref().unwrap()).unwrap();
    let effective =
        crate::time::parse_timestamp(day.check_out_effective_at.as_ref().unwrap()).unwrap();
    assert_eq!(
        effective,
        attendance::effective_instant(actual, AttendanceAction::CheckOut)
    );
    // The mirror invariant: a check-out is never dated earlier than the action.
    assert!(effective >= actual);
}

#[test]
fn a_stored_punch_never_moves_more_than_ten_minutes_from_the_action() {
    // The ten-minute ceiling asserted where it actually matters: on the row that
    // was WRITTEN, through the real service and the real schema. The unit tests
    // prove the pure function; this proves the value that reaches SQLite.
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);

    let day = emp::record_attendance(&conn, &cashier, id, AttendanceAction::CheckIn, None).unwrap();
    let ceiling = chrono::Duration::minutes(attendance::MAX_ROUNDING_STEP_MINUTES);
    let actual = crate::time::parse_timestamp(day.check_in_actual_at.as_ref().unwrap()).unwrap();
    let effective =
        crate::time::parse_timestamp(day.check_in_effective_at.as_ref().unwrap()).unwrap();
    // Direction AND magnitude, on the persisted value.
    assert!(
        effective <= actual,
        "a stored check-in was dated in the future"
    );
    assert!(
        actual - effective <= ceiling,
        "a stored check-in moved back more than 10 minutes"
    );

    let day =
        emp::record_attendance(&conn, &cashier, id, AttendanceAction::CheckOut, None).unwrap();
    let actual = crate::time::parse_timestamp(day.check_out_actual_at.as_ref().unwrap()).unwrap();
    let effective =
        crate::time::parse_timestamp(day.check_out_effective_at.as_ref().unwrap()).unwrap();
    assert!(
        effective >= actual,
        "a stored check-out was dated in the past"
    );
    assert!(
        effective - actual <= ceiling,
        "a stored check-out moved forward more than 10 minutes"
    );
}

#[test]
fn the_actual_clock_reading_is_preserved_verbatim_alongside_the_rounding() {
    // "Do not round twice" needs both halves to be true at once: the effective
    // value is rounded exactly once by the service, and the untouched reading
    // survives so the true moment is still on disk for audit.
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    let day = emp::record_attendance(&conn, &cashier, id, AttendanceAction::CheckIn, None).unwrap();

    let actual = crate::time::parse_timestamp(day.check_in_actual_at.as_ref().unwrap()).unwrap();
    // The actual is the machine's clock, never a derived value: it sits within a
    // second of "now", not on the grid.
    assert!((crate::time::now_utc() - actual).num_seconds().abs() <= 2);
    // And the effective one is exactly the grid projection of it — a single pass.
    assert_eq!(
        crate::time::parse_timestamp(day.check_in_effective_at.as_ref().unwrap()).unwrap(),
        attendance::effective_instant(actual, AttendanceAction::CheckIn)
    );
    // Re-rounding the persisted effective value is a no-op, which is what makes a
    // second rounding pass structurally incapable of changing it.
    let effective =
        crate::time::parse_timestamp(day.check_in_effective_at.as_ref().unwrap()).unwrap();
    assert_eq!(
        attendance::effective_instant(effective, AttendanceAction::CheckIn),
        effective
    );
}

#[test]
fn worked_hours_use_the_effective_timestamps() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    let today = crate::time::today_business_date();

    // Written directly because the service always stamps "now"; this asserts
    // the CALCULATION, which is what reads the effective pair.
    conn.execute(
        "INSERT INTO attendance_days (employee_id, business_date, state,
             check_in_actual_at, check_in_effective_at,
             check_out_actual_at, check_out_effective_at, recorded_by_user_id)
         VALUES (?1, ?2, 'PRESENT',
             '2026-09-27 06:13:00Z', '2026-09-27 06:10:00Z',
             '2026-09-27 15:16:00Z', '2026-09-27 15:20:00Z', ?3)",
        rusqlite::params![id, today, cashier.id],
    )
    .unwrap();

    // 09:10 -> 18:20 Cairo = 9h10m, computed from the EFFECTIVE pair and not
    // from the 09:13 / 18:16 actual readings.
    let row = row_for(&conn, id);
    assert_eq!(row.attendance_days, Some(1));
    assert_eq!(row.worked_minutes, Some(550));
}

#[test]
fn a_duplicate_check_in_is_rejected() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    emp::record_attendance(&conn, &cashier, id, AttendanceAction::CheckIn, None).unwrap();
    let err =
        emp::record_attendance(&conn, &cashier, id, AttendanceAction::CheckIn, None).unwrap_err();
    assert!(matches!(err, AppError::Conflict(_)));
}

#[test]
fn a_check_out_without_a_check_in_is_rejected() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    let err =
        emp::record_attendance(&conn, &cashier, id, AttendanceAction::CheckOut, None).unwrap_err();
    assert!(matches!(err, AppError::BusinessRule(_)));
}

#[test]
fn a_second_check_out_is_rejected() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    emp::record_attendance(&conn, &cashier, id, AttendanceAction::CheckIn, None).unwrap();
    // Push both stamps into the past so the "check-out before check-in" guard is
    // not what rejects the second close. The ACTUAL pair is moved with the
    // effective one, because the database CHECK keeps the two in lockstep.
    conn.execute(
        "UPDATE attendance_days
         SET check_in_effective_at = '2020-01-01 06:00:00Z',
             check_in_actual_at = '2020-01-01 06:00:00Z',
             check_out_effective_at = '2020-01-02 06:00:00Z',
             check_out_actual_at = '2020-01-02 06:00:00Z'",
        [],
    )
    .unwrap();
    let err =
        emp::record_attendance(&conn, &cashier, id, AttendanceAction::CheckOut, None).unwrap_err();
    assert!(matches!(err, AppError::Conflict(_)));
}

#[test]
fn absence_and_leave_never_overwrite_a_punch_pair() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    emp::record_attendance(&conn, &cashier, id, AttendanceAction::CheckIn, None).unwrap();
    for action in [AttendanceAction::Absent, AttendanceAction::Leave] {
        assert!(emp::record_attendance(&conn, &manager, id, action, None).is_err());
    }
}

#[test]
fn an_inactive_employee_cannot_have_attendance() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    emp::set_employee_status(&conn, &manager, id, "INACTIVE").unwrap();
    let err =
        emp::record_attendance(&conn, &manager, id, AttendanceAction::CheckIn, None).unwrap_err();
    assert!(err.to_string().contains("attendance.employee_inactive"));
}

#[test]
fn deactivating_an_employee_suspends_the_linked_login() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    emp::set_employee_status(&conn, &manager, id, "INACTIVE").unwrap();
    let err = auth::login(
        &conn,
        &auth::LoginInput {
            name: "cashier".into(),
            password: "3456".into(),
        },
    )
    .unwrap_err();
    assert!(matches!(err, AppError::Unauthorized(_)));
}

#[test]
fn absence_is_never_inferred_from_a_missing_record() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    // No attendance was ever recorded. Every counter must read zero: a day
    // nobody wrote down is NOT an absence.
    let row = row_for(&conn, id);
    assert_eq!(row.attendance_days, Some(0));
    assert_eq!(row.absence_days, Some(0));
    assert_eq!(row.leave_days, Some(0));
}

#[test]
fn a_manager_can_record_an_explicit_absence() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    emp::record_attendance(&conn, &manager, id, AttendanceAction::Absent, None).unwrap();
    let row = row_for(&conn, id);
    assert_eq!(row.absence_days, Some(1));
    assert_eq!(row.attendance_days, Some(0));
}

#[test]
fn a_correction_voids_the_old_day_and_keeps_it_on_disk() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    let day = emp::record_attendance(&conn, &cashier, id, AttendanceAction::CheckIn, None).unwrap();

    let replaced = emp::correct_attendance(
        &conn,
        &manager,
        id,
        &day.business_date,
        AttendanceAction::Absent,
        None,
    )
    .unwrap();
    assert_eq!(replaced.state, "ABSENT");
    assert_ne!(replaced.id, day.id);

    // The original row still exists, marked voided, with its state intact.
    let (voided_at, state): (Option<String>, String) = conn
        .query_row(
            "SELECT voided_at, state FROM attendance_days WHERE id = ?1",
            [day.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(voided_at.is_some());
    assert_eq!(state, "PRESENT");
    // And the live view shows only the replacement.
    assert_eq!(row_for(&conn, id).absence_days, Some(1));
    assert_eq!(row_for(&conn, id).attendance_days, Some(0));
}

// -------------------------------------------------------------- authorization

#[test]
fn a_cashier_may_record_their_own_attendance() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    assert!(emp::record_attendance(&conn, &cashier, id, AttendanceAction::CheckIn, None).is_ok());
}

#[test]
fn a_cashier_may_punch_another_cashier() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let other_id = employee_of(&conn, &login_as(&conn, "momo", "11111"));
    // The roster a cashier sees is an ATTENDANCE OPERATION table, so taking a
    // colleague's punch is the operation it exists for. What stays forbidden is
    // everything about the person, not the punch.
    let day = emp::record_attendance(&conn, &cashier, other_id, AttendanceAction::CheckIn, None)
        .expect("a cashier records a colleague's check-in");
    // The recorder is the SESSION, never a caller-supplied id.
    assert_eq!(day.recorded_by_user_id, cashier.id);
    assert_eq!(day.employee_id, other_id);
}

#[test]
fn a_cashier_may_file_an_absence_for_anybody() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let other_id = employee_of(&conn, &login_as(&conn, "momo", "11111"));
    // All four actions are attendance operations. The DAY-STATE algebra, not the
    // role, decides whether the filing is legal — so a second absence on the same
    // day is still refused, by the domain rule rather than by a permission.
    for target in [employee_of(&conn, &cashier), other_id] {
        let day = emp::record_attendance(&conn, &cashier, target, AttendanceAction::Absent, None)
            .expect("a cashier files an absence");
        assert_eq!(day.state, "ABSENT");
    }
}

#[test]
fn attendance_legality_is_still_the_day_state_algebra_not_the_role() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let other_id = employee_of(&conn, &login_as(&conn, "momo", "11111"));
    emp::record_attendance(&conn, &cashier, other_id, AttendanceAction::CheckIn, None).unwrap();
    // Being allowed to punch does not make every punch legal: a second check-in
    // and an absence over a present day are both refused as BUSINESS conflicts.
    for (action, expected) in [
        (AttendanceAction::CheckIn, "attendance.already_checked_in"),
        (AttendanceAction::Absent, "attendance.already_present"),
        (AttendanceAction::Leave, "attendance.already_present"),
    ] {
        let err = emp::record_attendance(&conn, &cashier, other_id, action, None).unwrap_err();
        assert!(
            err.to_string().contains(expected),
            "{action:?} produced {err}"
        );
    }
}

#[test]
fn a_cashier_may_record_a_wash_workers_attendance() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let mahmoud = wash_worker(&conn, "محمود");

    let day =
        emp::record_attendance(&conn, &cashier, mahmoud, AttendanceAction::CheckIn, None).unwrap();
    // The recorder is the SESSION user, not something the caller supplied.
    assert_eq!(day.recorded_by_user_id, cashier.id);
    assert_eq!(day.recorded_by_name, "cashier");
    // And the day belongs to the wash worker, not to the cashier.
    assert_eq!(day.employee_id, mahmoud);
}

#[test]
fn a_wash_worker_attendance_is_stamped_with_the_recorders_active_shift() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let shift = crate::services::shifts::open_shift(&conn, &cashier, 0).unwrap();
    let mahmoud = wash_worker(&conn, "محمود");

    let day =
        emp::record_attendance(&conn, &cashier, mahmoud, AttendanceAction::CheckIn, None).unwrap();
    assert_eq!(day.shift_id, Some(shift));
}

#[test]
fn a_cashier_sees_no_salary_and_no_money_in_their_payload() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let list = emp::list(&conn, &cashier, &EmployeePeriod::default(), "", true).unwrap();
    assert!(!list.management_visible);
    // The salary field is ABSENT, not zeroed: the browser never held it.
    assert!(list.employees.iter().all(|row| row.base_salary.is_none()));
}

#[test]
fn a_cashiers_roster_carries_only_what_an_attendance_operation_needs() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    // Give the record something in EVERY restricted field, so a projection that
    // leaked anything would have a real value to leak.
    emp::set_base_salary(&conn, &manager, id, 300_000).unwrap();
    emp::update_employee(
        &conn,
        &manager,
        id,
        &EmployeeInput {
            name: "cashier".into(),
            phone: None,
            employee_type: emp::CASHIER.into(),
            base_salary: Some(0),
            notes: Some("a private HR note".into()),
            user_id: None,
            role: None,
            password: None,
        },
    )
    .unwrap();

    let rows = emp::list(&conn, &cashier, &EmployeePeriod::default(), "", true)
        .unwrap()
        .employees;
    let mine = rows.iter().find(|r| r.id == id).expect("own row");
    let peer = rows.iter().find(|r| r.id != id).expect("a colleague row");

    for row in [mine, peer] {
        // Nothing about the person beyond identity, employment status and today.
        assert_eq!(row.base_salary, None, "salary leaked");
        assert_eq!(row.notes, None, "notes leaked");
        assert_eq!(row.login_role, None, "login role leaked");
        assert_eq!(row.attendance_days, None, "attendance analytics leaked");
        assert_eq!(row.worked_minutes, None, "hours analytics leaked");
        assert_eq!(row.absence_days, None, "absence analytics leaked");
        assert_eq!(row.leave_days, None, "leave analytics leaked");
        assert_eq!(row.shifts_count, None, "performance leaked");
        assert_eq!(row.cafe_revenue, None, "revenue leaked");
    }

    // What an attendance operation legitimately needs IS there, for every row.
    for row in &rows {
        assert!(!row.name.is_empty(), "the roster needs a name to punch");
        assert!(!row.employee_type.is_empty());
        assert!(
            !row.status.is_empty(),
            "status decides whether a punch is legal"
        );
    }
}

#[test]
fn a_manager_sees_the_full_employee_row() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    emp::set_base_salary(&conn, &manager, id, 300_000).unwrap();

    let list = emp::list(&conn, &manager, &EmployeePeriod::default(), "", true).unwrap();
    assert!(list.management_visible);
    let row = list.employees.iter().find(|r| r.id == id).unwrap();
    // Restricting the CASHIER must not have cost the MANAGER anything: every
    // figure the management screen renders is still present.
    assert_eq!(row.base_salary, Some(300_000));
    assert_eq!(row.login_role.as_deref(), Some("STAFF"));
    assert_eq!(row.attendance_days, Some(0));
    assert_eq!(row.shifts_count, Some(0));
}

#[test]
fn a_cashier_is_created_with_a_working_login_and_the_chosen_role() {
    let conn = fresh();
    let manager = login(&conn, "manager");

    // The database CHECK refuses a CASHIER with no login, so creating one and
    // creating their account are the same operation. This is what the merged
    // employees form does, and it must produce a person who can actually sign in.
    let id = emp::create_employee(
        &conn,
        &manager,
        &EmployeeInput {
            name: "كريمة".into(),
            phone: Some("01000000009".into()),
            employee_type: emp::CASHIER.into(),
            base_salary: Some(250_000),
            notes: None,
            user_id: None,
            role: Some("MANAGER".into()),
            password: Some("4321".into()),
        },
    )
    .unwrap();

    let employee = employees::find(&conn, id).unwrap().unwrap();
    assert!(employee.user_id.is_some());
    // The role the person was actually created with, not the employee type.
    assert_eq!(employee.login_role.as_deref(), Some("MANAGER"));

    // And the credential works: the new manager can sign in immediately.
    let signed_in = login_as(&conn, "كريمة", "4321");
    assert_eq!(signed_in.role, "MANAGER");

    // The one-to-one link is real, so attendance resolves to this person.
    assert_eq!(employee_of(&conn, &signed_in), id);
}

#[test]
fn a_cashier_without_a_password_is_refused_rather_than_half_created() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    // The form always sends a password for a new cashier, but a crafted request
    // must not be able to create an employee the database then rejects.
    let err = emp::create_employee(
        &conn,
        &manager,
        &EmployeeInput {
            name: "بلا حساب".into(),
            phone: None,
            employee_type: emp::CASHIER.into(),
            base_salary: Some(0),
            notes: None,
            user_id: None,
            role: None,
            password: None,
        },
    )
    .unwrap_err();
    assert!(matches!(err, AppError::Validation(ref key) if key == "employee.login_required"));
    // Nothing was left behind: no orphan employee and no orphan login.
    assert!(!employees::list(&conn, true)
        .unwrap()
        .iter()
        .any(|e| e.name == "بلا حساب"));
}

#[test]
fn only_an_admin_may_create_another_admin() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    // The privilege-escalation guard the old staff dialog relied on, now enforced
    // by the one service that can mint an account.
    let err = emp::create_employee(
        &conn,
        &manager,
        &EmployeeInput {
            name: "مدير جديد".into(),
            phone: None,
            employee_type: emp::CASHIER.into(),
            base_salary: Some(0),
            notes: None,
            user_id: None,
            role: Some("ADMIN".into()),
            password: Some("6666".into()),
        },
    )
    .unwrap_err();
    assert!(matches!(err, AppError::Unauthorized(_)));

    // An ADMIN may, and the account really is an ADMIN.
    let admin = login(&conn, "admin");
    let id = emp::create_employee(
        &conn,
        &admin,
        &EmployeeInput {
            name: "مدير النظام الثاني".into(),
            phone: None,
            employee_type: emp::CASHIER.into(),
            base_salary: Some(0),
            notes: None,
            user_id: None,
            role: Some("ADMIN".into()),
            password: Some("6666".into()),
        },
    )
    .unwrap();
    assert_eq!(
        employees::find(&conn, id)
            .unwrap()
            .unwrap()
            .login_role
            .as_deref(),
        Some("ADMIN")
    );
}

#[test]
fn a_wash_worker_is_never_given_a_credential() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    // Even with a password supplied, a wash worker gets no login: the role means
    // "no authentication", and the form must not be able to talk it out of that.
    let id = emp::create_employee(
        &conn,
        &manager,
        &EmployeeInput {
            name: "محمود".into(),
            phone: None,
            employee_type: emp::WASH_WORKER.into(),
            base_salary: Some(150_000),
            notes: None,
            user_id: None,
            role: Some("MANAGER".into()),
            password: Some("5555".into()),
        },
    )
    .unwrap();
    let employee = employees::find(&conn, id).unwrap().unwrap();
    assert_eq!(employee.user_id, None);
    assert_eq!(employee.login_role, None);
}

#[test]
fn a_may_not_deactivate_an_admin() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let admin = login(&conn, "admin");
    // The guard the old staff screen enforced for SUSPENDED logins, preserved for
    // the employees status command.
    let err = emp::set_employee_status(&conn, &manager, employee_of(&conn, &admin), "INACTIVE")
        .unwrap_err();
    assert!(matches!(err, AppError::Unauthorized(_)));
    // An ADMIN still may.
    assert!(
        emp::set_employee_status(&conn, &admin, employee_of(&conn, &manager), "INACTIVE").is_ok()
    );
}

#[test]
fn a_cashier_is_refused_the_manager_only_reads_and_writes() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    assert!(matches!(
        emp::overview(&conn, &cashier, &EmployeePeriod::default()).unwrap_err(),
        AppError::Unauthorized(_)
    ));
    assert!(matches!(
        emp::details(&conn, &cashier, id, &EmployeePeriod::default()).unwrap_err(),
        AppError::Unauthorized(_)
    ));
    assert!(emp::create_employee(
        &conn,
        &cashier,
        &EmployeeInput {
            name: "x".into(),
            phone: None,
            employee_type: emp::WASH_WORKER.into(),
            base_salary: Some(0),
            notes: None,
            user_id: None,
            role: None,
            password: None,
        }
    )
    .is_err());
    assert!(emp::create_payroll_run(&conn, &cashier, id, "2026-09", 0).is_err());
}

/// The full end-to-end authorization matrix, asserted through the SERVICE rather
/// than through the UI. UI hiding is not authorization: every one of these calls
/// is a Tauri command a modified client could invoke directly, so each must be
/// refused by the backend on its own merits.
#[test]
fn the_permission_matrix_is_enforced_by_the_service() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let own = employee_of(&conn, &cashier);
    let peer = employee_of(&conn, &login_as(&conn, "momo", "11111"));
    let profile = |name: &str| EmployeeInput {
        name: name.into(),
        phone: None,
        employee_type: emp::CASHIER.into(),
        base_salary: Some(0),
        notes: None,
        user_id: None,
        role: None,
        password: None,
    };

    // --- CASHIER: attendance yes, everything about the person no ---------
    // Each action gets a FRESH database: all four are filed for the same
    // business day, and the day-state algebra (correctly) refuses a second
    // filing once a punch pair exists. What is being tested here is the
    // AUTHORIZATION, so the domain state must not be the thing under test.
    for action in [
        AttendanceAction::CheckIn,
        AttendanceAction::CheckOut,
        AttendanceAction::Absent,
        AttendanceAction::Leave,
    ] {
        let conn = fresh();
        let cashier = login(&conn, "cashier");
        let peer = employee_of(&conn, &login_as(&conn, "momo", "11111"));
        if action == AttendanceAction::CheckOut {
            emp::record_attendance(&conn, &cashier, peer, AttendanceAction::CheckIn, None).unwrap();
        }
        let day = emp::record_attendance(&conn, &cashier, peer, action, None)
            .unwrap_or_else(|e| panic!("cashier must be able to record {action:?}: {e}"));
        // The recorder is the SESSION, never a caller-supplied id.
        assert_eq!(day.recorded_by_user_id, cashier.id);
        assert_eq!(day.employee_id, peer);
    }
    // View own employee record: yes, and it is resolved from the session.
    assert!(emp::my_attendance(&conn, &cashier)
        .unwrap()
        .employee
        .is_some());
    // View another employee's HR record: no.
    assert!(matches!(
        emp::details(&conn, &cashier, peer, &EmployeePeriod::default()).unwrap_err(),
        AppError::Unauthorized(_)
    ));
    // View salary / advances / payroll / analytics: no.
    assert!(emp::overview(&conn, &cashier, &EmployeePeriod::default()).is_err());
    assert!(emp::payroll_preview(&conn, &cashier, peer, "2026-09").is_err());
    assert!(emp::create_advance(
        &conn,
        &cashier,
        peer,
        &emp::AdvanceInput {
            amount: 1_000,
            advance_date: Some(crate::time::today_business_date()),
            reason: "x".into(),
        }
    )
    .is_err());
    // Create / edit / salary / status: no.
    assert!(emp::create_employee(&conn, &cashier, &profile("x")).is_err());
    assert!(emp::update_employee(&conn, &cashier, peer, &profile("x")).is_err());
    assert!(emp::set_base_salary(&conn, &cashier, peer, 1).is_err());
    assert!(emp::set_employee_status(&conn, &cashier, peer, "INACTIVE").is_err());
    // Correcting a recorded day: no — that is a separate, audited workflow.
    assert!(emp::correct_attendance(
        &conn,
        &cashier,
        peer,
        &crate::time::today_business_date(),
        AttendanceAction::Absent,
        None
    )
    .is_err());

    // --- MANAGER: every management capability survives -------------------
    assert!(emp::overview(&conn, &manager, &EmployeePeriod::default()).is_ok());
    assert!(emp::details(&conn, &manager, peer, &EmployeePeriod::default()).is_ok());
    let created = emp::create_employee(
        &conn,
        &manager,
        &EmployeeInput {
            role: Some("STAFF".into()),
            password: Some("6666".into()),
            ..profile("موظف جديد")
        },
    )
    .expect("a manager may create an employee");
    assert!(emp::update_employee(&conn, &manager, created, &profile("موظف جديد")).is_ok());
    assert!(emp::set_base_salary(&conn, &manager, created, 250_000).is_ok());
    assert!(emp::set_employee_status(&conn, &manager, created, "INACTIVE").is_ok());
    assert!(
        emp::record_attendance(&conn, &manager, created, AttendanceAction::Leave, None).is_err(),
        "an inactive employee has no attendance"
    );
    assert!(own > 0);
}

#[test]
fn the_employee_type_may_not_be_edited_away() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let mahmoud = wash_worker(&conn, "محمود");
    let err = emp::update_employee(
        &conn,
        &manager,
        mahmoud,
        &EmployeeInput {
            name: "محمود".into(),
            phone: None,
            employee_type: emp::CASHIER.into(),
            base_salary: Some(0),
            notes: None,
            user_id: None,
            role: None,
            password: None,
        },
    )
    .unwrap_err();
    assert!(err.to_string().contains("employee.type_is_immutable"));
}

#[test]
fn a_manager_may_not_deactivate_their_own_account() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    assert!(emp::set_employee_status(&conn, &manager, id, "INACTIVE").is_err());
}

// ------------------------------------------------------------- performance

/// A closed business day with a shift, so performance has something real to
/// attribute. Returns `(day_id, shift_id)`.
fn day_with_shift(conn: &Connection, manager: &User, cashier: &User, date: &str) -> (i64, i64) {
    let day_id = conn
        .execute(
            "INSERT INTO business_days (day_date, opened_at, status, opened_by)
             VALUES (?1, station_now(), 'CLOSED', ?2)",
            rusqlite::params![date, manager.id],
        )
        .map(|_| conn.last_insert_rowid())
        .unwrap();
    let shift_id = conn
        .execute(
            "INSERT INTO shifts (business_day_id, user_id, status, opened_at, closed_at)
             VALUES (?1, ?2, 'CLOSED', station_now(), station_now())",
            rusqlite::params![day_id, cashier.id],
        )
        .map(|_| conn.last_insert_rowid())
        .unwrap();
    (day_id, shift_id)
}

/// An invoice booked to a shift, optionally attributed to a wash worker.
fn invoice(
    conn: &Connection,
    day_id: i64,
    shift_id: i64,
    cashier: &User,
    cafe_total: i64,
    wash_total: i64,
    wash_employee_id: Option<i64>,
    status: &str,
) {
    conn.execute(
        "INSERT INTO invoices (invoice_no, business_day_id, shift_id, user_id, status,
             subtotal, total, cafe_total, wash_total, wash_employee_id)
         VALUES ((SELECT COALESCE(MAX(invoice_no), 0) + 1 FROM invoices),
             ?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            day_id,
            shift_id,
            cashier.id,
            status,
            cafe_total + wash_total,
            cafe_total,
            wash_total,
            wash_employee_id
        ],
    )
    .unwrap();
}

#[test]
fn a_cashier_is_measured_by_shifts_and_cafe_revenue() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    let (day_id, shift_id) = day_with_shift(&conn, &manager, &cashier, "2026-09-10");
    invoice(&conn, day_id, shift_id, &cashier, 12_000, 0, None, "PAID");
    invoice(&conn, day_id, shift_id, &cashier, 3_000, 0, None, "PAID");

    let row = row_for(&conn, id);
    assert_eq!(row.shifts_count, Some(1));
    assert_eq!(row.cafe_revenue, Some(15_000));
}

#[test]
fn a_partially_paid_invoice_still_counts_as_revenue() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    let (day_id, shift_id) = day_with_shift(&conn, &manager, &cashier, "2026-09-10");
    invoice(&conn, day_id, shift_id, &cashier, 10_000, 0, None, "PAID");
    invoice(
        &conn,
        day_id,
        shift_id,
        &cashier,
        99_000,
        0,
        None,
        "PARTIALLY_PAID",
    );

    // Both invoices are real documents, so both count: the attribution is the
    // invoice's own `cafe_total` snapshot, never a filtered subset.
    assert_eq!(row_for(&conn, id).cafe_revenue, Some(109_000));
}

#[test]
fn wash_revenue_is_never_attributed_to_an_individual_worker() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let mahmoud = wash_worker(&conn, "محمود");
    let other = wash_worker(&conn, "سيد");
    let (day_id, shift_id) = day_with_shift(&conn, &manager, &cashier, "2026-09-10");

    // Washing is a SHARED department: the 5,000 on this invoice was produced by
    // the wash department, and Mahmoud happened to be the one holding the hose.
    // Attributing the money to him would be a fabrication, so the row carries no
    // wash revenue at all — the aggregate was removed, not merely hidden.
    invoice(
        &conn,
        day_id,
        shift_id,
        &cashier,
        0,
        5_000,
        Some(mahmoud),
        "PAID",
    );
    invoice(
        &conn,
        day_id,
        shift_id,
        &cashier,
        0,
        7_000,
        Some(mahmoud),
        "PAID",
    );
    invoice(
        &conn,
        day_id,
        shift_id,
        &cashier,
        0,
        9_000,
        Some(other),
        "PAID",
    );
    invoice(&conn, day_id, shift_id, &cashier, 0, 100_000, None, "PAID");

    for id in [mahmoud, other] {
        let row = row_for(&conn, id);
        // A wash worker is managed on attendance and salary, never on money.
        assert_eq!(row.shifts_count, Some(0));
        assert_eq!(row.cafe_revenue, Some(0));
    }
}

#[test]
fn a_cashier_row_reports_the_login_role_not_the_employee_type() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");

    // The employee TYPE is CASHIER for every login, a manager's included. The
    // row must also carry the login's own role, because that is what the table's
    // badge is built from — otherwise every row would read "كاشير".
    let cashier_row = row_for(&conn, employee_of(&conn, &cashier));
    assert_eq!(cashier_row.employee_type, emp::CASHIER);
    assert_eq!(cashier_row.login_role.as_deref(), Some("STAFF"));

    let manager_row = row_for(&conn, employee_of(&conn, &manager));
    assert_eq!(manager_row.employee_type, emp::CASHIER);
    assert_eq!(manager_row.login_role.as_deref(), Some("MANAGER"));

    // A wash worker has no login, so its role is absent rather than guessed.
    let mahmoud = wash_worker(&conn, "محمود");
    assert_eq!(row_for(&conn, mahmoud).login_role, None);
}

#[test]
fn performance_follows_the_selected_date_range() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    let (september, shift_sept) = day_with_shift(&conn, &manager, &cashier, "2026-09-10");
    invoice(
        &conn, september, shift_sept, &cashier, 10_000, 0, None, "PAID",
    );
    let (october, shift_oct) = day_with_shift(&conn, &manager, &cashier, "2026-10-02");
    invoice(&conn, october, shift_oct, &cashier, 40_000, 0, None, "PAID");

    let in_september = rows(&conn, Some("2026-09-01"), Some("2026-09-30"))
        .into_iter()
        .find(|r| r.id == id)
        .unwrap();
    assert_eq!(in_september.shifts_count, Some(1));
    assert_eq!(in_september.cafe_revenue, Some(10_000));

    let in_october = rows(&conn, Some("2026-10-01"), Some("2026-10-31"))
        .into_iter()
        .find(|r| r.id == id)
        .unwrap();
    assert_eq!(in_october.shifts_count, Some(1));
    assert_eq!(in_october.cafe_revenue, Some(40_000));
}

#[test]
fn the_kpi_band_never_mixes_incompatible_employee_types() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let mahmoud = wash_worker(&conn, "محمود");
    let (day_id, shift_id) = day_with_shift(&conn, &manager, &cashier, "2026-09-10");
    invoice(&conn, day_id, shift_id, &cashier, 20_000, 0, None, "PAID");
    invoice(
        &conn,
        day_id,
        shift_id,
        &cashier,
        0,
        8_000,
        Some(mahmoud),
        "PAID",
    );

    let overview = emp::overview(&conn, &manager, &EmployeePeriod::default()).unwrap();
    let cashier_id = employee_of(&conn, &cashier);

    // "Top shifts" and "top cafe revenue" describe the LOGIN that opened the
    // shift, so they must name the cashier and never a wash worker. There is
    // deliberately no wash leader to check: the wash department's money is not
    // attributable to a person and is reported at department level instead.
    assert_eq!(overview.top_shifts.unwrap().employee_id, cashier_id);
    assert_eq!(overview.top_cafe_revenue.unwrap().employee_id, cashier_id);
    // The wash revenue booked above must never crown the worker it names: the
    // band has no wash leader at all, so the wash employee's row is excluded
    // from these two leaderboards by employee type, not by luck.
    let wash_row = row_for(&conn, mahmoud);
    assert_eq!(wash_row.employee_type, emp::WASH_WORKER);
    assert!(
        wash_row.login_role.is_none(),
        "a wash worker holds no login"
    );
    // A wash worker is still a headcount, even without a leaderboard of their own.
    let (employees, expected_cashiers, wash_workers) = fixture_headcount(&conn);
    assert_eq!(overview.total_wash_workers, wash_workers);
    assert!(wash_workers > 0, "the fixture must contain a wash worker");
    // The two type headcounts are disjoint populations: a wash worker can never
    // be presented as a cashier, and the band never mixes the two.
    assert_eq!(overview.total_cashiers, expected_cashiers);
    assert_eq!(overview.total_employees, employees);
    assert!(expected_cashiers + wash_workers <= employees);
}

#[test]
fn the_cashier_headcount_names_the_staff_role_not_the_employee_type() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    wash_worker(&conn, "محمود");

    // EVERY login in Station is a `CASHIER` employee, so `employee_type` alone
    // counts the admin and the managers as cashiers too — which is exactly the
    // mistake the table's badge never makes. "كاشير" is the STAFF role, so the
    // headcount must agree with the badge on the row below it.
    let overview = emp::overview(&conn, &manager, &EmployeePeriod::default()).unwrap();
    // Counted from the ACTIVE roster, which is the population the overview reduces:
    // counting the inactive-inclusive list here would make this compare two
    // different populations and disagree by however many stopped people exist.
    let cashiers: i64 = rows_active(&conn)
        .iter()
        .filter(|r| r.login_role.as_deref() == Some("STAFF"))
        .count() as i64;
    let (employees, expected_cashiers, wash_workers) = fixture_headcount(&conn);

    assert_eq!(overview.total_cashiers, cashiers);
    assert_eq!(overview.total_cashiers, expected_cashiers);
    assert!(
        expected_cashiers > 0,
        "the fixture must contain STAFF logins"
    );
    // The type still counts everybody who holds a login, so the two figures are
    // genuinely different facts and neither is derived from the other.
    assert_eq!(overview.total_employees, employees);
    assert_eq!(overview.total_wash_workers, wash_workers);
    // The two figures differ whenever a non-STAFF login exists, which is what
    // makes this a real check of role-vs-type rather than a tautology.
    assert!(
        overview.total_employees > overview.total_cashiers,
        "an ADMIN/MANAGER login is an employee but not a cashier"
    );
}

#[test]
fn headcounts_count_unique_employee_records_never_duplicated_rows() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    wash_worker(&conn, "محمود");

    // Attendance, shifts and invoices are CHILDREN: a person with a hundred of
    // them is still one employee, so the headcount must not move.
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    for day in ["2026-09-01", "2026-09-02", "2026-09-03"] {
        let (day_id, shift_id) = day_with_shift(&conn, &manager, &cashier, day);
        invoice(&conn, day_id, shift_id, &cashier, 5_000, 0, None, "PAID");
    }
    emp::record_attendance(&conn, &cashier, id, AttendanceAction::CheckIn, None).unwrap();

    let overview = emp::overview(&conn, &manager, &EmployeePeriod::default()).unwrap();
    let (employees, expected_cashiers, wash_workers) = fixture_headcount(&conn);
    assert_eq!(overview.total_employees, employees);
    assert_eq!(overview.total_cashiers, expected_cashiers);
    assert_eq!(overview.total_wash_workers, wash_workers);

    // And the same person handed to the reduction twice is still one person.
    // Read from the ACTIVE roster, because that is what the overview was
    // reduced from — doubling a different population would compare two
    // different lists and prove nothing about de-duplication.
    let mut rows = rows_active(&conn);
    let doubled = rows.clone();
    rows.extend(doubled);
    let reduced = emp::reduce_overview(&rows);
    assert_eq!(reduced.total_employees, overview.total_employees);
    assert_eq!(reduced.total_cashiers, overview.total_cashiers);
    assert_eq!(reduced.total_wash_workers, overview.total_wash_workers);
}

#[test]
fn a_leader_with_no_activity_is_reported_as_no_leader() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    wash_worker(&conn, "محمود");
    let overview = emp::overview(&conn, &manager, &EmployeePeriod::default()).unwrap();
    // Nobody sold anything, so there is no "top" — a zero is not a leader.
    assert!(overview.top_cafe_revenue.is_none());
    assert!(overview.top_shifts.is_none());
    // Fabricating a leader out of an idle roster would be the real failure, so
    // the leaderless case is checked against the whole band, not just the two
    // money/shift tiles: an employee with no activity leads nothing either.
    assert!(overview.top_attendance.is_none());
    assert!(overview.top_hours.is_none());
    // The headcounts are still real: the roster exists, it is simply idle.
    let (employees, expected_cashiers, wash_workers) = fixture_headcount(&conn);
    assert_eq!(overview.total_employees, employees);
    assert_eq!(overview.total_cashiers, expected_cashiers);
    assert_eq!(overview.total_wash_workers, wash_workers);
    assert!(wash_workers > 0, "the fixture must contain a wash worker");
}

// ------------------------------------------------------- advances & payroll

fn advance(amount: i64, date: &str, reason: &str) -> emp::AdvanceInput {
    emp::AdvanceInput {
        amount,
        advance_date: Some(date.into()),
        reason: reason.into(),
    }
}

#[test]
fn an_advance_is_created_and_preserved_forever() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    let advance_id =
        emp::create_advance(&conn, &manager, id, &advance(5_000, "2026-09-10", "سلفة")).unwrap();

    let stored = employee_analytics::find_advance(&conn, advance_id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.amount, 5_000);
    assert_eq!(stored.status, "RECORDED");
    assert_eq!(stored.reason, "سلفة");
    assert_eq!(stored.created_by_name, "manager");
}

#[test]
fn an_advance_must_be_a_positive_amount_with_a_reason_and_a_real_date() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    assert!(emp::create_advance(&conn, &manager, id, &advance(0, "2026-09-10", "x")).is_err());
    assert!(emp::create_advance(&conn, &manager, id, &advance(-100, "2026-09-10", "x")).is_err());
    assert!(emp::create_advance(&conn, &manager, id, &advance(100, "2026-09-10", "  ")).is_err());
    assert!(emp::create_advance(&conn, &manager, id, &advance(100, "10/09/2026", "x")).is_err());
}

#[test]
fn a_reversed_advance_keeps_its_row_and_leaves_the_totals() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    let advance_id =
        emp::create_advance(&conn, &manager, id, &advance(5_000, "2026-09-10", "سلفة")).unwrap();

    emp::reverse_advance(&conn, &manager, advance_id).unwrap();
    let stored = employee_analytics::find_advance(&conn, advance_id)
        .unwrap()
        .unwrap();
    // The row and its amount survive; only the status and stamp changed.
    assert_eq!(stored.status, "REVERSED");
    assert_eq!(stored.amount, 5_000);
    assert!(stored.reversed_at.is_some());
    // And the money is out of the totals.
    assert_eq!(
        employee_analytics::advances_total(&conn, id, Some("2026-09-01"), Some("2026-09-30"))
            .unwrap(),
        0
    );
    // A second reversal is refused.
    assert!(emp::reverse_advance(&conn, &manager, advance_id).is_err());
}

#[test]
fn a_finalized_month_snapshots_its_own_salary_and_survives_a_raise() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    emp::set_base_salary(&conn, &manager, id, 300_000).unwrap();
    emp::create_advance(&conn, &manager, id, &advance(50_000, "2026-09-10", "سلفة")).unwrap();

    let run = emp::create_payroll_run(&conn, &manager, id, "2026-09", 0).unwrap();
    assert_eq!(run.base_salary, 300_000);
    assert_eq!(run.advances, 50_000);
    assert_eq!(run.net_salary, 250_000);
    assert_eq!(run.status, "DRAFT");

    emp::finalize_payroll_run(&conn, &manager, run.id).unwrap();

    // October's raise cannot touch a finalized September run: the run no longer
    // reads `employees` at all.
    emp::set_base_salary(&conn, &manager, id, 500_000).unwrap();
    let september = employee_analytics::find_run(&conn, run.id)
        .unwrap()
        .unwrap();
    assert_eq!(september.base_salary, 300_000);
    assert_eq!(september.net_salary, 250_000);
    assert_eq!(september.status, "FINALIZED");
}

#[test]
fn a_finalized_run_can_never_be_rewritten() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    let run = emp::create_payroll_run(&conn, &manager, id, "2026-09", 0).unwrap();
    emp::finalize_payroll_run(&conn, &manager, run.id).unwrap();

    // A second finalize, a re-create, and an advance reversal over a month that
    // has already been paid are all refused.
    assert!(emp::finalize_payroll_run(&conn, &manager, run.id).is_err());
    assert!(emp::create_payroll_run(&conn, &manager, id, "2026-09", 0).is_err());
    let advance_id =
        emp::create_advance(&conn, &manager, id, &advance(1_000, "2026-09-20", "سلفة")).unwrap();
    assert!(emp::reverse_advance(&conn, &manager, advance_id).is_err());
}

#[test]
fn a_rejected_payroll_write_leaves_nothing_behind() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    // A finalized September, so the re-create is refused...
    let september = emp::create_payroll_run(&conn, &manager, id, "2026-09", 0).unwrap();
    emp::finalize_payroll_run(&conn, &manager, september.id).unwrap();
    assert!(emp::create_payroll_run(&conn, &manager, id, "2026-09", 0).is_err());
    // ...and the refused transaction wrote no second row.
    assert_eq!(employee_analytics::runs_of(&conn, id).unwrap().len(), 1);
}

#[test]
fn payroll_derives_no_deduction_from_an_absence() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    // A person CREATED here rather than taken from the demo fixture, so the month
    // under test holds exactly the one attendance day this test files and not one
    // extra absence the seeder happened to roll for somebody.
    let id = emp::create_employee(
        &conn,
        &manager,
        &EmployeeInput {
            name: "نجوى".into(),
            phone: None,
            employee_type: emp::CASHIER.into(),
            base_salary: Some(200_000),
            notes: None,
            user_id: None,
            role: None,
            password: Some("6789".into()),
        },
    )
    .unwrap();
    let day = emp::record_attendance(&conn, &manager, id, AttendanceAction::Absent, None).unwrap();
    // An absence is filed against TODAY's business date, so the period under test
    // is read back from the record itself. A hardcoded month would put the day
    // outside the window the moment the clock crossed into the next one, and the
    // preview would then correctly report no absence at all.
    let period = day.business_date[..7].to_string();

    let preview = emp::payroll_preview(&conn, &manager, id, &period).unwrap();
    assert_eq!(preview.absence_days, 1);
    // Station documents no attendance-based penalty, so the net is untouched by
    // the absence — it is REPORTED, not priced.
    assert_eq!(preview.deductions, 0);
    assert_eq!(preview.net_salary, 200_000);
}

#[test]
fn the_net_salary_formula_is_one_rule() {
    assert_eq!(emp::compute_net(200_000, 50_000, 0), 150_000);
    assert_eq!(emp::compute_net(200_000, 0, 20_000), 180_000);
    // A floor, so a month can never pay a negative salary.
    assert_eq!(emp::compute_net(10_000, 50_000, 0), 0);
}

#[test]
fn a_malformed_payroll_period_is_rejected_not_guessed() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    for period in ["2026", "2026-9", "2026-13", "2026-00", "not-a-period"] {
        assert!(
            emp::payroll_preview(&conn, &manager, id, period).is_err(),
            "{period} must be rejected"
        );
    }
}

#[test]
fn payroll_covers_every_day_of_a_leap_february_and_of_december() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    // February 2028 is a leap month (29 days); February 2027 is not (28). The
    // last day is derived from the calendar, never from a days-in-month table.
    assert!(emp::payroll_preview(&conn, &manager, id, "2028-02").is_ok());
    assert!(emp::payroll_preview(&conn, &manager, id, "2027-02").is_ok());
    assert_eq!(
        emp::payroll_preview(&conn, &manager, id, "2026-12")
            .unwrap()
            .period,
        "2026-12"
    );
}

#[test]
fn payroll_counts_present_absent_and_leave_without_overlap() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    for (date, state) in [
        ("2026-09-01", "PRESENT"),
        ("2026-09-02", "ABSENT"),
        ("2026-09-03", "LEAVE"),
    ] {
        // A PRESENT day carries its punch pair — the database refuses one without.
        conn.execute(
            "INSERT INTO attendance_days (employee_id, business_date, state,
                 check_in_actual_at, check_in_effective_at, recorded_by_user_id)
             VALUES (?1, ?2, ?3,
                 CASE WHEN ?3 = 'PRESENT' THEN '2026-09-01 06:00:00Z' END,
                 CASE WHEN ?3 = 'PRESENT' THEN '2026-09-01 06:00:00Z' END,
                 ?4)",
            rusqlite::params![id, date, state, manager.id],
        )
        .unwrap();
    }

    let preview = emp::payroll_preview(&conn, &manager, id, "2026-09").unwrap();
    assert_eq!(preview.attendance_days, 1);
    assert_eq!(preview.absence_days, 1);
    assert_eq!(preview.leave_days, 1);
    assert_eq!(
        preview.attendance_days + preview.absence_days + preview.leave_days,
        3
    );
}

#[test]
fn a_voided_attendance_day_leaves_the_payroll_snapshot() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    let day = emp::record_attendance(&conn, &cashier, id, AttendanceAction::CheckIn, None).unwrap();
    let period = day.business_date[..7].to_string();
    assert_eq!(
        emp::payroll_preview(&conn, &manager, id, &period)
            .unwrap()
            .attendance_days,
        1
    );

    emp::correct_attendance(
        &conn,
        &manager,
        id,
        &day.business_date,
        AttendanceAction::Absent,
        None,
    )
    .unwrap();
    let after = emp::payroll_preview(&conn, &manager, id, &period).unwrap();
    assert_eq!(after.attendance_days, 0);
    assert_eq!(after.absence_days, 1);
}

// ----------------------------------------------------------- date-range gate

#[test]
fn a_malformed_period_is_rejected_before_it_reaches_a_query() {
    assert!(emp::validate_period(&EmployeePeriod {
        from: Some("not-a-date".into()),
        to: None,
    })
    .is_err());
    assert!(emp::validate_period(&EmployeePeriod {
        from: Some("2026-09-01".into()),
        to: Some("2026-09-30".into()),
    })
    .is_ok());
    // An empty bound means "unbounded", exactly like the reports service.
    let unbounded = EmployeePeriod {
        from: Some("  ".into()),
        to: Some(String::new()),
    };
    assert!(emp::validate_period(&unbounded).is_ok());
    assert_eq!(unbounded.bounds(), (None, None));
}

#[test]
fn attendance_counters_follow_the_selected_date_range() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    for date in ["2026-09-10", "2026-09-11", "2026-10-01"] {
        conn.execute(
            "INSERT INTO attendance_days (employee_id, business_date, state,
                 check_in_actual_at, check_in_effective_at, recorded_by_user_id)
             VALUES (?1, ?2, 'PRESENT', '2026-09-10 06:00:00Z', '2026-09-10 06:00:00Z', ?3)",
            rusqlite::params![id, date, cashier.id],
        )
        .unwrap();
    }

    let in_september = rows(&conn, Some("2026-09-01"), Some("2026-09-30"))
        .into_iter()
        .find(|r| r.id == id)
        .unwrap();
    assert_eq!(in_september.attendance_days, Some(2));
    let in_october = rows(&conn, Some("2026-10-01"), Some("2026-10-31"))
        .into_iter()
        .find(|r| r.id == id)
        .unwrap();
    assert_eq!(in_october.attendance_days, Some(1));
}

/// The login id behind an employee, so a credential change can be aimed at it.
fn user_of(conn: &Connection, employee_id: i64) -> i64 {
    let user_id: i64 = conn
        .query_row(
            "SELECT user_id FROM employees WHERE id = ?1",
            [employee_id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(user_id > 0, "this employee is expected to have a login");
    user_id
}

/// The stored PHC string for a login.
///
/// Read with SQL on purpose. The `users::User` struct this application passes
/// around — the one that is serialized to the frontend — has NO `password_hash`
/// field at all, so there is no API through which a caller (or a test) could
/// accidentally come to depend on a hash the UI could also see.
fn stored_hash(conn: &Connection, user_id: i64) -> String {
    conn.query_row(
        "SELECT password_hash FROM users WHERE id = ?1",
        [user_id],
        |r| r.get(0),
    )
    .expect("a login exists")
}

// ---------------------------------------------------------------------------
// PASSWORD MANAGEMENT FROM THE EMPLOYEES SURFACE
//
// The employee edit dialog lets an ADMIN set a NEW password for a colleague. The
// feature deliberately reuses the EXISTING `auth::change_password` command — one
// authorization gate, one hashing implementation, one audit trail — so these tests
// pin what that reuse is supposed to guarantee, at the service layer where it is
// actually enforced:
//
//   - an authorized actor can set a new password, and only the HASH is stored;
//   - the plaintext never reaches the database in any form;
//   - the old password stops working and the new one starts, which is the only
//     honest proof that the change happened;
//   - an empty password is a validation error, never "silently blank the login";
//   - a role without authority is refused at the service, so hiding the field in
//     the dialog is never what makes the rule true.
// ---------------------------------------------------------------------------

/// The happy path: an ADMIN sets a colleague's new password, and it works.
#[test]
fn an_admin_can_set_a_new_password_for_an_employee() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let cashier = login(&conn, "cashier");
    let target = user_of(&conn, employee_of(&conn, &cashier));

    auth::change_password(&conn, &admin, target, "1212")
        .expect("an ADMIN may set a colleague's password");

    // The proof is behavioural, not structural: the old credential is dead and the
    // new one authenticates. Anything else is a change nobody can rely on.
    assert!(auth::login(
        &conn,
        &auth::LoginInput {
            name: "cashier".into(),
            password: "3456".into(),
        }
    )
    .is_err());
    let session = auth::login(
        &conn,
        &auth::LoginInput {
            name: "cashier".into(),
            password: "1212".into(),
        },
    )
    .expect("the new password authenticates");
    assert_eq!(session.user.id, cashier.id);
}

/// A change is a REPLACEMENT, not an addition: the previous password is dead even
/// though it was never sent anywhere or shown to anyone.
#[test]
fn setting_a_new_password_replaces_the_old_one() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let manager = login(&conn, "manager");
    let target = user_of(&conn, employee_of(&conn, &manager));

    let before = stored_hash(&conn, target);
    auth::change_password(&conn, &admin, target, "3434").unwrap();
    let after = stored_hash(&conn, target);

    // Argon2id salts every hash, so a genuinely different value proves a fresh
    // hash was computed rather than a stale one written back.
    assert_ne!(before, after);
    assert!(auth::verify_password("3434", &after));
    assert!(!auth::verify_password("2345", &after));
}

/// SECURITY: only the hash is persisted. The plaintext must appear nowhere in the
/// stored value, and it must still be a PHC string the shared verifier reads —
/// i.e. the ONE hashing implementation was used, not a second one.
#[test]
fn only_the_hash_is_persisted_never_the_plaintext() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let cashier = login(&conn, "cashier");
    let target = user_of(&conn, employee_of(&conn, &cashier));
    let plaintext = "4242";

    auth::change_password(&conn, &admin, target, plaintext).unwrap();

    let stored = stored_hash(&conn, target);
    assert!(
        !stored.contains(plaintext),
        "the plaintext must never be persisted"
    );
    // Argon2id PHC string: $argon2id$...$salt$hash.
    assert!(
        stored.starts_with("$argon2id$"),
        "unexpected hash form: {stored}"
    );
    assert!(auth::verify_password(plaintext, &stored));
}

/// An empty password is REFUSED by the shared rule, not accepted as "clear the
/// credential". The dialog's empty field means "do not change it" and sends
/// nothing at all; if it ever sent this, the service must still say no.
#[test]
fn an_empty_password_is_refused_and_leaves_the_credential_intact() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let cashier = login(&conn, "cashier");
    let target = user_of(&conn, employee_of(&conn, &cashier));
    let before = stored_hash(&conn, target);

    let err = auth::change_password(&conn, &admin, target, "").unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
    assert_eq!(stored_hash(&conn, target), before, "the hash must not move");
}

/// The ordinary edit the dialog sends when the field is left EMPTY: no password
/// reaches the employee service at all, and the login behind the record is
/// untouched. This is the regression that matters most — an unrelated name or
/// salary correction must never reset a colleague's credential.
#[test]
fn an_ordinary_employee_edit_does_not_change_the_password() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let cashier = login(&conn, "cashier");
    let employee_id = employee_of(&conn, &cashier);
    let before = stored_hash(&conn, cashier.id);

    emp::update_employee(
        &conn,
        &admin,
        employee_id,
        &EmployeeInput {
            name: "كاشير معدّل".into(),
            phone: None,
            employee_type: emp::CASHIER.into(),
            base_salary: Some(0),
            notes: None,
            user_id: None,
            role: None,
            password: None,
        },
    )
    .expect("an ordinary edit succeeds");

    assert_eq!(
        stored_hash(&conn, cashier.id),
        before,
        "an unrelated edit must never reset the credential"
    );
    assert!(auth::login(
        &conn,
        &auth::LoginInput {
            name: "cashier".into(),
            password: "3456".into(),
        }
    )
    .is_ok());
}

/// A password below the shared minimum is refused BEFORE anything is written.
#[test]
fn a_credential_the_policy_forbids_is_rejected_and_changes_nothing() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let cashier = login(&conn, "cashier");
    let target = user_of(&conn, employee_of(&conn, &cashier));
    let before = stored_hash(&conn, target);

    // Every shape the 4–5 digit PIN rule refuses. The point of the test is that a
    // refused write leaves the STORED credential untouched, so it is checked
    // against the hash and not merely against the returned error.
    for forbidden in ["123", "123456", "1234a", "abcd", "12-34", ""] {
        let err = auth::change_password(&conn, &admin, target, forbidden).unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "{forbidden:?} must be a validation error, got {err:?}"
        );
        assert_eq!(
            stored_hash(&conn, target),
            before,
            "a refused credential must not touch the stored hash ({forbidden:?})"
        );
    }

    // …and the boundary values the rule DOES accept, so the rejection above
    // cannot be satisfied by a service that simply refuses everything.
    for accepted in ["1234", "55555"] {
        auth::change_password(&conn, &admin, target, accepted).unwrap();
        assert!(auth::verify_password(accepted, &stored_hash(&conn, target)));
    }
}

/// AUTHORIZATION, enforced at the service layer and not by the form.
///
/// A STAFF has no authority over another person's credential. This is asserted
/// against the service directly, so hiding the field in the dialog cannot be what
/// makes it true.
#[test]
fn a_staff_cannot_change_another_persons_password() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let manager = login(&conn, "manager");
    let target = user_of(&conn, employee_of(&conn, &manager));
    let before = stored_hash(&conn, target);

    let err = auth::change_password(&conn, &cashier, target, "hijack-attempt").unwrap_err();
    assert!(matches!(err, AppError::Unauthorized(_)), "got {err:?}");
    assert_eq!(stored_hash(&conn, target), before);
    // The attempt left the colleague's credential alone: they can still sign in.
    assert!(auth::login(
        &conn,
        &auth::LoginInput {
            name: "manager".into(),
            password: "2345".into(),
        }
    )
    .is_ok());
}

/// The pre-existing gate for ANOTHER person's credential is `MANAGER`+ — the
/// employees surface inherited it by reusing the command rather than by inventing
/// a second rule. Pinned here so a future role change cannot silently move what
/// an ADMIN may do through this screen.
///
/// Note the asymmetry this makes explicit: the DIALOG offers the field to an ADMIN
/// only, which is NARROWER than this boundary. The service is authoritative; the
/// narrower UI is a deliberate restriction layered on top of it, never the thing
/// that enforces it.
#[test]
fn another_persons_credential_stays_a_manager_capability_at_the_service() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let cashier = login(&conn, "cashier");
    let target = user_of(&conn, employee_of(&conn, &cashier));

    auth::change_password(&conn, &manager, target, "9090")
        .expect("the service gate is MANAGER+, unchanged by this feature");
    assert!(auth::login(
        &conn,
        &auth::LoginInput {
            name: "cashier".into(),
            password: "9090".into(),
        }
    )
    .is_ok());
}

/// Self-service is unchanged: anyone may still change their OWN password, which is
/// how a user recovers a forgotten credential with no ADMIN involved at all.
#[test]
fn a_user_may_still_change_their_own_password() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");

    auth::change_password(&conn, &cashier, cashier.id, "5656").unwrap();

    assert!(auth::login(
        &conn,
        &auth::LoginInput {
            name: "cashier".into(),
            password: "5656".into(),
        }
    )
    .is_ok());
}

/// The change is AUDITED as `user.password_changed`, attributed to the actor who
/// performed it — the same trail every other privileged action writes to.
#[test]
fn a_password_change_is_written_to_the_audit_log_without_the_credential() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let cashier = login(&conn, "cashier");
    let target = user_of(&conn, employee_of(&conn, &cashier));

    auth::change_password(&conn, &admin, target, "7878").unwrap();

    let (actor, before_json, after_json): (i64, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT actor_id, before_json, after_json FROM audit_log
             WHERE action = 'user.password_changed' AND entity_id = ?1
             ORDER BY id DESC LIMIT 1",
            [target.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("the change is audited");
    assert_eq!(actor, admin.id);
    // Neither half of the audit row may have captured the credential it describes.
    for json in [before_json, after_json] {
        assert!(
            !json.unwrap_or_default().contains("7878"),
            "the audit trail must not record the password"
        );
    }
}

/// The feature sends the NEW password and nothing else: no hash, no current
/// password. The employee payloads the edit dialog reads carry no credential field
/// at all, which is asserted by serializing the real response.
#[test]
fn no_employee_payload_carries_any_credential_field() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let list = emp::list(&conn, &manager, &EmployeePeriod::default(), "", false).unwrap();
    let json = serde_json::to_string(&list.employees).unwrap();

    assert!(!json.contains("password"), "a credential leaked: {json}");
    assert!(!json.contains("hash"), "a hash leaked: {json}");
    assert!(!json.contains("$argon2"), "a PHC string leaked: {json}");
}
/// THE WHOLE EDIT MODAL FLOW, end to end, through the services the dialog calls.
///
/// The unit tests above each pin one rule. This one walks the sequence the
/// employee edit dialog actually performs, in the order it performs it, so that
/// no combination of individually-correct rules can leave the record in a state
/// the manager did not ask for:
///
///   1. open the dialog  — the dialog reads the employee payload, which carries
///      no credential of any kind (so "the field opens empty" has nothing to be
///      filled from, and there is no value that could be prefilled wrongly);
///   2. save an UNRELATED field — no credential command is issued at all, and the
///      colleague can still sign in with the PIN they always had;
///   3. replace the PIN — the new one authenticates and the old one stops
///      working, which is the only honest proof the change landed;
///   4. save another unrelated field AFTER the change — the replacement survives,
///      so an ordinary edit can never quietly undo the previous one.
#[test]
fn the_edit_modal_flow_preserves_then_replaces_an_existing_credential() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let cashier = login(&conn, "cashier");
    let employee_id = employee_of(&conn, &cashier);
    let target = user_of(&conn, employee_id);
    let original = crate::demo_data::demo_password_of("cashier").unwrap();

    let edit = |name: &str| EmployeeInput {
        name: name.into(),
        phone: None,
        employee_type: emp::CASHIER.into(),
        base_salary: Some(0),
        notes: None,
        user_id: None,
        role: None,
        // What the dialog sends on every edit: the credential is NOT an employee
        // field, so it never rides along on the payload in either direction.
        password: None,
    };

    // 1. OPEN. The dialog's only credential source is the employee payload.
    let opened = serde_json::to_string(
        &emp::details(&conn, &admin, employee_id, &EmployeePeriod::default())
            .unwrap()
            .employee,
    )
    .unwrap();
    assert!(
        !opened.contains("password") && !opened.contains("$argon2"),
        "the dialog must have no credential to prefill from: {opened}"
    );

    // 2. SAVE WITHOUT TOUCHING THE CREDENTIAL.
    let hash_before = stored_hash(&conn, target);
    emp::update_employee(&conn, &admin, employee_id, &edit("كاشير معدّل")).unwrap();
    assert_eq!(
        stored_hash(&conn, target),
        hash_before,
        "an unrelated edit must not rewrite the credential"
    );
    assert!(auth::login(
        &conn,
        &auth::LoginInput {
            name: "cashier".into(),
            password: original.into(),
        }
    )
    .is_ok());

    // 3. REPLACE IT: the dialog issues `change_password` for the LOGIN id only.
    let replacement = if original == "55555" { "2214" } else { "55555" };
    auth::change_password(&conn, &admin, target, replacement).unwrap();
    assert!(
        auth::login(
            &conn,
            &auth::LoginInput {
                name: "cashier".into(),
                password: original.into(),
            }
        )
        .is_err(),
        "the replaced credential must stop authenticating"
    );
    assert!(auth::login(
        &conn,
        &auth::LoginInput {
            name: "cashier".into(),
            password: replacement.into(),
        }
    )
    .is_ok());

    // 4. AND ANOTHER UNRELATED EDIT MUST NOT UNDO IT.
    let hash_after = stored_hash(&conn, target);
    emp::update_employee(&conn, &admin, employee_id, &edit("كاشير معدّل مرة أخرى")).unwrap();
    assert_eq!(stored_hash(&conn, target), hash_after);
    assert!(auth::login(
        &conn,
        &auth::LoginInput {
            name: "cashier".into(),
            password: replacement.into(),
        }
    )
    .is_ok());
}

/// The credential policy is enforced by the SERVICE, so the dialog's guarantee
/// does not depend on the field being well-behaved. Every value the issue lists
/// as invalid is refused here, and — the part that matters — a refused write
/// leaves the stored hash byte-for-byte identical, so a rejected credential can
/// never leave a colleague unable to sign in.
#[test]
fn the_service_refuses_every_credential_the_edit_dialog_cannot_hold() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let cashier = login(&conn, "cashier");
    let target = user_of(&conn, employee_of(&conn, &cashier));
    let before = stored_hash(&conn, target);

    for invalid in ["123", "123456", "abcd", "12a4", "12-34", "", "  ", "٢٢١٤"] {
        let err = auth::change_password(&conn, &admin, target, invalid).unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "{invalid:?} must be a validation error, got {err:?}"
        );
        assert_eq!(
            stored_hash(&conn, target),
            before,
            "a refused credential must leave the stored hash untouched ({invalid:?})"
        );
    }
    // Both accepted boundary lengths, so the refusal above cannot be satisfied by
    // a service that simply refuses everything.
    for valid in ["1234", "55555"] {
        auth::change_password(&conn, &admin, target, valid).unwrap();
        assert!(auth::verify_password(valid, &stored_hash(&conn, target)));
    }
}
