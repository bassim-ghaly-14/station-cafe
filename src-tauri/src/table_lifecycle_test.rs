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

// ===========================================================================
// SHIFT-SCOPED TABLE STATISTICS — the closing's own table lifecycle
// ===========================================================================
//
// The DAY counter above answers "how many empty closes has this business day
// seen". A shift is a different period with a different question: "how many did
// THIS till do". These tests pin the second one without disturbing the first —
// in particular they never weaken the rule that a close belongs to the day it
// HAPPENED on.
//
// Every figure is read through the service layer, exactly like production
// traffic, and each is cross-checked against the persisted `table_sessions` rows
// so a passing test cannot be passing on a number the database does not hold.

/// The shift-scoped counters the backend reports for the caller's active shift.
fn shift_closes(conn: &Connection, actor: &auth::User) -> (i64, i64) {
    let counts = pos_svc::shift_lifecycle_counts(conn, actor).unwrap();
    (counts.opens, counts.closed_empty)
}

/// What `table_sessions` itself says for one shift, independent of any query the
/// application builds.
fn persisted_shift_rows(conn: &Connection, shift_id: i64) -> (i64, i64) {
    conn.query_row(
        "SELECT
            (SELECT COUNT(*) FROM table_sessions WHERE shift_id = ?1),
            (SELECT COUNT(*) FROM table_sessions
              WHERE shift_id = ?1 AND status = 'CLOSED' AND order_id IS NULL)",
        [shift_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

fn active_shift_id(conn: &Connection, actor: &auth::User) -> i64 {
    crate::repositories::shifts::active_shift_for(conn, actor.id)
        .unwrap()
        .expect("the caller's own ACTIVE shift")
        .id
}

/// Close the caller's shift and open the next one, both on the SAME business day.
fn roll_shift(conn: &Connection, actor: &auth::User) -> i64 {
    shift_svc::close_shift_at(conn, actor, 0, "2026-09-25 12:00:00").unwrap();
    shift_svc::open_shift(conn, actor, 0).unwrap()
}

/// Case 1 — a first opened table and an empty close are counted EXACTLY once by
/// the shift that performed them.
#[test]
fn a_first_empty_close_is_counted_exactly_once_by_its_shift() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    let shift = active_shift_id(&conn, &actor);

    // Nothing has happened yet: the shift starts clean, at zero, not at whatever
    // a previous shift left behind.
    assert_eq!(
        shift_closes(&conn, &actor),
        (0, 0),
        "a new shift starts clean"
    );
    assert_eq!(persisted_shift_rows(&conn, shift), (0, 0));

    let table = table_ids(&conn)[0];
    pos_svc::open_table(&conn, &actor, table).unwrap();
    assert_eq!(
        shift_closes(&conn, &actor),
        (1, 0),
        "opening a table is an open, never a close"
    );

    pos_svc::close_empty_table(&conn, &actor, table).unwrap();
    assert_eq!(
        shift_closes(&conn, &actor),
        (1, 1),
        "the empty close is counted exactly once"
    );
    assert_eq!(persisted_shift_rows(&conn, shift), (1, 1));
}

/// Case 2 — a genuine table order counts as an OPEN and never as an empty close,
/// for the shift exactly as for the day.
#[test]
fn a_settled_table_order_is_never_a_shift_empty_close() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    let shift = active_shift_id(&conn, &actor);
    let tables = table_ids(&conn);

    normal_close(&conn, &actor, tables[0]);
    empty_close(&conn, &actor, tables[1]);

    // Two sessions belong to the shift, but only the one that never carried an
    // order is an empty close. A paid invoice is not an empty close.
    assert_eq!(shift_closes(&conn, &actor), (2, 1));
    assert_eq!(persisted_shift_rows(&conn, shift), (2, 1));
    // And the shift figure agrees with the day's, because this is one day.
    assert_eq!(empty_closes(&conn), 1, "one business rule, two scopes");
}
/// Case 2b — reopening the SAME table is a SECOND OPEN, never a repeat of the
/// first one.
///
/// This is the distinction the whole figure rests on: `opens` counts SESSIONS,
/// not distinct table numbers. One table seated twice is two business events and
/// must be reported as two — a counter keyed on `table_id` would quietly report
/// 1 and lose a real session. It is asserted against the persisted rows too.
#[test]
fn reopening_the_same_table_is_a_second_open_not_a_repeat() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    let shift = active_shift_id(&conn, &actor);
    let table = table_ids(&conn)[0];

    empty_close(&conn, &actor, table);
    assert_eq!(shift_closes(&conn, &actor), (1, 1), "the first sitting");

    // The very same table, seated again inside the SAME shift.
    empty_close(&conn, &actor, table);
    assert_eq!(
        shift_closes(&conn, &actor),
        (2, 2),
        "two sittings of one table are two opens and two closes"
    );
    assert_eq!(
        persisted_shift_rows(&conn, shift),
        (2, 2),
        "and the persisted rows hold TWO session rows for that one table"
    );

    // The reason it is two is that there are genuinely two session rows — the
    // count is derived from the lifecycle, not from the table it sat at.
    let sessions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM table_sessions WHERE shift_id = ?1 AND table_id = ?2",
            rusqlite::params![shift, table],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sessions, 2, "one row per sitting, not one row per table");
    let distinct_tables: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT table_id) FROM table_sessions WHERE shift_id = ?1",
            [shift],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(distinct_tables, 1, "but only one table was ever seated");

    // The closing states the same per-session figures the preview did.
    let closing = shift_svc::close_shift_at(&conn, &actor, 0, "2026-09-25 12:00:00").unwrap();
    assert_eq!(
        (closing.tables.opens, closing.tables.closed_empty),
        (2, 2),
        "the closing reports sittings, not distinct tables"
    );
}

/// Case 3 — a NEW shift starts from clean shift-scoped statistics, while the day
/// keeps accumulating. This is the regression an endless lifetime counter could
/// never pass.
#[test]
fn a_new_shift_starts_clean_while_the_day_accumulates() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    let first = active_shift_id(&conn, &actor);
    let tables = table_ids(&conn);

    empty_close(&conn, &actor, tables[0]);
    empty_close(&conn, &actor, tables[1]);
    assert_eq!(shift_closes(&conn, &actor), (2, 2));

    // The same business day, the next till period.
    let second = roll_shift(&conn, &actor);
    assert_ne!(second, first, "a genuinely different shift");

    // The SHIFT counters reset. The DAY counter does not — it is a different
    // period, and both figures come from the same persisted rows.
    assert_eq!(
        shift_closes(&conn, &actor),
        (0, 0),
        "the new shift's statistics start clean"
    );
    assert_eq!(persisted_shift_rows(&conn, second), (0, 0));
    assert_eq!(
        persisted_shift_rows(&conn, first),
        (2, 2),
        "the closed shift keeps its own history"
    );
    assert_eq!(empty_closes(&conn), 2, "the business day keeps accumulating");

    // The second shift's own closes are counted once, against the second shift.
    empty_close(&conn, &actor, tables[2]);
    assert_eq!(shift_closes(&conn, &actor), (1, 1));
    assert_eq!(persisted_shift_rows(&conn, second), (1, 1));
    assert_eq!(persisted_shift_rows(&conn, first), (2, 2));
    assert_eq!(empty_closes(&conn), 3, "the day aggregates its shifts");
}

/// Case 4 — several shifts inside ONE Cairo business day aggregate correctly.
#[test]
fn several_shifts_in_one_cairo_day_aggregate_into_that_day() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    let tables = table_ids(&conn);

    let mut per_shift: Vec<i64> = Vec::new();
    for index in 0..3 {
        empty_close(&conn, &actor, tables[index]);
        let (opens, closed) = shift_closes(&conn, &actor);
        per_shift.push(closed);
        // Each shift reports exactly what it did — never the running day total.
        assert_eq!(closed, 1, "shift #{} reports only its own close", index);
        assert_eq!(opens, 1);
        roll_shift(&conn, &actor);
    }

    assert_eq!(per_shift, vec![1, 1, 1], "each shift counted exactly its own");
    assert_eq!(empty_closes(&conn), 3, "the day is the aggregate of shifts");
    assert_eq!(persisted_empty_closes(&conn), 3);
}

/// Case 6 — the shift-scoped figures are PERSISTED truth, not memory. The honest
/// proof is a real database file that is closed and reopened.
#[test]
fn the_shift_statistics_survive_an_application_restart() {
    let dir = std::env::temp_dir().join("station_shift_lifecycle_restart_test");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("station_cafe.db");

    let (shift_before, opens_before, closed_before) = {
        let disk = Connection::open(&file).unwrap();
        disk.pragma_update(None, "foreign_keys", "ON").unwrap();
        crate::db::register_clock(&disk).unwrap();
        migrate(&disk).unwrap();
        crate::seed::run_if_empty(&disk).unwrap();
        let actor = manager(&disk);
        open_day_and_shift(&disk, &actor);
        let ids = table_ids(&disk);
        empty_close(&disk, &actor, ids[0]);
        normal_close(&disk, &actor, ids[1]);
        let shift = active_shift_id(&disk, &actor);
        let (opens, closed) = shift_closes(&disk, &actor);
        assert_eq!((opens, closed), (2, 1));
        // The closing the cashier performs carries the same figures.
        let closing = shift_svc::close_shift_at(&disk, &actor, 0, "2026-09-25 12:00:00").unwrap();
        assert_eq!(
            (closing.tables.opens, closing.tables.closed_empty),
            (2, 1),
            "the closing result states the shift's own table statistics"
        );
        (shift, opens, closed)
    };

    {
        // Nothing of the previous process survives except the database file.
        let reopened = Connection::open(&file).unwrap();
        crate::db::register_clock(&reopened).unwrap();
        assert_eq!(
            persisted_shift_rows(&reopened, shift_before),
            (opens_before, closed_before),
            "the closed shift's statistics are persisted, not remembered"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Case 7 — the opening-day vs closing-day rule, stated for BOTH scopes.
///
/// A session opened during shift A and closed after the café rolled over to a new
/// business day belongs to A by `shift_id` and to the NEW day by its closing
/// instant. Both answers are correct: the scopes describe different periods. This
/// test exists so that relationship can never change silently.
#[test]
fn a_cross_day_close_is_reported_by_each_scope_on_its_own_period() {
    let conn = fresh();
    let actor = manager(&conn);

    // Day one: open a table and leave the session open overnight.
    open_day_and_shift(&conn, &actor);
    let opening_shift = active_shift_id(&conn, &actor);
    let table = table_ids(&conn)[0];
    pos_svc::open_table(&conn, &actor, table).unwrap();

    // Roll the business day over behind that still-open session. Two business
    // days may legitimately share one calendar label; what changes is the day
    // IDENTITY, which is exactly the real rollover.
    shift_svc::close_shift_at(&conn, &actor, 0, "2026-09-25 23:59:00").unwrap();
    conn.execute("UPDATE business_days SET status = 'CLOSED'", [])
        .unwrap();
    shift_svc::open_day(&conn, &actor).unwrap();
    shift_svc::open_shift(&conn, &actor, 0).unwrap();
    let closing_shift = active_shift_id(&conn, &actor);
    assert_ne!(closing_shift, opening_shift);

    // The close happens on the new day, under the new shift.
    pos_svc::close_empty_table(&conn, &actor, table).unwrap();

    // The SHIFT scope follows the shift that OWNS the session row: `shift_id` is
    // stamped when the table opens, so that shift records both the open and the
    // eventual close of the session it began — even when the close physically
    // happened after the café rolled over.
    assert_eq!(
        persisted_shift_rows(&conn, opening_shift),
        (1, 1),
        "the session belongs to the shift that opened it, through its close"
    );
    assert_eq!(
        persisted_shift_rows(&conn, closing_shift),
        (0, 0),
        "the shift that merely performed the close owns no session of its own"
    );
    assert_eq!(
        shift_closes(&conn, &actor),
        (0, 0),
        "and the live figure describes the new shift, which has done nothing yet"
    );

    // The DAY scope follows the business day the close HAPPENED on. This is the
    // pinned rule: it is NOT the shift's scope and must never be substituted
    // for it. The same row is reported by both scopes, each on its own period.
    assert_eq!(
        empty_closes(&conn),
        1,
        "the close belongs to the day it happened on, not the day it opened"
    );
    assert_eq!(
        pos_svc::day_lifecycle_counts(&conn).unwrap().opens,
        1,
        "while its OPEN still counts on the day the table was opened"
    );
}
/// Case 8 — an OPEN table is never counted as a close, and a refused close
/// cannot inflate either scope.
#[test]
fn open_tables_and_refused_closes_stay_out_of_both_scopes() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    let tables = table_ids(&conn);

    // Nothing open yet: closing is refused and nothing moves.
    assert!(pos_svc::close_empty_table(&conn, &actor, tables[0]).is_err());
    assert_eq!(shift_closes(&conn, &actor), (0, 0));
    assert_eq!(empty_closes(&conn), 0);

    // A table opened and LEFT OPEN is an open, never a close — on either scope.
    pos_svc::open_table(&conn, &actor, tables[0]).unwrap();
    assert_eq!(
        shift_closes(&conn, &actor),
        (1, 0),
        "an open table is not a closed one"
    );
    assert_eq!(empty_closes(&conn), 0, "and not for the day either");

    // The close happens once. A second attempt on the same session is refused
    // and must not count twice.
    pos_svc::close_empty_table(&conn, &actor, tables[0]).unwrap();
    assert!(pos_svc::close_empty_table(&conn, &actor, tables[0]).is_err());
    assert_eq!(
        shift_closes(&conn, &actor),
        (1, 1),
        "a double close counts once"
    );
    assert_eq!(empty_closes(&conn), 1);
}

/// With no active shift of the caller's there is no period to describe, and the
/// answer is a truthful zero rather than an error or a leftover figure.
#[test]
fn without_an_active_shift_the_shift_figures_are_zero() {
    let conn = fresh();
    let actor = manager(&conn);

    assert_eq!(
        shift_closes(&conn, &actor),
        (0, 0),
        "no shift, no shift-scoped figure"
    );

    open_day_and_shift(&conn, &actor);
    empty_close(&conn, &actor, table_ids(&conn)[0]);
    assert_eq!(shift_closes(&conn, &actor), (1, 1));

    // Once closed, the caller has no ACTIVE shift — and the figures must not
    // silently fall back onto some other shift's history.
    shift_svc::close_shift_at(&conn, &actor, 0, "2026-09-25 12:00:00").unwrap();
    assert_eq!(
        shift_closes(&conn, &actor),
        (0, 0),
        "a closed shift is not the active one"
    );
}

/// The shift closing document must state the shift's own table statistics, and
/// state the PREVIEW's numbers before the cashier confirms them.
#[test]
fn the_shift_closing_states_its_own_table_statistics() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    let tables = table_ids(&conn);

    empty_close(&conn, &actor, tables[0]);
    normal_close(&conn, &actor, tables[1]);

    // The preview the dialog renders and the committed closing must agree, or
    // the cashier confirms one number and the document carries another.
    let preview = shift_svc::preview_shift_close(&conn, &actor).unwrap();
    let closing = shift_svc::close_shift_at(&conn, &actor, 0, "2026-09-25 12:00:00").unwrap();

    assert_eq!((preview.tables.opens, preview.tables.closed_empty), (2, 1));
    assert_eq!(
        (closing.tables.opens, closing.tables.closed_empty),
        (preview.tables.opens, preview.tables.closed_empty),
        "the closing states what the preview showed"
    );
    // The report the printer and the screen both read carries the same block.
    assert_eq!(
        (
            closing.report.tables.opens,
            closing.report.tables.closed_empty
        ),
        (2, 1)
    );

    // A historical, closed shift still reports its own figures afterwards.
    let shift_id = closing.shift.id;
    let report = crate::services::reconciliation::shift_report(&conn, shift_id).unwrap();
    assert_eq!(
        (report.tables.opens, report.tables.closed_empty),
        (2, 1),
        "a closed shift reproduces its own table statistics"
    );
}
/// Case 5 — a NEW shift starts clean, and a new business day is scoped by its
/// own label.
///
/// The shift scope is unambiguous: a new till period owns no sessions, so it
/// reports zero. The DAY scope is keyed on `day_date`, and Station business days
/// are deliberately REPEATABLE — the existing suite already models a rollover
/// whose new day carries the same calendar label. So the honest day-level claim
/// is not "the number resets" but "the new day counts the closes whose own
/// instant falls on ITS label, and nothing else is rewritten". Both are asserted.
#[test]
fn a_new_cairo_business_day_starts_clean() {
    let conn = fresh();
    let actor = manager(&conn);
    open_day_and_shift(&conn, &actor);
    empty_close(&conn, &actor, table_ids(&conn)[0]);
    assert_eq!(shift_closes(&conn, &actor), (1, 1));
    let before = empty_closes(&conn);
    assert_eq!(before, 1);

    // Close the shift, then roll the business day over.
    shift_svc::close_shift_at(&conn, &actor, 0, "2026-09-25 23:59:00").unwrap();
    conn.execute("UPDATE business_days SET status = 'CLOSED'", [])
        .unwrap();
    shift_svc::open_day(&conn, &actor).unwrap();
    shift_svc::open_shift(&conn, &actor, 0).unwrap();

    // The new SHIFT is clean, which is the reset a cashier actually experiences.
    assert_eq!(
        shift_closes(&conn, &actor),
        (0, 0),
        "the new shift starts at zero"
    );

    // A close on the new day is counted against the new day, and the previous
    // day's rows are neither moved nor double-counted by the rollover.
    empty_close(&conn, &actor, table_ids(&conn)[1]);
    assert_eq!(shift_closes(&conn, &actor), (1, 1));
    assert_eq!(
        empty_closes(&conn),
        before + 1,
        "the day counts each close on its own label, exactly once"
    );
    assert_eq!(
        persisted_empty_closes(&conn),
        before + 1,
        "and the persisted rows agree, with the earlier day's row intact"
    );
}
