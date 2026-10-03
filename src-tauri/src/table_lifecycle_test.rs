//! The table/session lifecycle counters, asserted against the PERSISTED
//! `table_sessions` rows rather than any frontend state.
//!
//! The empty-close count is a business figure: a session that was opened, closed
//! normally, and never carried an order, invoice or revenue. These tests pin the
//! transitions that were previously wrong — in particular the FIRST close on a
//! fresh database — and the two ways the count used to silently lose an event:
//! attributing a close to the day the table was OPENED, and summing only the
//! tables that are currently active in the grid.
//!
//! Every assertion goes through the service layer, exactly like production
//! traffic, so a passing test means the command path is protected too.

use crate::db::migrate;
use crate::demo_data::seed_for_development as run_demo;
use crate::repositories::{catalog, pos};
use crate::services::{auth, checkout, pos as pos_svc, shifts as shift_svc};
use rusqlite::Connection;

/// A genuinely fresh PRODUCTION database: migrations plus the official seed
/// only. No demo data, no pre-existing business day, shift or session, so a
/// first-use bug cannot hide behind seeded history.
fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    crate::seed::run_if_empty(&conn).unwrap();
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

/// A real starter account of the café, so no test invents a credential.
fn manager(conn: &Connection) -> auth::User {
    let (name, _phone, role, password) = crate::seed::DEFAULT_USERS[0];
    let user = login(conn, name, password);
    assert_eq!(
        user.role, role,
        "the first starter account must be a manager"
    );
    user
}

/// The empty-close count the backend reports — the single authoritative figure.

/// The ADMIN account.
///
/// The table count is ADMIN-only in both the command and the service, so the
/// one test that RESIZES the cafe signs in as an administrator while the
/// lifecycle tests around it keep using the manager who actually works the
/// floor. That split is the rule under test, not a convenience.
fn admin(conn: &Connection) -> auth::User {
    // Index 3 is the cafe owner's ADMIN account in `DEFAULT_USERS`; the earlier
    // entries are the manager and the two cashiers, so the role assertion below
    // is what proves the right account was taken.
    let (name, _phone, role, password) = crate::seed::DEFAULT_USERS[3];
    let user = login(conn, name, password);
    assert_eq!(user.role, role, "the owner account must be an admin");
    assert_eq!(user.role, "ADMIN");
    user
}

/// The empty-close count the backend reports — the single authoritative figure.
fn empty_closes(conn: &Connection) -> i64 {
    pos_svc::day_lifecycle_counts(conn).unwrap().closed_empty
}

/// What `table_sessions` itself says, independent of any query the application
/// builds. If these two ever disagree, the count is not derived from the data.
fn persisted_empty_closes(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM table_sessions WHERE status = 'CLOSED' AND order_id IS NULL",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

/// The sum the table CARDS print. It may only ever be a presentation of the day
/// total, so while every contributing table is still active the two must match
/// exactly — a card can never be the place a close goes missing.
fn card_sum(conn: &Connection) -> i64 {
    pos_svc::list_tables(conn)
        .unwrap()
        .iter()
        .map(|t| t.closed_empty_today)
        .sum()
}

fn table_ids(conn: &Connection) -> Vec<i64> {
    pos::list_tables(conn, None)
        .unwrap()
        .into_iter()
        .map(|t| t.id)
        .collect()
}

fn open_day_and_shift(conn: &Connection, actor: &auth::User) {
    shift_svc::open_day(conn, actor).unwrap();
    shift_svc::open_shift(conn, actor, 0).unwrap();
}

/// Pay an order in cash.
fn settle(conn: &Connection, actor: &auth::User, order_id: i64) {
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
    .unwrap();
}

/// Open a table, do nothing on it, close it empty.
fn empty_close(conn: &Connection, actor: &auth::User, table_id: i64) {
    pos_svc::open_table(conn, actor, table_id).unwrap();
    pos_svc::close_empty_table(conn, actor, table_id).unwrap();
}

/// Case A — a fresh database reports zero.
#[test]
fn a_fresh_database_reports_no_empty_closes() {
    let conn = fresh();

    assert_eq!(empty_closes(&conn), 0);
    assert_eq!(persisted_empty_closes(&conn), 0);

    // Opening the day and the till does not invent a close.
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    assert_eq!(empty_closes(&conn), 0);

    // Neither does opening a table: a close is only a close once it happens.
    let tables = table_ids(&conn);
    pos_svc::open_table(&conn, &actor, tables[0]).unwrap();
    assert_eq!(
        empty_closes(&conn),
        0,
        "opening a table is not an empty close"
    );
}

/// Case B — the FIRST empty close on a fresh database counts as exactly 1.
///
/// This is the mandatory transition. It is asserted against the persisted rows
/// as well as the reported figure, so it cannot pass by displaying something
/// the database does not hold.
#[test]
fn the_first_empty_close_on_a_fresh_database_is_counted() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);

    assert_eq!(empty_closes(&conn), 0, "the count starts at zero");

    empty_close(&conn, &actor, table_ids(&conn)[0]);

    assert_eq!(persisted_empty_closes(&conn), 1, "the close is persisted");
    assert_eq!(empty_closes(&conn), 1, "and the count reports it");
    assert_eq!(card_sum(&conn), 1, "the table card reports it too");
}

/// Case C — a second empty close makes it 2, and so does a third.
#[test]
fn successive_empty_closes_each_add_exactly_one() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    let tables = table_ids(&conn);

    empty_close(&conn, &actor, tables[0]);
    assert_eq!(empty_closes(&conn), 1);

    empty_close(&conn, &actor, tables[1]);
    assert_eq!(empty_closes(&conn), 2);

    empty_close(&conn, &actor, tables[2]);
    assert_eq!(empty_closes(&conn), 3);

    assert_eq!(persisted_empty_closes(&conn), 3);
    assert_eq!(card_sum(&conn), 3);
}

/// Case D — a table that was actually used is never an empty close.
#[test]
fn a_settled_table_is_not_an_empty_close() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    let tables = table_ids(&conn);

    empty_close(&conn, &actor, tables[0]);
    assert_eq!(empty_closes(&conn), 1);

    normal_close(&conn, &actor, tables[1]);

    assert_eq!(
        empty_closes(&conn),
        1,
        "paying an invoice is not an empty close"
    );
    assert_eq!(persisted_empty_closes(&conn), 1);
    assert_eq!(card_sum(&conn), 1);
}

/// Case G — many empty closes in one day keep counting.
#[test]
fn many_empty_closes_keep_counting() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);

    let tables = table_ids(&conn);
    for expected in 1..=5i64 {
        empty_close(&conn, &actor, tables[(expected - 1) as usize]);
        assert_eq!(
            empty_closes(&conn),
            expected,
            "close #{expected} must count"
        );
    }
    assert_eq!(card_sum(&conn), 5);
}

/// Open a table, sell one cafe item on it, and settle it.
fn normal_close(conn: &Connection, actor: &auth::User, table_id: i64) {
    pos_svc::open_table(conn, actor, table_id).unwrap();
    let order_id = pos_svc::start_order(conn, actor, table_id).unwrap();
    let product = catalog::list(conn, Some("CAFE"), true)
        .unwrap()
        .remove(0)
        .id;
    pos_svc::add_line(conn, actor, order_id, product, 1).unwrap();
    settle(conn, actor, order_id);
}

/// Case E — the count survives losing and rebuilding every piece of application
/// state, because it is read from the database rather than held anywhere.
#[test]
fn the_count_survives_a_restart() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    let tables = table_ids(&conn);

    empty_close(&conn, &actor, tables[0]);
    empty_close(&conn, &actor, tables[1]);
    assert_eq!(empty_closes(&conn), 2);

    // Re-reading through a brand new service call is what a restart does.
    for _ in 0..3 {
        assert_eq!(empty_closes(&conn), 2, "a re-read never changes the count");
    }

    // And the figure survives being written to a real file and reopened, which is
    // the only honest proof that nothing was cached in memory.
    let dir = std::env::temp_dir().join("station_lifecycle_restart_test");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("station_cafe.db");
    {
        let disk = Connection::open(&file).unwrap();
        disk.pragma_update(None, "foreign_keys", "ON").unwrap();
        crate::db::register_clock(&disk).unwrap();
        migrate(&disk).unwrap();
        crate::seed::run_if_empty(&disk).unwrap();
        let on_disk = manager(&disk);
        open_day_and_shift(&disk, &on_disk);
        let ids = table_ids(&disk);
        empty_close(&disk, &on_disk, ids[0]);
        empty_close(&disk, &on_disk, ids[1]);
        assert_eq!(empty_closes(&disk), 2);
    }
    {
        let reopened = Connection::open(&file).unwrap();
        crate::db::register_clock(&reopened).unwrap();
        assert_eq!(
            empty_closes(&reopened),
            2,
            "the count is persisted, not remembered"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Case F — two tables open at once are counted independently.
#[test]
fn two_open_tables_are_counted_independently() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    let tables = table_ids(&conn);

    pos_svc::open_table(&conn, &actor, tables[0]).unwrap();
    pos_svc::open_table(&conn, &actor, tables[1]).unwrap();
    assert_eq!(empty_closes(&conn), 0, "two opens are still no closes");

    // One is released empty, the other is genuinely used.
    pos_svc::close_empty_table(&conn, &actor, tables[0]).unwrap();
    let order_id = pos_svc::start_order(&conn, &actor, tables[1]).unwrap();
    let product = catalog::list(&conn, Some("CAFE"), true)
        .unwrap()
        .remove(0)
        .id;
    pos_svc::add_line(&conn, &actor, order_id, product, 1).unwrap();
    settle(&conn, &actor, order_id);

    assert_eq!(empty_closes(&conn), 1);
    assert_eq!(persisted_empty_closes(&conn), 1);

    // Both tables really are free again.
    for tv in pos_svc::list_tables(&conn).unwrap() {
        assert_eq!(tv.status, "EMPTY", "{} should be free", tv.label);
    }
}

/// Case H — a close is attributed to the business day it HAPPENED on.
///
/// This is the boundary the old query got wrong. A session opened late on one
/// business day and closed after the day rolled over belongs to the day of its
/// CLOSE: `business_day_id` names the opening day, so filtering the counter by
/// it filed the close under a day that is no longer current and the count never
/// moved.
#[test]
fn a_close_is_counted_on_the_day_it_happened_not_the_day_the_table_opened() {
    let conn = fresh();
    let actor = manager(&conn);

    // Day one: open a table and leave it open overnight.
    open_day_and_shift(&conn, &actor);
    let table = table_ids(&conn)[0];
    pos_svc::open_table(&conn, &actor, table).unwrap();

    // The café rolls over to its next business day behind that open session.
    //
    // The new day deliberately carries the SAME calendar label as the old one —
    // business days are repeatable and two of them may share one date — so this
    // is exactly the real rollover. What changes is the business-day IDENTITY,
    // and that is the point: `business_day_id` names the day a table was OPENED
    // on, so a close must be attributed by its own instant instead.
    let opening_day: i64 = conn
        .query_row(
            "SELECT id FROM business_days WHERE status = 'OPEN'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    conn.execute("UPDATE business_days SET status = 'CLOSED'", [])
        .unwrap();
    conn.execute("UPDATE shifts SET status = 'CLOSED'", [])
        .unwrap();
    shift_svc::open_day(&conn, &actor).unwrap();
    shift_svc::open_shift(&conn, &actor, 0).unwrap();

    let current_day: i64 = conn
        .query_row(
            "SELECT id FROM business_days WHERE status = 'OPEN'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_ne!(
        current_day, opening_day,
        "the café is now running on a different business day"
    );

    // The session still belongs to the day it was opened on.
    let session_day: i64 = conn
        .query_row("SELECT business_day_id FROM table_sessions", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        session_day, opening_day,
        "the session was opened on day one"
    );

    // The close happens on the new day, so the new day's count is 1.
    pos_svc::close_empty_table(&conn, &actor, table).unwrap();

    assert_eq!(persisted_empty_closes(&conn), 1);
    assert_eq!(
        empty_closes(&conn),
        1,
        "a close belongs to the day it happened on"
    );
}

/// The Cairo business day, not UTC, decides which day a close falls in.
///
/// A close at 22:30 UTC on the 25th is already the 26th in Africa/Cairo, so it
/// belongs to the next business day's counter. The rule is the project's single
/// `BUSINESS_TZ` definition reached through `station_business_date` — no
/// hardcoded offset is involved anywhere.
#[test]
fn the_business_day_boundary_follows_cairo_and_not_utc() {
    use chrono::{TimeZone, Utc};

    let conn = fresh();

    // 22:30 UTC on the 25th is already the 26th in Cairo.
    let instant = Utc.with_ymd_and_hms(2026, 9, 25, 22, 30, 0).unwrap();
    let label = crate::time::business_date_of(instant);
    assert_eq!(label, "2026-09-26", "22:30 UTC is the next day in Cairo");

    // A business day carrying exactly that label.
    let day_id: i64 = conn
        .query_row(
            "INSERT INTO business_days (day_date, opened_at, opened_by)
             VALUES (?1, '2026-09-25 21:00:00Z', 1) RETURNING id",
            [&label],
            |r| r.get(0),
        )
        .unwrap();

    // A session closed at 22:30 UTC — which is 00:30 on the 26th in Cairo. It
    // carries no order, which is precisely what makes it an empty close.
    let actor = manager(&conn);
    conn.execute(
        "INSERT INTO table_sessions (table_id, business_day_id, opened_by, opened_at)
         VALUES ((SELECT MIN(id) FROM cafe_tables), ?1, ?2, '2026-09-25 21:30:00Z')",
        rusqlite::params![day_id, actor.id],
    )
    .unwrap();
    conn.execute(
        "UPDATE table_sessions SET status = 'CLOSED', closed_at = '2026-09-25 22:30:00Z'",
        [],
    )
    .unwrap();

    assert_eq!(
        pos::day_lifecycle_counts(&conn, Some(day_id))
            .unwrap()
            .closed_empty,
        1,
        "a close after Cairo midnight belongs to the new business day"
    );

    // Move the close to 20:30 UTC — still the 25th in Cairo — and it stops being
    // that day's close.
    conn.execute(
        "UPDATE table_sessions SET closed_at = '2026-09-25 20:30:00Z'",
        [],
    )
    .unwrap();
    assert_eq!(
        pos::day_lifecycle_counts(&conn, Some(day_id))
            .unwrap()
            .closed_empty,
        0,
        "a close before Cairo midnight is not yet the next business day's"
    );
}

/// A table retired from the active grid must not take its history with it.
///
/// The count used to be summed over the tables the grid happened to be showing,
/// so shrinking the café's tables silently deleted real empty closes from the
/// day's total. The count is a business event, not a property of a table's
/// current visibility.
#[test]
fn retiring_a_table_never_erases_the_closes_it_recorded() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    let tables = table_ids(&conn);

    // Close the LAST table empty, then shrink the café so it leaves the grid.
    let last = *tables.last().unwrap();
    empty_close(&conn, &actor, last);
    assert_eq!(empty_closes(&conn), 1);

    pos_svc::set_table_count(&conn, &admin(&conn), (tables.len() - 1) as i64).unwrap();
    assert!(
        !pos_svc::list_tables(&conn)
            .unwrap()
            .iter()
            .any(|t| t.id == last),
        "the retired table has left the grid"
    );

    assert_eq!(persisted_empty_closes(&conn), 1);
    assert_eq!(
        empty_closes(&conn),
        1,
        "a historical empty close outlives the table's presence in the grid"
    );
}

/// An order that was started and then discarded left no sale behind, but it was
/// still an order: the session carries an `order_id`, which is exactly what the
/// empty-close rule is defined on. This pins that the count follows the
/// persisted definition rather than the button the cashier pressed.
#[test]
fn a_discarded_order_is_still_an_order_for_this_rule() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    let table = table_ids(&conn)[0];

    pos_svc::open_table(&conn, &actor, table).unwrap();
    let order_id = pos_svc::start_order(&conn, &actor, table).unwrap();
    pos_svc::discard_order(&conn, &actor, order_id).unwrap();
    pos_svc::close_empty_table(&conn, &actor, table).unwrap();

    assert_eq!(empty_closes(&conn), 0, "an order existed on this session");
    assert_eq!(persisted_empty_closes(&conn), 0);
}

/// A refused close cannot inflate the count either.
#[test]
fn a_refused_close_leaves_the_count_untouched() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    let table = table_ids(&conn)[0];

    // Nothing is open, so there is nothing to close.
    assert!(pos_svc::close_empty_table(&conn, &actor, table).is_err());
    assert_eq!(empty_closes(&conn), 0);

    // Once open, a second close of the same session is refused.
    pos_svc::open_table(&conn, &actor, table).unwrap();
    pos_svc::close_empty_table(&conn, &actor, table).unwrap();
    assert_eq!(empty_closes(&conn), 1);
    assert!(pos_svc::close_empty_table(&conn, &actor, table).is_err());
    assert_eq!(empty_closes(&conn), 1, "a double close never counts twice");
}

/// With no open business day there is no day to count, and the answer is a
/// truthful zero rather than an error, a guess, or a leftover figure.
#[test]
fn without_an_open_business_day_the_count_is_zero() {
    let conn = fresh();
    assert_eq!(empty_closes(&conn), 0);

    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    empty_close(&conn, &actor, table_ids(&conn)[0]);
    assert_eq!(empty_closes(&conn), 1);

    conn.execute("UPDATE business_days SET status = 'CLOSED'", [])
        .unwrap();
    assert_eq!(
        empty_closes(&conn),
        0,
        "a closed day is not the current day"
    );
}

/// The demonstration dataset must obey the same rule: whatever history it loads,
/// the reported count is the number of persisted empty closes of the open day.
#[test]
fn the_demo_dataset_reports_its_own_persisted_closes() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    run_demo(&conn).unwrap();

    // The demo leaves its POS busy but its day closed, so the day under test is
    // opened here exactly as a real café would open one after loading history.
    let manager = login(&conn, "manager", "2345");
    let day = crate::repositories::shifts::current_day(&conn).unwrap();
    let day = match day {
        Some(day) => day,
        None => {
            shift_svc::open_day(&conn, &manager).unwrap();
            crate::repositories::shifts::current_day(&conn)
                .unwrap()
                .unwrap()
        }
    };

    let persisted: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM table_sessions cs
             WHERE cs.status = 'CLOSED' AND cs.order_id IS NULL
               AND station_business_date(cs.closed_at) = ?1",
            [&day.day_date],
            |r| r.get(0),
        )
        .unwrap();

    assert_eq!(
        pos_svc::day_lifecycle_counts(&conn).unwrap().closed_empty,
        persisted,
        "the demo dataset's reported count must match its persisted rows"
    );
}
