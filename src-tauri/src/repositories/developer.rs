//! Full developer-data reset. This deletes every application row, never a
//! schema object. Order is child-first because the schema uses NO ACTION FKs.

use crate::error::AppResult;
use crate::repositories::Db;

/// Application tables the developer reset empties, in a strict CHILD-FIRST
/// order that satisfies the live foreign-key graph (see
/// `assert_order_matches_foreign_key_graph` in the service tests, which derives
/// the real graph from `pragma_foreign_key_list` and fails if this list drifts).
///
/// `_migrations` is the only schema table intentionally excluded: it is schema
/// metadata, not application data, and removing it would re-run every migration
/// over an already-migrated file.
///
/// `expense_categories` is deliberately NOT listed either. It is a system
/// reference table populated by its own migration and referenced by
/// `expenses.category`, so it behaves like configuration, not like the rows a
/// developer reset should destroy. The starter seed does not recreate it, so
/// deleting it here would leave the database permanently broken.
///
/// Order matters and is not cosmetic: every FK in this schema is NO ACTION, so
/// deleting a parent before its child aborts the whole transaction. Migration 25
/// added `expenses.shift_id -> shifts(id)`; `shifts` used to be deleted first,
/// which made the reset fail outright once any expense was booked against a
/// shift.
pub const APPLICATION_DATA_TABLES: &[&str] = &[
    "day_closing_shifts",
    "day_closing_expenses",
    "stock_movements",
    "order_lines",
    "invoice_lines",
    "invoice_customers",
    "payments",
    "table_sessions",
    "wash_tickets",
    "expenses",
    "credit_payments",
    "credit_accounts",
    "cars",
    "inventory_items",
    "invoices",
    "print_jobs",
    "audit_log",
    "orders",
    // The employees domain hangs off `users`, and an attendance day also
    // references the shift it happened on — so the whole domain is emptied
    // before `shifts` and `employees`, and `employees` immediately before its
    // parent `users`.
    "attendance_days",
    "employee_advances",
    "payroll_runs",
    "day_closings",
    "shifts",
    "sessions",
    "products",
    "categories",
    "cafe_tables",
    "customers",
    "business_days",
    "employees",
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
        // The developer admin needs an EMPLOYEE record too, exactly like every
        // login the starter seed creates. A `users` row on its own is not a
        // person: authentication resolves the actor's employee, so a preserved
        // login with no employee row would be refused as suspended and the
        // developer could never regain the ADMIN access this reset exists to
        // guarantee. `employee_type = 'CASHIER'` is forced by the schema CHECK
        // for a login-holding employee, and 'ACTIVE' is the state a reset means.
        tx.execute(
            "INSERT INTO employees (user_id, name, phone, employee_type, status, base_salary)
             VALUES (
                 (SELECT id FROM users WHERE name = ?1),
                 ?1, NULL, 'CASHIER', 'ACTIVE', 0
             )",
            [developer_username],
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
