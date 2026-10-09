//! Developer-only data lifecycle. The frontend is never the security gate.

use crate::error::AppResult;
use crate::repositories::{developer, Db};
use crate::services::auth::{self, require_role, User};

/// The NAME of the account the developer data reset preserves and recreates.
///
/// It is looked up in `seed::DEFAULT_USERS` rather than spelled out with its
/// credentials here: the official seed installs this account, so the reset must
/// recreate the SAME one. Writing the credentials a second time is how a reset
/// ends up producing an account whose PIN no longer matches the seeded one, and
/// the failure is a lock-out discovered at the worst possible moment.
const DEVELOPER_USERNAME: &str = "Belly";

/// The developer account exactly as the official seed defines it.
fn developer_account() -> AppResult<(&'static str, &'static str)> {
    crate::seed::DEFAULT_USERS
        .iter()
        .find(|(name, ..)| *name == DEVELOPER_USERNAME)
        .map(|(name, _, _, password)| (*name, *password))
        .ok_or_else(|| crate::error::AppError::internal("the official seed has no Belly account"))
}

pub fn clear_database(conn: &Db, actor: &User) -> AppResult<()> {
    require_role(actor, "ADMIN")?;
    let (username, password) = developer_account()?;
    let password_hash = auth::hash_password(password)?;
    developer::clear_all(conn, username, &password_hash)
}

/// Explicit developer action that invokes the one canonical starter seed.
pub fn load_official_data(conn: &Db, actor: &User) -> AppResult<()> {
    require_role(actor, "ADMIN")?;
    crate::seed::run_if_empty(conn)
}

/// Explicit developer action that loads the DEMO dataset.
///
/// # Why this clears first
///
/// The architecture question the brief asks is whether demo loading should wipe
/// the database first or insert into whatever is there. Inspecting the reset
/// flow settles it: `clear_all` already exists, is transactional, is proven
/// child-first against the live foreign-key graph, and preserves the schema,
/// the migrations and the migration-owned `expense_categories`. Reusing it
/// means the demo flow is EXACTLY the existing "Clear → Load" pair with one
/// extra step, so:
///
///   * the result is deterministic — the same demo dataset every time, never a
///     merge of the previous contents with new sample rows;
///   * nothing can be orphaned or duplicated, because there is nothing left to
///     conflict with;
///   * migrations, settings and the developer ADMIN account are preserved by
///     the existing rules rather than by a second, parallel implementation.
///
/// It is therefore DESTRUCTIVE, and the UI says so before calling it.
///
/// The order matters and is not interchangeable: clear, then the OFFICIAL seed
/// (so the baseline exists), then the demo records on top. The official seed is
/// invoked through the very same [`load_official_data`] entry point the
/// "Load Official Data" button uses — demo loading adds records, it never
/// redefines the baseline.
pub fn load_demo_data(conn: &Db, actor: &User) -> AppResult<()> {
    require_role(actor, "ADMIN")?;
    clear_database(conn, actor)?;
    load_official_data(conn, actor)?;
    crate::demo_data::load(conn)?;
    log::info!("demo data: dataset loaded");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate;
    use crate::repositories::users;
    use crate::services::auth::LoginInput;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        load_official_data(&conn, &user(1, "ADMIN")).unwrap();
        conn
    }

    fn user(id: i64, role: &str) -> User {
        User {
            id,
            name: "test".into(),
            phone: None,
            role: role.into(),
            status: "ACTIVE".into(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        let exists: i64 = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        if exists == 0 {
            return 0;
        }
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn assert_foreign_keys(conn: &Connection) {
        let enabled: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(enabled, 1);
    }

    fn assert_empty_except_developer(conn: &Connection) {
        for table in developer::APPLICATION_DATA_TABLES {
            // `users` keeps the preserved developer login and `employees` keeps
            // the matching employee record, because authentication resolves the
            // actor's employee: a login without one could not sign in, and the
            // reset exists precisely so the developer CAN sign back in. Every
            // other application table is genuinely empty.
            let expected = match *table {
                "users" => 1,
                "employees" => 1,
                _ => 0,
            };
            assert_eq!(count(conn, table), expected, "{table} row count");
        }
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM _migrations", [], |r| r.get(0)),
            Ok(crate::db::migration_count())
        );
        assert_foreign_keys(conn);
    }

    fn assert_developer_account(conn: &Connection) {
        let row: (String, String, String, i64) = conn
            .query_row(
                "SELECT name, role, password_hash, is_seed FROM users WHERE name = 'Belly'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(row.0, "Belly");
        assert_eq!(row.1, "ADMIN");
        assert_ne!(row.2, "2214");
        assert!(row.2.starts_with("$argon2"));
        assert_eq!(row.3, 0);
    }

    #[test]
    fn full_clear_preserves_only_hashable_developer_admin() {
        let conn = db();
        assert!(count(&conn, "users") > 0);
        assert!(count(&conn, "products") > 0);
        assert!(count(&conn, "categories") > 0);
        assert!(count(&conn, "cafe_tables") > 0);
        let old_session = auth::login(
            &conn,
            &LoginInput {
                // A REAL official starter account: the official dataset no
                // longer ships any demo login.
                name: "amira".into(),
                password: "20192".into(),
            },
        )
        .unwrap();
        conn.execute(
            "INSERT INTO business_days (day_date, opened_at, status, closed_at)
             VALUES ('2026-01-01', station_now(), 'CLOSED', station_now())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO shifts (business_day_id, user_id, status, closed_at)
             VALUES (1, 1, 'CLOSED', station_now())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO expenses
                (category, amount, expense_date, business_day_id, user_id)
             VALUES ('SUPPLIES', 100, '2026-01-01', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO day_closings
                (business_day_id, closed_by, expenses, final_snapshot)
             VALUES (1, 1, 100, 1)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO day_closing_shifts VALUES (1, 1)", [])
            .unwrap();
        conn.execute("INSERT INTO day_closing_expenses VALUES (1, 1)", [])
            .unwrap();

        clear_database(&conn, &user(1, "ADMIN")).unwrap();

        assert_empty_except_developer(&conn);
        assert_developer_account(&conn);
        assert!(auth::require_user(&conn, &old_session.token).is_err());
        assert_eq!(count(&conn, "sessions"), 0);
        for old_user in ["amira", "momo", "foly"] {
            let exists: i64 = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE name = ?1)",
                    [old_user],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(exists, 0, "{old_user} must not survive clear");
        }

        let session = auth::login(
            &conn,
            &LoginInput {
                name: "Belly".into(),
                password: "2214".into(),
            },
        )
        .unwrap();
        assert_eq!(session.user.name, "Belly");
        assert_eq!(session.user.role, "ADMIN");
    }

    #[test]
    fn clear_bootstraps_developer_from_an_empty_database() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();

        clear_database(&conn, &user(1, "ADMIN")).unwrap();

        assert_empty_except_developer(&conn);
        assert_developer_account(&conn);
    }

    #[test]
    fn canonical_seed_runs_after_clear_and_markers_return() {
        let conn = db();
        let admin = user(1, "ADMIN");
        clear_database(&conn, &admin).unwrap();
        assert_eq!(count(&conn, "app_settings"), 0);

        load_official_data(&conn, &admin).unwrap();

        // Every starter account, INCLUDING the owner account the reset preserves.
        // There is no "+1" for the preserved account: the owner IS one of the
        // starter accounts now, so adding one would count it twice — which is
        // exactly the sort of off-by-one that makes a reset look like it
        // duplicated somebody. Derived from the seed list so adding a starter
        // account cannot make this assertion lie.
        assert_eq!(
            count(&conn, "users"),
            crate::seed::DEFAULT_USERS.len() as i64
        );
        for name in ["Belly", "amira", "momo", "foly", "Bassam"] {
            let exists: i64 = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE name = ?1)",
                    [name],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "{name} must exist after canonical seed");
        }
        // …and, the point of the whole separation: NO demo account may come
        // back with the official data.
        for name in crate::seed::FORMER_DEMO_USERNAMES {
            let exists: i64 = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE name = ?1)",
                    [name],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                exists, 0,
                "{name} is a demo account and must not be re-seeded"
            );
        }
        assert!(count(&conn, "products") > 0);
        assert_eq!(count(&conn, "cafe_tables"), 12);
        assert_developer_account(&conn);
        let markers: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_settings
                 WHERE key IN ('seed.completed_at','seed.catalog.v4.completed_at')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(markers, 2);
    }

    #[test]
    fn clear_is_safe_to_repeat() {
        let conn = db();
        let admin = user(1, "ADMIN");
        clear_database(&conn, &admin).unwrap();
        clear_database(&conn, &admin).unwrap();
        assert_empty_except_developer(&conn);
        assert_developer_account(&conn);
    }

    #[test]
    fn clear_resets_ids_and_implicit_integer_primary_keys() {
        let conn = db();
        clear_database(&conn, &user(1, "ADMIN")).unwrap();
        load_official_data(&conn, &user(1, "ADMIN")).unwrap();
        let first_ids: (i64, i64) = conn
            .query_row("SELECT (SELECT id FROM users ORDER BY id LIMIT 1), (SELECT id FROM products ORDER BY id LIMIT 1)", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(first_ids, (1, 1));
        assert_eq!(
            conn.query_row(
                "SELECT seq FROM sqlite_sequence WHERE name='users'",
                [],
                |r| r.get::<_, i64>(0)
            ),
            Ok(crate::seed::DEFAULT_USERS.len() as i64 + 1)
        );
    }

    #[test]
    fn manager_and_staff_cannot_clear_or_load() {
        let conn = db();
        for role in ["MANAGER", "STAFF"] {
            let actor = user(1, role);
            assert!(matches!(
                clear_database(&conn, &actor),
                Err(crate::error::AppError::Unauthorized(_))
            ));
            assert!(matches!(
                load_official_data(&conn, &actor),
                Err(crate::error::AppError::Unauthorized(_))
            ));
        }
        assert!(count(&conn, "users") > 0);
    }

    #[test]
    fn forced_delete_failure_rolls_back_the_entire_clear() {
        let conn = db();
        let users_before = count(&conn, "users");
        let products_before = count(&conn, "products");
        conn.execute_batch(
            "CREATE TRIGGER force_clear_failure BEFORE INSERT ON users
             BEGIN SELECT RAISE(ABORT, 'forced clear failure'); END;",
        )
        .unwrap();

        assert!(clear_database(&conn, &user(1, "ADMIN")).is_err());

        assert_eq!(count(&conn, "users"), users_before);
        assert_eq!(count(&conn, "products"), products_before);
        // The rollback restored the PRE-CLEAR state, and the owner account is
        // part of the official dataset — so after a rolled-back clear it is
        // exactly where it was before, still holding the PIN the seed installed.
        // (Before the owner account joined the official seed this read 0: the
        // clear was the only thing that ever created it, so a surviving row would
        // have meant the rollback had NOT happened.)
        let owner_hash: String = conn
            .query_row(
                "SELECT password_hash FROM users WHERE name = 'Belly'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            auth::verify_password("2214", &owner_hash),
            "the preserved owner account must still authenticate after a rollback"
        );
        auth::login(
            &conn,
            &LoginInput {
                name: "amira".into(),
                password: "20192".into(),
            },
        )
        .unwrap();
        assert_foreign_keys(&conn);
    }

    /// The real foreign-key graph, read from the live migrated schema.
    fn foreign_key_edges(conn: &Connection) -> Vec<(String, String)> {
        let mut stmt = conn
            .prepare(
                "SELECT m.name, p.\"table\"
                 FROM sqlite_schema m
                 JOIN pragma_foreign_key_list(m.name) p
                 WHERE m.type = 'table'
                   AND m.name NOT LIKE 'sqlite_%'
                   AND m.name <> '_migrations'",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap();
        let mut edges: Vec<(String, String)> = rows.map(|row| row.unwrap()).collect();
        edges.sort();
        edges
    }

    /// Regression guard for the deletion order.
    ///
    /// `clear_all` runs with `foreign_keys = ON` and every FK is NO ACTION, so a
    /// parent deleted before its child aborts the entire reset. That is exactly
    /// what happened when migration 25 introduced `expenses.shift_id ->
    /// shifts(id)`: `shifts` was deleted first and the reset started failing for
    /// any database that had a shift-scoped expense.
    ///
    /// Rather than trusting a hand-audited comment, this derives the true graph
    /// from `pragma_foreign_key_list` and asserts that
    /// `APPLICATION_DATA_TABLES` is a valid child-first order for it. A future
    /// migration that adds a relationship now fails here instead of silently
    /// breaking the developer reset in the running app.
    #[test]
    fn reset_order_matches_the_live_foreign_key_graph() {
        let conn = db();
        let position = |table: &str| {
            developer::APPLICATION_DATA_TABLES
                .iter()
                .position(|candidate| *candidate == table)
        };

        for (child, parent) in foreign_key_edges(&conn) {
            // A self-reference (e.g. an advance pointing at the advance it
            // reverses) carries no ordering information: the reset empties the
            // whole table with one DELETE, and SQLite checks a statement's
            // foreign keys at the END of that statement, so a row can never be
            // observed half-deleted. Only a DISTINCT parent imposes an order.
            if child == parent {
                continue;
            }
            // A parent that is deliberately preserved (system configuration) or
            // that is not reset at all imposes no ordering constraint.
            let (Some(child_at), Some(parent_at)) = (position(&child), position(&parent)) else {
                continue;
            };
            assert!(
                child_at < parent_at,
                "reset order must delete the child `{child}` before its parent `{parent}` \
                 (positions {child_at} and {parent_at})"
            );
        }
    }

    /// The reset must survive the shift-scoped expenses that migration 25 added.
    ///
    /// This is the concrete scenario that made "Clear Database" fail: a cashier
    /// books an expense against an open shift, the developer then resets, and the
    /// FK violation rolled the whole reset back.
    #[test]
    fn clear_succeeds_with_shift_scoped_expenses() {
        let conn = db();
        conn.execute(
            "INSERT INTO business_days (day_date, opened_at, status, closed_at)
             VALUES ('2026-02-01', station_now(), 'CLOSED', station_now())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO shifts (business_day_id, user_id, status, closed_at)
             VALUES (1, 1, 'CLOSED', station_now())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO expenses
                (category, amount, expense_date, business_day_id, shift_id, user_id)
             VALUES ('SUPPLIES', 100, '2026-02-01', 1, 1, 1)",
            [],
        )
        .unwrap();

        clear_database(&conn, &user(1, "ADMIN")).unwrap();

        assert_empty_except_developer(&conn);
        assert_developer_account(&conn);
    }

    /// `expense_categories` is migration-owned reference data, not reset data.
    ///
    /// The starter seed never recreates it, so a reset that deleted it would
    /// leave the database unable to record any expense again.
    #[test]
    fn clear_preserves_system_expense_categories() {
        let conn = db();
        let before: i64 = count(&conn, "expense_categories");
        assert!(before > 0, "the migration seeds the expense categories");

        clear_database(&conn, &user(1, "ADMIN")).unwrap();

        assert_eq!(count(&conn, "expense_categories"), before);
    }

    /// Clear → Load Official Data must produce a usable database.
    ///
    /// The two developer actions are only ever used as a pair, and the official
    /// seed re-runs the FULL starter seed (the reset wipes `app_settings`, so the
    /// completion marker is gone). This asserts the post-reset state is a valid,
    /// fully seeded application again, including the preserved developer account.
    #[test]
    fn clear_then_load_official_data_yields_a_valid_application() {
        let conn = db();
        let admin = user(1, "ADMIN");

        clear_database(&conn, &admin).unwrap();
        load_official_data(&conn, &admin).unwrap();

        assert!(count(&conn, "products") > 0);
        assert_eq!(count(&conn, "cafe_tables"), 12);
        assert_developer_account(&conn);
        for name in ["amira", "momo", "foly"] {
            let exists: i64 = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE name = ?1)",
                    [name],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "{name} must be restored by the official seed");
        }
        // The official dataset is production-safe: no demo account, and no
        // sample business record of any kind.
        for name in crate::seed::FORMER_DEMO_USERNAMES {
            let exists: i64 = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE name = ?1)",
                    [name],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                exists, 0,
                "{name} must never be restored by the official seed"
            );
        }
        for table in ["customers", "invoices", "expenses", "attendance_days"] {
            assert_eq!(count(&conn, table), 0, "{table} must stay empty");
        }

        // The preserved expense reference data survived the whole round trip.
        assert!(count(&conn, "expense_categories") > 0);
        assert_foreign_keys(&conn);
    }

    /// Loading the official data repeatedly must not duplicate anything.
    ///
    /// `run_if_empty` keys off the `seed.completed_at` marker the reset deletes,
    /// so the first load after a clear seeds fully. A SECOND load must then be a
    /// no-op rather than inserting a second copy of every product and user.
    #[test]
    fn repeated_official_data_load_does_not_duplicate() {
        let conn = db();
        let admin = user(1, "ADMIN");

        clear_database(&conn, &admin).unwrap();
        load_official_data(&conn, &admin).unwrap();
        let products_after_first = count(&conn, "products");
        let users_after_first = count(&conn, "users");
        let tables_after_first = count(&conn, "cafe_tables");

        for _ in 0..3 {
            load_official_data(&conn, &admin).unwrap();
        }

        assert_eq!(count(&conn, "products"), products_after_first);
        assert_eq!(count(&conn, "users"), users_after_first);
        assert_eq!(count(&conn, "cafe_tables"), tables_after_first);
    }

    /// The developer reset preserved what it must, and the demo flow rebuilds
    /// on top of it without losing the schema, the migrations or the reference
    /// data the reset is documented to keep.
    #[test]
    fn demo_loading_rebuilds_on_top_of_the_official_baseline() {
        let conn = db();
        let admin = user(1, "ADMIN");

        load_demo_data(&conn, &admin).unwrap();

        // The migrations and the migration-owned expense categories survived the
        // reset the demo load performs internally.
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM _migrations", [], |r| r.get(0)),
            Ok(crate::db::migration_count())
        );
        assert!(count(&conn, "expense_categories") > 0);

        // The official baseline is present…
        assert_eq!(count(&conn, "cafe_tables"), 12);
        assert!(count(&conn, "products") > 0);
        // …and the demo records are on top of it.
        assert!(count(&conn, "customers") > 0);
        assert!(count(&conn, "invoices") > 0);
        assert_foreign_keys(&conn);
    }

    /// The demo flow is deterministic and repeatable: loading it again replaces
    /// the dataset rather than piling a second copy on top of it.
    #[test]
    fn repeated_demo_loading_replaces_rather_than_accumulates() {
        let conn = db();
        let admin = user(1, "ADMIN");

        load_demo_data(&conn, &admin).unwrap();
        let first = (
            count(&conn, "customers"),
            count(&conn, "invoices"),
            count(&conn, "products"),
        );

        load_demo_data(&conn, &admin).unwrap();
        let second = (
            count(&conn, "customers"),
            count(&conn, "invoices"),
            count(&conn, "products"),
        );

        assert_eq!(first, second, "the demo dataset must be reproducible");
    }

    /// A MANAGER or STAFF session can load neither dataset. The demo loader is
    /// exactly as locked down as the official one — it is not a back door.
    #[test]
    fn manager_and_staff_cannot_load_demo_data() {
        let conn = db();
        for role in ["MANAGER", "STAFF"] {
            assert!(matches!(
                load_demo_data(&conn, &user(1, role)),
                Err(crate::error::AppError::Unauthorized(_))
            ));
        }
    }

    /// The owner admin can drive BOTH data modes, and holds full ADMIN in each.
    ///
    /// This is the requirement the two datasets are usually confused about:
    /// "Load Official Data" and "Load Demo Data" are two DIFFERENT commands with
    /// two different bodies, and an account that can do only one of them is of
    /// no use to the person who has to switch between them. Both are authorized
    /// by the ordinary `require_role(actor, "ADMIN")` check — there is no
    /// separate developer flag anywhere, and this test is what proves the
    /// existing mechanism was sufficient rather than a new one being needed.
    #[test]
    fn the_owner_admin_account_can_drive_both_data_modes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        // The real starter seed, not the `db()` helper's service call: the point
        // is that a freshly installed database already carries this account.
        crate::seed::run_if_empty(&conn).unwrap();

        let owner = auth::login(
            &conn,
            &LoginInput {
                name: "Belly".into(),
                password: "2214".into(),
            },
        )
        .expect("Belly must be able to sign in to a freshly seeded database")
        .user;
        assert_eq!(owner.role, "ADMIN");

        // OFFICIAL mode: the real starter dataset, with no demo record in it.
        load_official_data(&conn, &owner).unwrap();
        assert_eq!(count(&conn, "cafe_tables"), 12);
        assert_eq!(
            count(&conn, "invoices"),
            0,
            "official data has no trading history"
        );

        // DEMO mode: a full dataset on top, and the same session is still an
        // ADMIN afterwards — the reset destroys the session TABLE, not the role.
        load_demo_data(&conn, &owner).unwrap();
        assert!(
            count(&conn, "invoices") > 0,
            "demo data must exercise the reports"
        );

        // …and the owner account survived the demo reset, still as an ADMIN, so
        // the person can sign straight back in and drive both modes again.
        let after = users::find_by_name(&conn, "Belly")
            .unwrap()
            .expect("the owner account must survive the demo reset");
        assert_eq!(after.user.role, "ADMIN");
        assert!(auth::verify_password("2214", &after.password_hash));
    }
}
