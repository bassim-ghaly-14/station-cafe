//! Offline verification for the Employees domain.
//!
//! Station is a 100% offline-first application, and the Employees feature has to
//! keep that promise. This file exists to make the claim TESTABLE rather than
//! merely asserted:
//!
//!  - every operation runs against a REAL SQLite FILE on disk (not an in-memory
//!    database), so the durability and the "source of truth is local" part of
//!    the claim are actually exercised;
//!  - the workflow is the whole feature end to end — roster, wash-worker
//!    attendance, cashier punch, performance attribution, advance, payroll
//!    snapshot and finalisation;
//!  - the test is written so it can be run inside a network-denying sandbox
//!    (`sandbox-exec -p '(version 1)(allow default)(deny network*)'` on macOS,
//!    `unshare -n` on Linux). Nothing here needs a socket, so it passes either
//!    way — and passing under the sandbox is the actual proof.
//!
//! The data is read back through a SECOND, freshly opened connection to the
//! same file, which makes this a persistence test rather than a cache-warming
//! one.

use crate::db::{self, DB_FILE};
use crate::repositories::employee_analytics;
use crate::services::attendance::AttendanceAction;
use crate::services::auth::{self, User};
use crate::services::employees::{self as emp, EmployeeInput};
use rusqlite::Connection;
use std::path::PathBuf;

/// A unique scratch directory for one run, so parallel tests never collide.
fn scratch_dir(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("station-offline-{label}-{nanos}"));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

/// Migrate + seed a database AT A PATH — the same file the production app opens.
fn open_real_db(dir: &PathBuf) -> Connection {
    let path = dir.join(DB_FILE);
    let conn = Connection::open(&path).expect("open real db file");
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.pragma_update(None, "synchronous", "FULL").unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    db::migrate(&conn).expect("migrate real db file");
    crate::seed::run_if_empty(&conn).expect("seed real db file");
    conn
}

fn login_as(conn: &Connection, name: &str, password: &str) -> User {
    auth::login(
        conn,
        &auth::LoginInput {
            name: name.into(),
            password: password.into(),
        },
    )
    .expect("login")
    .user
}

fn cashier_of(conn: &Connection, user: &User) -> i64 {
    crate::repositories::employees::find_by_user(conn, user.id)
        .unwrap()
        .expect("cashier employee")
        .id
}

/// A closed business day plus a shift, so performance has real rows to read.
fn day_with_shift(conn: &Connection, manager: &User, cashier: &User, date: &str) -> (i64, i64) {
    conn.execute(
        "INSERT INTO business_days (day_date, opened_at, status, opened_by)
         VALUES (?1, station_now(), 'CLOSED', ?2)",
        rusqlite::params![date, manager.id],
    )
    .unwrap();
    let day_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO shifts (business_day_id, user_id, status, opened_at, closed_at)
         VALUES (?1, ?2, 'CLOSED', station_now(), station_now())",
        rusqlite::params![day_id, cashier.id],
    )
    .unwrap();
    (day_id, conn.last_insert_rowid())
}

/// The whole Employees feature, on a real file, with no network in sight.
#[test]
fn the_whole_employees_feature_runs_with_no_network() {
    let dir = scratch_dir("workflow");
    let conn = open_real_db(&dir);

    let manager = login_as(&conn, "manager", "manager123");
    let cashier = login_as(&conn, "cashier", "cashier123");
    let cashier_id = cashier_of(&conn, &cashier);

    // --- 1. A wash worker exists and has NO login -----------------------
    let mahmoud = emp::create_employee(
        &conn,
        &manager,
        &EmployeeInput {
            name: "محمود".into(),
            phone: None,
            employee_type: emp::WASH_WORKER.into(),
            base_salary: Some(150_000),
            notes: None,
            user_id: None,
            role: None,
            password: None,
        },
    )
    .expect("create wash worker");
    let mahmoud_record = crate::repositories::employees::find(&conn, mahmoud)
        .unwrap()
        .expect("wash worker record");
    assert_eq!(
        mahmoud_record.user_id, None,
        "a wash worker must have no login"
    );
    assert_eq!(mahmoud_record.employee_type, emp::WASH_WORKER);

    // --- 2. The cashier records the wash worker's attendance -------------
    // The event carries the RECORDER (the session), not a caller-supplied id.
    let shift = crate::services::shifts::open_shift(&conn, &cashier, 0).expect("open shift");
    let today = crate::time::today_business_date();
    let wash_day =
        emp::record_attendance(&conn, &cashier, mahmoud, AttendanceAction::CheckIn, None)
            .expect("record wash worker check-in");
    assert_eq!(wash_day.recorded_by_user_id, cashier.id);
    assert_eq!(wash_day.shift_id, Some(shift));

    // --- 3. The cashier punches their own day ---------------------------
    let own = emp::record_attendance(&conn, &cashier, cashier_id, AttendanceAction::CheckIn, None)
        .expect("own check-in");
    assert_eq!(own.employee_id, cashier_id);
    // Both timestamps exist, and the effective one is the actual one put on the
    // attendance grid by Rust — the caller never supplies a time.
    let actual = crate::time::parse_timestamp(own.check_in_actual_at.as_ref().unwrap()).unwrap();
    let effective =
        crate::time::parse_timestamp(own.check_in_effective_at.as_ref().unwrap()).unwrap();
    assert_eq!(
        effective,
        crate::services::attendance::effective_instant(actual, AttendanceAction::CheckIn)
    );

    // --- 4. Money: an advance, then a monthly payroll snapshot ----------
    emp::set_base_salary(&conn, &manager, cashier_id, 300_000).unwrap();
    emp::create_advance(
        &conn,
        &manager,
        cashier_id,
        &emp::AdvanceInput {
            amount: 50_000,
            advance_date: Some(today.clone()),
            reason: "advance".into(),
        },
    )
    .expect("record advance");
    let run = emp::create_payroll_run(&conn, &manager, cashier_id, &today[..7], 0)
        .expect("create payroll run");
    assert_eq!(run.advances, 50_000);
    assert_eq!(run.net_salary, 250_000);
    emp::finalize_payroll_run(&conn, &manager, run.id).expect("finalize payroll");

    // --- 5. Performance comes from persisted invoice + shift rows -------
    let (day_id, shift_id) = day_with_shift(&conn, &manager, &cashier, &today);
    for (cafe, wash, worker) in [(20_000i64, 0i64, None), (0, 8_000, Some(mahmoud))] {
        conn.execute(
            "INSERT INTO invoices (invoice_no, business_day_id, shift_id, user_id, status,
                 subtotal, total, cafe_total, wash_total, wash_employee_id)
             VALUES ((SELECT COALESCE(MAX(invoice_no), 0) + 1 FROM invoices),
                 ?1, ?2, ?3, 'PAID', ?4, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                day_id,
                shift_id,
                cashier.id,
                cafe + wash,
                cafe,
                wash,
                worker
            ],
        )
        .unwrap();
    }

    let rows = employee_analytics::list_rows(
        &conn,
        &employee_analytics::Period {
            from: Some(today.clone()),
            to: Some(today.clone()),
        },
        true,
        true,
        "",
    )
    .expect("list employees");
    let cashier_row = rows.iter().find(|r| r.id == cashier_id).unwrap();
    let wash_row = rows.iter().find(|r| r.id == mahmoud).unwrap();
    assert_eq!(cashier_row.cafe_revenue, Some(20_000));
    // Wash money belongs to the WASH department, so no wash revenue is attributed
    // to an individual worker — the offline path is held to the same rule.
    assert_eq!(wash_row.shifts_count, Some(0));
    assert_eq!(wash_row.cafe_revenue, Some(0));
    // The roster still reports each person's real login role, which is what the
    // table's role badge renders.
    assert_eq!(cashier_row.login_role.as_deref(), Some("STAFF"));
    assert_eq!(wash_row.login_role, None);

    // --- 6. IT IS ON DISK: reopen the file and read it all back ----------
    drop(conn);
    let reopened = Connection::open(dir.join(DB_FILE)).expect("reopen the real db file");
    let stored: i64 = reopened
        .query_row("SELECT COUNT(*) FROM attendance_days", [], |r| r.get(0))
        .unwrap();
    assert_eq!(stored, 2, "both attendance days survived the close");
    let run_again = employee_analytics::find_run(&reopened, run.id)
        .unwrap()
        .expect("payroll run survived");
    assert_eq!(run_again.status, "FINALIZED");
    assert_eq!(run_again.net_salary, 250_000);

    let _ = std::fs::remove_dir_all(&dir);
}

/// Migrations are part of the offline story: a database written by an older
/// build must upgrade on a machine with no network, from SQL embedded in the
/// binary. This exercises that through the public `migrate` on a real file.
#[test]
fn migrations_apply_to_a_real_file_with_no_network() {
    let dir = scratch_dir("migrations");
    let path = dir.join(DB_FILE);
    {
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        db::migrate(&conn).expect("first migrate");
        // The applied-row COUNT is the invariant (the same one db.rs asserts):
        // `migration_count()` is the number of migration entries, and the version
        // numbers themselves are not required to be gap-free.
        let applied: i64 = conn
            .query_row("SELECT COUNT(*) FROM _migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(applied, db::migration_count());
        let latest: i64 = conn
            .query_row("SELECT MAX(version) FROM _migrations", [], |r| r.get(0))
            .unwrap();
        // The employees domain really is in that file, at the newest version.
        assert!(
            latest >= 31,
            "the employees migrations must have been applied"
        );
    }
    // Re-opening an already-migrated file is a no-op, exactly as the running app
    // does on every launch.
    {
        let conn = Connection::open(&path).unwrap();
        db::migrate(&conn).expect("second migrate is idempotent");
        let applied: i64 = conn
            .query_row("SELECT COUNT(*) FROM _migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(applied, db::migration_count());
        // The employees domain really is in that file.
        for table in [
            "employees",
            "attendance_days",
            "employee_advances",
            "payroll_runs",
        ] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "{table} must exist after migrating");
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}
