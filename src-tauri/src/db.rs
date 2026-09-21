//! SQLite connection + migration management.
//!
//! Migration strategy: numbered SQL migrations embedded in the binary,
//! applied inside transactions, tracked in `_migrations` (schema_migrations).
//! Never edit an applied migration — always add a new numbered file.

use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use std::path::Path;

pub type Db = Connection;

/// The single active SQLite database file.
pub const DB_FILE: &str = "station_cafe.db";

pub fn open(data_dir: &Path) -> AppResult<Db> {
    std::fs::create_dir_all(data_dir)?;
    let db_path = data_dir.join(DB_FILE);
    let conn = Connection::open(&db_path)?;

    // Durability settings appropriate for a financial POS:
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;

    Ok(conn)
}

/// A migration is a (version, name, SQL) triple applied in version order.
struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

/// Initial schema — Phase 1 tables (foundation only; business tables are
/// added as numbered migrations during Phase 1 implementation).
const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "core foundation",
    sql: r#"
        -- Core configuration store (single row per key; JSON values)
        CREATE TABLE IF NOT EXISTS app_settings (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL,          -- JSON encoded
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Business day lifecycle: OPEN -> CLOSED
        CREATE TABLE IF NOT EXISTS business_days (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            day_date    TEXT NOT NULL UNIQUE,   -- ISO date of the business day
            opened_at   TEXT NOT NULL,
            closed_at   TEXT,
            status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
            opened_by   INTEGER,
            closed_by   INTEGER
        );

        -- Audit log for sensitive business actions (shared foundation table)
        CREATE TABLE IF NOT EXISTS audit_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_id    INTEGER,
            actor_role  TEXT,
            action      TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id   TEXT,
            before_json TEXT,
            after_json  TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_audit_action   ON audit_log(action);
        CREATE INDEX IF NOT EXISTS idx_audit_entity   ON audit_log(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_created  ON audit_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_bday_status    ON business_days(status);
    "#,
}];

pub fn migrate(conn: &Db) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
            version     INTEGER PRIMARY KEY,
            name        TEXT NOT NULL,
            applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )?;

    let current: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM _migrations",
        [],
        |row| row.get(0),
    )?;

    for m in MIGRATIONS {
        if m.version <= current {
            continue;
        }
        conn.execute_batch("BEGIN IMMEDIATE;")?;
        let result = conn
            .execute_batch(m.sql)
            .and_then(|_| {
                conn.execute(
                    "INSERT INTO _migrations (version, name) VALUES (?1, ?2)",
                    rusqlite::params![m.version, m.name],
                )
            })
            .map_err(AppError::from);
        match result {
            Ok(_) => conn.execute_batch("COMMIT;")?,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err(e);
            }
        }
        log::info!("applied migration {}: {}", m.version, m.name);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_apply_in_order_and_are_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        // Running twice must be a no-op
        migrate(&conn).unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM _migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, MIGRATIONS.len() as i64);

        // Foundation tables exist
        for table in ["app_settings", "business_days", "audit_log"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "table {table} should exist");
        }
    }
}
