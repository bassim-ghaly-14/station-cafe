//! Developer-only data lifecycle. The frontend is never the security gate.

use crate::error::AppResult;
use crate::repositories::{developer, Db};
use crate::services::auth::{self, require_role, User};

const DEVELOPER_USERNAME: &str = "Belly";
const DEVELOPER_PASSWORD: &str = "2214Q";

pub fn clear_database(conn: &Db, actor: &User) -> AppResult<()> {
    require_role(actor, "ADMIN")?;
    let password_hash = auth::hash_password(DEVELOPER_PASSWORD)?;
    developer::clear_all(conn, DEVELOPER_USERNAME, &password_hash)
}

/// Explicit developer action that invokes the one canonical starter seed.
pub fn load_demo_data(conn: &Db, actor: &User) -> AppResult<()> {
    require_role(actor, "ADMIN")?;
    crate::seed::run_if_empty(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate;
    use crate::services::auth::LoginInput;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        load_demo_data(&conn, &user(1, "ADMIN")).unwrap();
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
            let expected = if *table == "users" { 1 } else { 0 };
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
        assert_ne!(row.2, "2214Q");
        assert!(row.2.starts_with("$argon2"));
        assert_eq!(row.3, 0);
    }

    #[test]
    fn full_clear_preserves_only_hashable_developer_admin() {
        let conn = db();
        assert!(count(&conn, "users") > 0);
        assert!(count(&conn, "products") > 0);
        assert!(count(&conn, "cafe_tables") > 0);
        let old_session = auth::login(
            &conn,
            &LoginInput {
                name: "admin".into(),
                password: "admin123".into(),
            },
        )
        .unwrap();

        clear_database(&conn, &user(1, "ADMIN")).unwrap();

        assert_empty_except_developer(&conn);
        assert_developer_account(&conn);
        assert!(auth::require_user(&conn, &old_session.token).is_err());
        assert_eq!(count(&conn, "sessions"), 0);
        for old_user in ["admin", "manager", "amira", "cashier"] {
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
                password: "2214Q".into(),
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

        load_demo_data(&conn, &admin).unwrap();

        assert_eq!(count(&conn, "users"), 5);
        for name in ["Belly", "admin", "manager", "amira", "cashier"] {
            let exists: i64 = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE name = ?1)",
                    [name],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "{name} must exist after canonical seed");
        }
        assert!(count(&conn, "products") > 0);
        assert_eq!(count(&conn, "cafe_tables"), 12);
        assert_developer_account(&conn);
        let markers: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_settings
                 WHERE key IN ('seed.completed_at','seed.catalog.v2.completed_at')",
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
        load_demo_data(&conn, &user(1, "ADMIN")).unwrap();
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
            Ok(5)
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
                load_demo_data(&conn, &actor),
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
        let belly_exists: i64 = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM users WHERE name = 'Belly')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(belly_exists, 0);
        auth::login(
            &conn,
            &LoginInput {
                name: "admin".into(),
                password: "admin123".into(),
            },
        )
        .unwrap();
        assert_foreign_keys(&conn);
    }
}
