//! Full developer-data reset. This deletes every application row, never a
//! schema object. Order is child-first because the schema uses NO ACTION FKs.

use crate::error::AppResult;
use crate::repositories::Db;

/// Audited from migrations v1-v14. `_migrations` is the only schema table
/// intentionally excluded. The order is child-first for the current FK graph.
/// Categories are system configuration and are intentionally preserved so the
/// canonical seed can always satisfy the required product category FK.
pub const APPLICATION_DATA_TABLES: &[&str] = &[
    "credit_payments",
    "credit_accounts",
    "invoice_customers",
    "invoice_lines",
    "payments",
    "stock_movements",
    "order_lines",
    "wash_tickets",
    "invoices",
    "table_sessions",
    "orders",
    "shifts",
    "inventory_items",
    "expenses",
    "print_jobs",
    "audit_log",
    "sessions",
    "products",
    "cafe_tables",
    "cars",
    "customers",
    "business_days",
    "users",
    "app_settings",
];

/// Delete all application data and recreate the one developer account
/// atomically while preserving tables, indexes, triggers, migrations, and the
/// database file.
pub fn clear_all(
    conn: &Db,
    developer_username: &str,
    developer_password_hash: &str,
) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;

    let result = (|| -> AppResult<()> {
        for table in APPLICATION_DATA_TABLES {
            // Every name is a compile-time audited constant, never UI input.
            tx.execute(&format!("DELETE FROM \"{table}\""), [])?;
        }

        // sqlite_sequence only contains tables that actually declared
        // AUTOINCREMENT. Verify that from the current schema before resetting.
        // Reset users before inserting Belly so the preserved record is ID 1.
        if table_exists(&tx, "sqlite_sequence")? {
            for table in APPLICATION_DATA_TABLES {
                let uses_autoincrement: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM sqlite_schema
                     WHERE type='table' AND name=?1 AND upper(sql) LIKE '%AUTOINCREMENT%'",
                    [table],
                    |row| row.get(0),
                )?;
                if uses_autoincrement == 1 {
                    tx.execute("DELETE FROM sqlite_sequence WHERE name=?1", [table])?;
                }
            }
        }

        // This account is intentionally preserved by the developer database reset
        // so the developer can always regain ADMIN access after a full local reset.
        tx.execute(
            "INSERT INTO users (name, phone, role, password_hash, is_seed)
             VALUES (?1, NULL, 'ADMIN', ?2, 0)",
            [developer_username, developer_password_hash],
        )?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            tx.commit()?;
            Ok(())
        }
        Err(error) => {
            let _ = tx.rollback();
            Err(error)
        }
    }
}

fn table_exists(conn: &Db, table: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
        [table],
        |row| row.get::<_, i64>(0),
    )? == 1)
}
