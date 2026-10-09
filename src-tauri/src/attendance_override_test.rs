//! Manager attendance override — the administrative correction, end to end.
//!
//! The override is the ONE attendance path that takes a time from a human, so
//! this file pins the four things that make it safe and distinct from a punch:
//!
//!  - **authorization** — MANAGER and above, refused by the SERVICE, not by the
//!    screen that offers the button;
//!  - **exactness** — the stated time is stored verbatim, earlier or later, with
//!    no rounding and no second rounding pass;
//!  - **integrity** — the ordering rules and the business-day bucket still hold;
//!  - **traceability** — the superseded row is voided, never edited, and the
//!    audit entry carries the previous pair and the new one.
//!
//! Everything runs against a migrated, seeded in-memory SQLite file: the real
//! schema, the real CHECK constraints and the real SQL, with no network and no
//! mock. Cairo is UTC+3 in September, so 08:10 at the café is `05:10Z`, and
//! every fixture is written in that zone.
use crate::db::migrate;
use crate::demo_data::seed_for_development as run_if_empty;
use crate::error::AppError;
use crate::repositories::employee_analytics;
use crate::repositories::employees;
use crate::services::attendance::{self, AttendanceAction};
use crate::services::auth::{self, User};
use crate::services::employees::{self as emp, EmployeeInput};
use rusqlite::Connection;

/// Migrated + seeded in-memory database.
fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    run_if_empty(&conn).unwrap();
    conn
}

/// Log in as one of the seeded starter accounts.
fn login(conn: &Connection, name: &str) -> User {
    login_with(
        conn,
        name,
        crate::demo_data::demo_password_of(name)
            .unwrap_or_else(|| panic!("{name} is not a seeded demo account")),
    )
}

/// Log in with an explicit password — the starter list is not uniform (`momo` and
/// `foly` use short PINs).
fn login_with(conn: &Connection, name: &str, password: &str) -> User {
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

/// The business day every test corrects, and the pair it starts from: 08:10 ->
/// 16:10 at the café, both ALREADY on the attendance grid. A test that fails can
/// therefore only be failing because of the override, never because of a
/// rounding artefact in the fixture.
const DAY: &str = "2026-09-27";
const IN_08_10: &str = "2026-09-27 05:10:00Z";
const OUT_16_10: &str = "2026-09-27 13:10:00Z";

/// Write a closed PRESENT day directly, so the fixture is a fixed pair rather
/// than whatever the machine's clock said a moment ago.
fn recorded_pair(
    conn: &Connection,
    employee_id: i64,
    recorder: i64,
    check_in: &str,
    check_out: Option<&str>,
) {
    conn.execute(
        "INSERT INTO attendance_days (employee_id, business_date, state,
             check_in_actual_at, check_in_effective_at,
             check_out_actual_at, check_out_effective_at, recorded_by_user_id)
         VALUES (?1, ?2, 'PRESENT', ?3, ?3, ?4, ?4, ?5)",
        rusqlite::params![employee_id, DAY, check_in, check_out, recorder],
    )
    .unwrap();
}

/// The live row for the fixture day.
fn live_day(conn: &Connection, employee_id: i64) -> employee_analytics::AttendanceDay {
    employee_analytics::day_of_employee(conn, employee_id, DAY)
        .unwrap()
        .expect("the day is still on file")
}

/// The newest override audit entry: who, the previous values, the new ones.
///
/// `None` when no override has ever been written — which is itself an assertion
/// worth making in the refusal tests: a refused override must leave no trace.
fn last_override_audit(conn: &Connection) -> Option<(Option<i64>, Option<String>, Option<String>)> {
    conn.query_row(
        "SELECT actor_id, before_json, after_json FROM audit_log
         WHERE action = 'attendance.override' ORDER BY id DESC LIMIT 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .ok()
}

// ------------------------------------------------------------- authorization

#[test]
fn an_admin_can_override_a_day() {
    let conn = fresh();
    let admin = login(&conn, "admin");
    let id = employee_of(&conn, &admin);
    recorded_pair(&conn, id, admin.id, IN_08_10, Some(OUT_16_10));

    let day = emp::override_attendance(&conn, &admin, id, DAY, Some("08:00"), None, None).unwrap();

    // 08:00 Cairo, stored verbatim as BOTH the actual and the effective reading.
    assert_eq!(
        day.check_in_actual_at.as_deref(),
        Some("2026-09-27 05:00:00Z")
    );
    assert_eq!(
        day.check_in_effective_at.as_deref(),
        Some("2026-09-27 05:00:00Z")
    );
    // The side the manager did not mention is carried over untouched, including
    // the machine's own reading of it.
    assert_eq!(day.check_out_actual_at.as_deref(), Some(OUT_16_10));
    assert_eq!(day.check_out_effective_at.as_deref(), Some(OUT_16_10));
    assert_eq!(day.business_date, DAY);
    // And the day is the manager's from now on: that is what distinguishes an
    // adjusted record from a punched one on the live row.
    assert_eq!(day.recorded_by_user_id, admin.id);
    assert_eq!(day.worked_minutes, Some(490));
}

#[test]
fn a_manager_can_override_any_employee_including_a_wash_worker() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    // A wash worker has no login at all, so the roster is the ONLY way they are
    // ever recorded — and a manager must be able to correct it.
    let worker = wash_worker(&conn, "محمود");
    recorded_pair(&conn, worker, manager.id, IN_08_10, Some(OUT_16_10));

    let day = emp::override_attendance(
        &conn,
        &manager,
        worker,
        DAY,
        Some("07:30"),
        Some("17:00"),
        None,
    )
    .unwrap();

    assert_eq!(day.employee_id, worker);
    assert_eq!(
        day.check_in_effective_at.as_deref(),
        Some("2026-09-27 04:30:00Z")
    );
    assert_eq!(
        day.check_out_effective_at.as_deref(),
        Some("2026-09-27 14:00:00Z")
    );
    assert_eq!(day.recorded_by_user_id, manager.id);
}

#[test]
fn a_cashier_is_refused_by_the_service() {
    let conn = fresh();
    let cashier = login(&conn, "cashier");
    let id = employee_of(&conn, &cashier);
    recorded_pair(&conn, id, cashier.id, IN_08_10, Some(OUT_16_10));

    // A CASHIER may take a punch for anyone — that grant is real. It is not a
    // grant to rewrite a recorded time, and the SERVICE is where that is refused.
    let err =
        emp::override_attendance(&conn, &cashier, id, DAY, Some("08:00"), None, None).unwrap_err();
    assert!(matches!(err, AppError::Unauthorized(_)), "got {err:?}");

    // Nothing moved: same live values, same recorder, and no audit entry.
    let day = live_day(&conn, id);
    assert_eq!(day.check_in_effective_at.as_deref(), Some(IN_08_10));
    assert_eq!(day.recorded_by_user_id, cashier.id);
    assert!(
        last_override_audit(&conn).is_none(),
        "a refused override wrote an audit entry"
    );
}

#[test]
fn a_plain_staff_login_is_refused_too() {
    // `momo` is a seeded STAFF account with no management surface at all, so it
    // is the clearest possible "not a manager" case.
    let conn = fresh();
    let staff = login_with(&conn, "momo", "11111");
    let target = employee_of(&conn, &login(&conn, "cashier"));
    recorded_pair(&conn, target, staff.id, IN_08_10, Some(OUT_16_10));

    let err = emp::override_attendance(
        &conn,
        &staff,
        target,
        DAY,
        Some("08:00"),
        Some("16:00"),
        None,
    )
    .unwrap_err();
    assert!(matches!(err, AppError::Unauthorized(_)), "got {err:?}");
    assert_eq!(
        live_day(&conn, target).check_in_effective_at.as_deref(),
        Some(IN_08_10)
    );
}

#[test]
fn a_wash_worker_can_never_authenticate_to_override() {
    // The fourth role has no login BY CONSTRUCTION, so the operation is not
    // merely gated for them — there is no session that could reach it.
    let conn = fresh();
    assert!(auth::login(
        &conn,
        &auth::LoginInput {
            name: "wash".into(),
            password: "wash123".into()
        },
    )
    .is_err());
    // And `WASH_WORKER` is an employee TYPE, not a role any permission is
    // derived from: the same person IS correctable by a manager.
    let manager = login(&conn, "manager");
    let worker = wash_worker(&conn, "محمود");
    recorded_pair(&conn, worker, manager.id, IN_08_10, Some(OUT_16_10));
    assert!(
        emp::override_attendance(&conn, &manager, worker, DAY, None, Some("16:00"), None).is_ok()
    );
}

// --------------------------------------------------------------- time changes

#[test]
fn a_manager_can_move_the_check_in_in_both_directions() {
    // Earlier AND later from the same 08:10 fixture. Neither direction is
    // special-cased: the stated time is the stored time.
    for (stated, expected) in [
        ("08:00", "2026-09-27 05:00:00Z"),
        ("08:30", "2026-09-27 05:30:00Z"),
    ] {
        let conn = fresh();
        let manager = login(&conn, "manager");
        let id = employee_of(&conn, &manager);
        recorded_pair(&conn, id, manager.id, IN_08_10, Some(OUT_16_10));

        let day =
            emp::override_attendance(&conn, &manager, id, DAY, Some(stated), None, None).unwrap();

        assert_eq!(day.check_in_effective_at.as_deref(), Some(expected));
        assert_eq!(day.check_in_actual_at.as_deref(), Some(expected));
    }
}

#[test]
fn a_manager_can_move_the_check_out_in_both_directions() {
    for (stated, expected) in [
        ("16:00", "2026-09-27 13:00:00Z"),
        ("16:30", "2026-09-27 13:30:00Z"),
    ] {
        let conn = fresh();
        let manager = login(&conn, "manager");
        let id = employee_of(&conn, &manager);
        recorded_pair(&conn, id, manager.id, IN_08_10, Some(OUT_16_10));

        let day =
            emp::override_attendance(&conn, &manager, id, DAY, None, Some(stated), None).unwrap();

        assert_eq!(day.check_out_effective_at.as_deref(), Some(expected));
        assert_eq!(day.check_out_actual_at.as_deref(), Some(expected));
    }
}

#[test]
fn an_override_is_never_rounded() {
    use chrono::Timelike;

    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    recorded_pair(&conn, id, manager.id, IN_08_10, Some(OUT_16_10));

    // Two times deliberately OFF the ten-minute grid, in both directions.
    let day = emp::override_attendance(
        &conn,
        &manager,
        id,
        DAY,
        Some("08:07"),
        Some("16:33"),
        Some("ساعة الحضور متأخرة"),
    )
    .unwrap();

    assert_eq!(
        day.check_in_effective_at.as_deref(),
        Some("2026-09-27 05:07:00Z")
    );
    assert_eq!(
        day.check_out_effective_at.as_deref(),
        Some("2026-09-27 13:33:00Z")
    );
    // The proof that no rounding happened: neither stored value is a grid point.
    for stamp in [
        day.check_in_effective_at.as_deref().unwrap(),
        day.check_out_effective_at.as_deref().unwrap(),
    ] {
        let local = crate::time::parse_timestamp(stamp)
            .unwrap()
            .with_timezone(&crate::time::BUSINESS_TZ);
        assert_ne!(
            local.minute() % 10,
            0,
            "{stamp} landed on the rounding grid"
        );
    }
    assert_eq!(day.worked_minutes, Some(506));
    // The reason rides along on the row's existing note, so an audit reader sees
    // WHY without a second mechanism being invented for it.
    assert_eq!(day.note.as_deref(), Some("ساعة الحضور متأخرة"));
}

#[test]
fn a_normal_punch_is_still_rounded_after_the_override_exists() {
    // The two paths in one database: the override feature must not have loosened
    // the rule that governs a punch.
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    let other = wash_worker(&conn, "محمود");
    recorded_pair(&conn, other, manager.id, IN_08_10, Some(OUT_16_10));
    emp::override_attendance(&conn, &manager, other, DAY, Some("08:07"), None, None).unwrap();

    let punched =
        emp::record_attendance(&conn, &manager, id, AttendanceAction::CheckIn, None).unwrap();
    let actual =
        crate::time::parse_timestamp(punched.check_in_actual_at.as_ref().unwrap()).unwrap();
    let effective =
        crate::time::parse_timestamp(punched.check_in_effective_at.as_ref().unwrap()).unwrap();
    // Still the machine's clock on one side, the single grid projection on the other.
    assert!((crate::time::now_utc() - actual).num_seconds().abs() <= 5);
    assert_eq!(
        effective,
        attendance::effective_instant(actual, AttendanceAction::CheckIn)
    );

    // …and the corrected day kept its off-grid value: the two never share a path.
    let corrected = live_day(&conn, other);
    assert_eq!(
        corrected.check_in_effective_at.as_deref(),
        Some("2026-09-27 05:07:00Z")
    );
}

#[test]
fn an_override_does_not_re_round_a_value_it_carries_over() {
    // The service replaces the whole row, so "carry the other side over" is a
    // real risk. An 08:03 stored by an earlier override must survive a
    // check-out-only override value for value.
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    recorded_pair(&conn, id, manager.id, IN_08_10, Some(OUT_16_10));
    emp::override_attendance(&conn, &manager, id, DAY, Some("08:03"), Some("16:37"), None).unwrap();

    let day =
        emp::override_attendance(&conn, &manager, id, DAY, None, Some("16:40"), None).unwrap();

    assert_eq!(
        day.check_in_effective_at.as_deref(),
        Some("2026-09-27 05:03:00Z")
    );
    assert_eq!(
        day.check_in_actual_at.as_deref(),
        Some("2026-09-27 05:03:00Z")
    );
    assert_eq!(
        day.check_out_effective_at.as_deref(),
        Some("2026-09-27 13:40:00Z")
    );
}

// ----------------------------------------------------------------- validation

#[test]
fn a_check_out_before_the_check_in_is_rejected() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    recorded_pair(&conn, id, manager.id, IN_08_10, Some(OUT_16_10));

    // Earlier than the recorded check-in…
    let err =
        emp::override_attendance(&conn, &manager, id, DAY, None, Some("07:00"), None).unwrap_err();
    assert!(
        err.to_string().contains("attendance.check_out_before_in"),
        "got {err}"
    );
    // …and equal to it, which is the same violation a normal check-out refuses.
    let err =
        emp::override_attendance(&conn, &manager, id, DAY, None, Some("08:10"), None).unwrap_err();
    assert!(
        err.to_string().contains("attendance.check_out_before_in"),
        "got {err}"
    );
    // The day is exactly as it was: a refused override writes nothing.
    let day = live_day(&conn, id);
    assert_eq!(day.check_out_effective_at.as_deref(), Some(OUT_16_10));
}

#[test]
fn a_check_in_after_the_check_out_is_rejected() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    recorded_pair(&conn, id, manager.id, IN_08_10, Some(OUT_16_10));

    let err =
        emp::override_attendance(&conn, &manager, id, DAY, Some("17:00"), None, None).unwrap_err();
    assert!(
        err.to_string().contains("attendance.check_out_before_in"),
        "got {err}"
    );
    assert_eq!(
        live_day(&conn, id).check_in_effective_at.as_deref(),
        Some(IN_08_10)
    );
}

#[test]
fn moving_both_sides_into_an_impossible_pair_is_rejected() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    recorded_pair(&conn, id, manager.id, IN_08_10, Some(OUT_16_10));

    // Each side is legal on its own and the PAIR is not. The rule is applied to
    // the pair the day will carry, not to whichever value happened to arrive
    // first — which is why the check happens after both are parsed.
    let err =
        emp::override_attendance(&conn, &manager, id, DAY, Some("18:00"), Some("09:00"), None)
            .unwrap_err();
    assert!(
        err.to_string().contains("attendance.check_out_before_in"),
        "got {err}"
    );
    let day = live_day(&conn, id);
    assert_eq!(day.check_in_effective_at.as_deref(), Some(IN_08_10));
    assert_eq!(day.check_out_effective_at.as_deref(), Some(OUT_16_10));
}

#[test]
fn a_malformed_time_is_rejected() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    recorded_pair(&conn, id, manager.id, IN_08_10, Some(OUT_16_10));

    for bad in [
        "8:0",
        "08-10",
        "0800",
        "24:00",
        "08:60",
        "غدا",
        "2026-09-27 08:10:00Z",
    ] {
        let err =
            emp::override_attendance(&conn, &manager, id, DAY, Some(bad), None, None).unwrap_err();
        assert!(
            err.to_string().contains("attendance.invalid_time"),
            "{bad} produced {err}"
        );
    }
    // A seconds-precision value is legal and exact: the format is closed, not
    // restricted to whole minutes.
    let day =
        emp::override_attendance(&conn, &manager, id, DAY, Some("08:07:30"), None, None).unwrap();
    assert_eq!(
        day.check_in_effective_at.as_deref(),
        Some("2026-09-27 05:07:30Z")
    );
}

#[test]
fn a_malformed_business_date_is_rejected() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    recorded_pair(&conn, id, manager.id, IN_08_10, Some(OUT_16_10));

    let err =
        emp::override_attendance(&conn, &manager, id, "27/09/2026", Some("08:00"), None, None)
            .unwrap_err();
    assert!(
        err.to_string().contains("attendance.invalid_date"),
        "got {err}"
    );
}

#[test]
fn an_override_never_moves_the_day_it_is_filed_under() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    recorded_pair(&conn, id, manager.id, IN_08_10, Some(OUT_16_10));

    // A late night shift, stated on the day's own date.
    let day =
        emp::override_attendance(&conn, &manager, id, DAY, Some("23:55"), Some("23:59"), None)
            .unwrap();
    assert_eq!(day.business_date, DAY);
    for stamp in [
        day.check_in_effective_at.as_deref().unwrap(),
        day.check_out_effective_at.as_deref().unwrap(),
    ] {
        let local = crate::time::parse_timestamp(stamp)
            .unwrap()
            .with_timezone(&crate::time::BUSINESS_TZ);
        assert_eq!(
            local.date_naive().to_string(),
            DAY,
            "{stamp} left its business day"
        );
    }

    // And the boundary is NOT silently resolved by rolling the time forward: an
    // early-morning check-out would have to become the NEXT day to fit, so it is
    // refused rather than moved. The day bucket never moves on an override.
    let err =
        emp::override_attendance(&conn, &manager, id, DAY, Some("22:00"), Some("00:10"), None)
            .unwrap_err();
    assert!(
        err.to_string().contains("attendance.check_out_before_in"),
        "got {err}"
    );
    // The refused pair changed nothing: the day still carries the late shift it
    // was given, under the same business date.
    let day = live_day(&conn, id);
    assert_eq!(day.business_date, DAY);
    assert_eq!(
        day.check_in_effective_at.as_deref(),
        Some("2026-09-27 20:55:00Z")
    );
    assert_eq!(
        day.check_out_effective_at.as_deref(),
        Some("2026-09-27 20:59:00Z")
    );
}

#[test]
fn an_override_needs_a_day_and_a_stated_time() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    recorded_pair(&conn, id, manager.id, IN_08_10, Some(OUT_16_10));

    // No time at all is not a correction.
    let err = emp::override_attendance(&conn, &manager, id, DAY, None, None, None).unwrap_err();
    assert!(
        err.to_string()
            .contains("attendance.override_requires_time"),
        "got {err}"
    );

    // A day nobody recorded cannot be adjusted out of thin air.
    let err =
        emp::override_attendance(&conn, &manager, id, "2026-09-26", Some("08:00"), None, None)
            .unwrap_err();
    assert!(
        err.to_string().contains("attendance.day_not_found"),
        "got {err}"
    );
}

#[test]
fn an_absence_carries_no_punch_pair_to_correct() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    conn.execute(
        "INSERT INTO attendance_days (employee_id, business_date, state, recorded_by_user_id)
         VALUES (?1, ?2, 'ABSENT', ?3)",
        rusqlite::params![id, DAY, manager.id],
    )
    .unwrap();

    let err =
        emp::override_attendance(&conn, &manager, id, DAY, Some("08:00"), Some("16:00"), None)
            .unwrap_err();
    assert!(
        err.to_string()
            .contains("attendance.override_requires_present"),
        "got {err}"
    );
}

#[test]
fn a_stopped_employee_keeps_the_rule_that_an_inactive_one_has_no_attendance() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    // A colleague, not the manager themselves: suspending one's own account is
    // refused by a different rule entirely, and the point here is the attendance
    // one — an INACTIVE employee has no attendance, so there is nothing to fix.
    let id = employee_of(&conn, &login(&conn, "cashier"));
    recorded_pair(&conn, id, manager.id, IN_08_10, Some(OUT_16_10));
    emp::set_employee_status(&conn, &manager, id, "INACTIVE").unwrap();

    let err =
        emp::override_attendance(&conn, &manager, id, DAY, Some("08:00"), None, None).unwrap_err();
    assert!(
        err.to_string().contains("attendance.employee_inactive"),
        "got {err}"
    );
}

// ----------------------------------------------------------- audit / history

#[test]
fn an_override_preserves_the_previous_and_the_new_values() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    recorded_pair(&conn, id, manager.id, IN_08_10, Some(OUT_16_10));

    emp::override_attendance(
        &conn,
        &manager,
        id,
        DAY,
        Some("08:00"),
        Some("16:30"),
        Some("خطأ في التسجيل"),
    )
    .unwrap();

    let (actor, before, after) =
        last_override_audit(&conn).expect("an accepted override always writes its audit entry");
    // WHO performed it, and WHEN — the audit table stamps its own created_at
    // inside the same transaction as the correction itself.
    assert_eq!(actor, Some(manager.id));
    let when: String = conn
        .query_row(
            "SELECT created_at FROM audit_log WHERE action = 'attendance.override'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!when.is_empty());
    // WHICH record, and both sides of it.
    let before = before.unwrap();
    let after = after.unwrap();
    assert!(
        before.contains(IN_08_10),
        "the previous check-in is missing: {before}"
    );
    assert!(
        before.contains(OUT_16_10),
        "the previous check-out is missing: {before}"
    );
    assert!(
        after.contains("2026-09-27 05:00:00Z"),
        "the new check-in is missing: {after}"
    );
    assert!(
        after.contains("2026-09-27 13:30:00Z"),
        "the new check-out is missing: {after}"
    );
    assert!(after.contains(DAY), "the business date is missing: {after}");
    assert!(
        after.contains("خطأ في التسجيل"),
        "the reason is missing: {after}"
    );
}

#[test]
fn the_superseded_row_is_kept_and_voided_rather_than_edited() {
    let conn = fresh();
    let manager = login(&conn, "manager");
    let id = employee_of(&conn, &manager);
    recorded_pair(&conn, id, manager.id, IN_08_10, Some(OUT_16_10));
    let original_id = conn.last_insert_rowid();

    emp::override_attendance(&conn, &manager, id, DAY, Some("08:00"), None, None).unwrap();

    // The old row is still on disk, with the machine's original readings and a
    // stamp saying WHO voided it and WHEN.
    let (check_in, voided_by, voided_at): (String, i64, String) = conn
        .query_row(
            "SELECT check_in_effective_at, voided_by_user_id, voided_at
             FROM attendance_days WHERE id = ?1",
            [original_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(check_in, IN_08_10);
    assert_eq!(voided_by, manager.id);
    assert!(!voided_at.is_empty());

    // …and the live row is a DIFFERENT row, so "one live record per employee per
    // day" still holds and the history is not overwritten.
    let live: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM attendance_days WHERE employee_id = ?1 AND voided_at IS NULL",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(live, 1);
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM attendance_days WHERE employee_id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(total, 2, "the superseded row was deleted instead of voided");
}
