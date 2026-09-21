//! Deterministic seed infrastructure.
//!
//! - Runs only when the database is empty (fresh install).
//! - All demo content is flagged (`is_seed = 1`) so the Admin "reset demo
//!   data" action (Phase 1) can distinguish it from production data.
//! - Safe to re-run: never duplicates content.

use crate::db::Db;
use crate::error::AppResult;

/// Marker written into `app_settings` after seeding completes.
const SEED_MARKER: &str = "seed.completed_at";

pub fn run_if_empty(conn: &Db) -> AppResult<()> {
    let done: i64 = conn.query_row(
        "SELECT COUNT(*) FROM app_settings WHERE key = ?1",
        [SEED_MARKER],
        |r| r.get(0),
    )?;
    if done > 0 {
        return Ok(());
    }

    // Phase 1 will add real seed entities (users, products, services...).
    // The foundation only records that a fresh database was initialized.
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, datetime('now'))
         ON CONFLICT(key) DO NOTHING",
        [SEED_MARKER],
    )?;
    log::info!("seed: fresh database initialized");
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
