//! Deterministic seed infrastructure.
//!
//! - Runs only when the database is empty (fresh install).
//! - All demo content is flagged (`is_seed = 1`) so the Admin "reset demo
//!   data" action (Phase 1) can distinguish it from production data.
//! - Safe to re-run: never duplicates content.

use crate::db::Db;
use crate::error::AppResult;
use crate::repositories::users;
use crate::services::auth;

/// Marker written into `app_settings` after seeding completes.
const SEED_MARKER: &str = "seed.completed_at";

/// Default starter accounts (flagged `is_seed` so admin tooling can reset
/// them; passwords MUST be changed before production use — enforced by the
/// login banner warning until changed).
const DEFAULT_USERS: &[(&str, Option<&str>, &str, &str)] = &[
    ("admin", None, "ADMIN", "admin123"),
    ("manager", None, "MANAGER", "manager123"),
    ("cashier", None, "STAFF", "cashier123"),
];

/// Starter catalog so a fresh install is immediately usable.
const DEFAULT_PRODUCTS: &[(&str, &str, &str, i64)] = &[
    // (name, item_type, department, price in minor units)
    ("شاي", "PRODUCT", "CAFE", 1500),
    ("قهوة", "PRODUCT", "CAFE", 3000),
    ("نسكافيه", "PRODUCT", "CAFE", 3500),
    ("كابتشينو", "PRODUCT", "CAFE", 4000),
    ("عصير مانجو", "PRODUCT", "CAFE", 3500),
    ("مياه معدنية", "PRODUCT", "CAFE", 1000),
    ("مغسلة خارجي", "SERVICE", "WASH", 5000),
    ("مغسلة داخلي", "SERVICE", "WASH", 7000),
    ("مغسلة كامل", "SERVICE", "WASH", 12000),
    ("تلميع", "SERVICE", "WASH", 8000),
];

pub fn run_if_empty(conn: &Db) -> AppResult<()> {
    let done: i64 = conn.query_row(
        "SELECT COUNT(*) FROM app_settings WHERE key = ?1",
        [SEED_MARKER],
        |r| r.get(0),
    )?;
    if done > 0 {
        return Ok(());
    }

    // Phase 2: seed starter accounts (hashed), catalog, tables.
    conn.execute_batch("BEGIN IMMEDIATE;")?;
    let result = seed_content(conn).and_then(|_| {
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, datetime('now'))
             ON CONFLICT(key) DO NOTHING",
            [SEED_MARKER],
        )
        .map_err(crate::error::AppError::from)
    });
    match result {
        Ok(_) => conn.execute_batch("COMMIT;")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            return Err(e);
        }
    }
    log::info!("seed: fresh database initialized");
    Ok(())
}

fn seed_content(conn: &Db) -> AppResult<()> {
    for (name, phone, role, password) in DEFAULT_USERS {
        let hash = auth::hash_password(password)?;
        users::insert(
            conn,
            &users::NewUser {
                name,
                phone: *phone,
                role,
                password_hash: &hash,
                is_seed: true,
            },
        )?;
    }
    for (name, item_type, department, price) in DEFAULT_PRODUCTS {
        conn.execute(
            "INSERT INTO products (name, item_type, department, price_minor, is_seed)
             VALUES (?1, ?2, ?3, ?4, 1)",
            rusqlite::params![name, item_type, department, price],
        )?;
    }
    for n in 1..=12 {
        conn.execute(
            "INSERT INTO cafe_tables (label) VALUES (?1) ON CONFLICT(label) DO NOTHING",
            rusqlite::params![format!("طاولة {n:02}")],
        )?;
    }
    log::info!("seed: users, catalog and tables created");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate;
    use rusqlite::Connection;

    #[test]
    fn seed_runs_once_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = ?1",
                [SEED_MARKER],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "seed marker must exist exactly once");
    }
}
