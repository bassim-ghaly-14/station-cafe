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
/// `needs_fk_off` marks migrations that rebuild a table: SQLite refuses to
/// toggle `foreign_keys` inside a transaction, so the runner disables FK
/// enforcement around that migration and re-verifies integrity afterwards
/// (the documented procedure for the 12-step table rebuild).
struct Migration {
    version: i64,
    name: &'static str,
    needs_fk_off: bool,
    sql: &'static str,
}

/// Phase 2 — core business schema. All tables FK-linked, with CHECK
/// constraints enforcing lifecycle states, and snapshot columns so
/// historical transactions are immutable even when masters change.
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "core foundation",
        needs_fk_off: false,
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
    },
    Migration {
        version: 2,
        name: "core business system",
        needs_fk_off: false,
        sql: r#"
            -- ============================================================
            -- 2.1 AUTH / STAFF
            -- ============================================================
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                name          TEXT NOT NULL,
                phone         TEXT,
                role          TEXT NOT NULL CHECK (role IN ('ADMIN','MANAGER','STAFF')),
                status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
                password_hash TEXT NOT NULL,              -- Argon2id PHC string
                is_seed       INTEGER NOT NULL DEFAULT 0, -- demo-data flag (admin reset)
                created_at    TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name ON users(name);
            CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status);

            -- Sessions: token stored SHA-256 hashed; raw token lives client-side only.
            CREATE TABLE IF NOT EXISTS sessions (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL REFERENCES users(id),
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at TEXT NOT NULL,
                revoked_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

            -- ============================================================
            -- 2.2 CATALOG
            -- ============================================================
            CREATE TABLE IF NOT EXISTS products (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                name           TEXT NOT NULL,
                item_type      TEXT NOT NULL CHECK (item_type IN ('PRODUCT','SERVICE')),
                department     TEXT NOT NULL CHECK (department IN ('CAFE','WASH')),
                price_minor    INTEGER NOT NULL CHECK (price_minor >= 0),
                is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
                track_inventory INTEGER NOT NULL DEFAULT 0 CHECK (track_inventory IN (0,1)),
                is_seed        INTEGER NOT NULL DEFAULT 0,
                created_at     TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_products_dept_active ON products(department, is_active);

            -- ============================================================
            -- 2.3 CUSTOMERS & CARS
            -- ============================================================
            CREATE TABLE IF NOT EXISTS customers (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                phone      TEXT,
                notes      TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
            CREATE INDEX IF NOT EXISTS idx_customers_name  ON customers(name);

            CREATE TABLE IF NOT EXISTS cars (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL REFERENCES customers(id),
                plate_no    TEXT NOT NULL,
                car_model   TEXT,
                notes       TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_cars_plate ON cars(plate_no);
            CREATE INDEX IF NOT EXISTS idx_cars_customer ON cars(customer_id);

            -- Credit authorization is configuration, never hardcoded (DECISIONS.md #3).
            INSERT INTO app_settings (key, value) VALUES
              ('credit.mode', '"LIST"'),
              ('credit.allowed_customer_ids', '[]'),
              ('service_charge.mode', '"NONE"'),
              ('service_charge.value', '0'),
              ('invoice.next_number', '1'),
              ('wash.next_ticket', '1')
            ON CONFLICT(key) DO NOTHING;

            -- ============================================================
            -- 2.4 TABLES & ORDERS
            -- ============================================================
            CREATE TABLE IF NOT EXISTS cafe_tables (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                label      TEXT NOT NULL,
                is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_tables_label ON cafe_tables(label);

            CREATE TABLE IF NOT EXISTS orders (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                table_id     INTEGER NOT NULL REFERENCES cafe_tables(id),
                user_id      INTEGER NOT NULL REFERENCES users(id),
                business_day_id INTEGER REFERENCES business_days(id),
                shift_id     INTEGER,
                status       TEXT NOT NULL DEFAULT 'OPEN'
                             CHECK (status IN ('OPEN','READY_TO_PAY','CLOSED','CANCELLED')),
                opened_at    TEXT NOT NULL DEFAULT (datetime('now')),
                ready_at     TEXT,
                closed_at    TEXT
            );
            -- One live order per table at most (concurrency-safe by constraint).
            CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_open_table
                ON orders(table_id) WHERE status IN ('OPEN','READY_TO_PAY');
            CREATE INDEX IF NOT EXISTS idx_orders_shift ON orders(shift_id);
            CREATE INDEX IF NOT EXISTS idx_orders_day ON orders(business_day_id);

            CREATE TABLE IF NOT EXISTS order_lines (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id       INTEGER NOT NULL REFERENCES orders(id),
                product_id     INTEGER NOT NULL REFERENCES products(id),
                department     TEXT NOT NULL CHECK (department IN ('CAFE','WASH')),
                product_name   TEXT NOT NULL,           -- snapshot
                unit_price     INTEGER NOT NULL,        -- snapshot minor units
                quantity       INTEGER NOT NULL CHECK (quantity > 0),
                discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
                line_total     INTEGER NOT NULL CHECK (line_total >= 0),
                created_at     TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id);

            -- ============================================================
            -- 2.6 INVOICES (full snapshot — never joined to mutable masters)
            -- ============================================================
            CREATE TABLE IF NOT EXISTS invoices (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                invoice_no      INTEGER NOT NULL UNIQUE,
                order_id        INTEGER REFERENCES orders(id),
                table_label     TEXT,
                business_day_id INTEGER REFERENCES business_days(id),
                shift_id        INTEGER,
                user_id         INTEGER NOT NULL REFERENCES users(id),
                customer_id     INTEGER REFERENCES customers(id),
                status          TEXT NOT NULL DEFAULT 'PENDING_PAYMENT'
                    CHECK (status IN ('PENDING_PAYMENT','PAID','PARTIALLY_PAID','CREDIT','CANCELLED')),
                subtotal        INTEGER NOT NULL CHECK (subtotal >= 0),
                discount_minor  INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
                discount_mode   TEXT CHECK (discount_mode IN ('FIXED','PERCENT')),
                discount_value  INTEGER,
                service_charge  INTEGER NOT NULL DEFAULT 0 CHECK (service_charge >= 0),
                total           INTEGER NOT NULL CHECK (total >= 0),
                paid_amount     INTEGER NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
                cafe_total      INTEGER NOT NULL DEFAULT 0,
                wash_total      INTEGER NOT NULL DEFAULT 0,
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                paid_at         TEXT,
                cancelled_at    TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_invoices_day ON invoices(business_day_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_invoices_shift ON invoices(shift_id);
            CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);

            CREATE TABLE IF NOT EXISTS invoice_lines (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                invoice_id     INTEGER NOT NULL REFERENCES invoices(id),
                department     TEXT NOT NULL CHECK (department IN ('CAFE','WASH')),
                product_name   TEXT NOT NULL,
                unit_price     INTEGER NOT NULL CHECK (unit_price >= 0),
                quantity       INTEGER NOT NULL CHECK (quantity > 0),
                discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
                line_total     INTEGER NOT NULL CHECK (line_total >= 0)
            );
            CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id);

            -- Customer/car snapshot at transaction time
            CREATE TABLE IF NOT EXISTS invoice_customers (
                invoice_id     INTEGER PRIMARY KEY REFERENCES invoices(id),
                customer_name  TEXT NOT NULL,
                customer_phone TEXT,
                car_plate      TEXT,
                car_model      TEXT
            );

            -- Waiting number per business day for wash job tickets
            CREATE TABLE IF NOT EXISTS wash_tickets (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                invoice_id INTEGER NOT NULL UNIQUE REFERENCES invoices(id),
                waiting_no INTEGER NOT NULL,
                day_date   TEXT NOT NULL,
                issued_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_wash_tickets_day_no
                ON wash_tickets(day_date, waiting_no);

            -- ============================================================
            -- 2.5 PAYMENTS & CREDIT
            -- ============================================================
            CREATE TABLE IF NOT EXISTS payments (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                invoice_id   INTEGER NOT NULL REFERENCES invoices(id),
                method       TEXT NOT NULL CHECK (method IN ('CASH','CARD','CREDIT')),
                amount       INTEGER NOT NULL CHECK (amount > 0),
                received     INTEGER,
                change_given INTEGER,
                user_id      INTEGER NOT NULL REFERENCES users(id),
                created_at   TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);

            CREATE TABLE IF NOT EXISTS credit_accounts (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id    INTEGER NOT NULL UNIQUE REFERENCES customers(id),
                original_total INTEGER NOT NULL CHECK (original_total >= 0),
                paid_total     INTEGER NOT NULL DEFAULT 0 CHECK (paid_total >= 0),
                status         TEXT NOT NULL DEFAULT 'UNPAID'
                               CHECK (status IN ('UNPAID','PARTIALLY_PAID','PAID')),
                created_at     TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS credit_payments (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                credit_account_id INTEGER NOT NULL REFERENCES credit_accounts(id),
                amount            INTEGER NOT NULL CHECK (amount > 0),
                user_id           INTEGER NOT NULL REFERENCES users(id),
                created_at        TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_credit_payments_acct ON credit_payments(credit_account_id);

            -- ============================================================
            -- 2.8 SHIFTS
            -- ============================================================
            CREATE TABLE IF NOT EXISTS shifts (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                business_day_id INTEGER NOT NULL REFERENCES business_days(id),
                user_id         INTEGER NOT NULL REFERENCES users(id),
                status          TEXT NOT NULL DEFAULT 'ACTIVE'
                                CHECK (status IN ('ACTIVE','CLOSING','CLOSED')),
                opened_at       TEXT NOT NULL DEFAULT (datetime('now')),
                opening_cash    INTEGER NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
                closed_at       TEXT,
                cash_sales      INTEGER NOT NULL DEFAULT 0,
                card_sales      INTEGER NOT NULL DEFAULT 0,
                credit_sales    INTEGER NOT NULL DEFAULT 0,
                service_charges INTEGER NOT NULL DEFAULT 0,
                discounts       INTEGER NOT NULL DEFAULT 0,
                invoices_count  INTEGER NOT NULL DEFAULT 0,
                expected_cash   INTEGER NOT NULL DEFAULT 0,
                actual_cash     INTEGER,
                cash_difference INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_shifts_day ON shifts(business_day_id);
            CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status);

            -- ============================================================
            -- 2.9 EXPENSES & INVENTORY
            -- ============================================================
            CREATE TABLE IF NOT EXISTS expenses (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                category        TEXT NOT NULL CHECK
                    (category IN ('MAINTENANCE','SUPPLIES','UTILITY','SALARY','EMERGENCY','OTHER')),
                amount          INTEGER NOT NULL CHECK (amount > 0),
                description     TEXT,
                expense_date    TEXT NOT NULL,
                is_recurring    INTEGER NOT NULL DEFAULT 0 CHECK (is_recurring IN (0,1)),
                recurrence      TEXT CHECK (recurrence IN ('WEEKLY','MONTHLY') OR is_recurring = 0),
                business_day_id INTEGER REFERENCES business_days(id),
                user_id         INTEGER NOT NULL REFERENCES users(id),
                is_seed         INTEGER NOT NULL DEFAULT 0,
                created_at      TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);

            CREATE TABLE IF NOT EXISTS inventory_items (
                product_id   INTEGER PRIMARY KEY REFERENCES products(id),
                quantity     INTEGER NOT NULL DEFAULT 0,
                min_quantity INTEGER NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
                updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS stock_movements (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id     INTEGER NOT NULL REFERENCES products(id),
                change         INTEGER NOT NULL CHECK (change != 0),
                reason         TEXT NOT NULL CHECK (reason IN ('SALE','PURCHASE','ADJUSTMENT','WASTE','SEED')),
                note           TEXT,
                ref_invoice_id INTEGER REFERENCES invoices(id),
                user_id        INTEGER NOT NULL REFERENCES users(id),
                created_at     TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);

            -- ============================================================
            -- 2.7 PRINTING (duplicate protection / retry tracking)
            -- ============================================================
            CREATE TABLE IF NOT EXISTS print_jobs (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_type     TEXT NOT NULL CHECK
                    (doc_type IN ('CAFE_INVOICE','WASH_INVOICE','HYBRID_INVOICE',
                                  'WASH_TICKET','SHIFT_REPORT','DAY_REPORT','TEST')),
                ref_id       INTEGER,
                content_hash TEXT NOT NULL,
                status       TEXT NOT NULL DEFAULT 'PENDING'
                             CHECK (status IN ('PENDING','PRINTED','FAILED')),
                attempts     INTEGER NOT NULL DEFAULT 0,
                error        TEXT,
                created_at   TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_print_jobs_hash ON print_jobs(content_hash);
        "#,
    },
    Migration {
        version: 3,
        name: "wash tickets link to orders",
        needs_fk_off: false,
        sql: r#"
            -- A wash job ticket is issued when the wash STARTS (order stage),
            -- before any invoice exists — so it must reference the order.
            DROP TABLE IF EXISTS wash_tickets;
            CREATE TABLE wash_tickets (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id   INTEGER NOT NULL UNIQUE REFERENCES orders(id),
                waiting_no INTEGER NOT NULL,
                day_date   TEXT NOT NULL,
                issued_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE UNIQUE INDEX idx_wash_tickets_day_no ON wash_tickets(day_date, waiting_no);
        "#,
    },
    Migration {
        version: 4,
        name: "orders customer and waiting columns",
        needs_fk_off: false,
        sql: r#"
            -- v2 defined the orders columns but never created them; v3-era
            -- repositories read them. Add them additively (never edit v2).
            ALTER TABLE orders ADD COLUMN customer_id INTEGER REFERENCES customers(id);
            ALTER TABLE orders ADD COLUMN waiting_no INTEGER;
            CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
        "#,
    },
    Migration {
        version: 5,
        name: "table sessions",
        needs_fk_off: false,
        sql: r#"
            -- ============================================================
            -- TABLE SESSIONS
            -- A table lifecycle is explicit: opening a table is its own
            -- event, independent of whether an order is ever created.
            -- `order_id IS NULL` on a CLOSED session ⇒ "opened and closed
            -- without an order" (no invoice, no revenue, still auditable).
            -- ============================================================
            CREATE TABLE IF NOT EXISTS table_sessions (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                table_id        INTEGER NOT NULL REFERENCES cafe_tables(id),
                business_day_id INTEGER REFERENCES business_days(id),
                shift_id        INTEGER REFERENCES shifts(id),
                opened_by       INTEGER NOT NULL REFERENCES users(id),
                opened_at       TEXT NOT NULL DEFAULT (datetime('now')),
                order_id        INTEGER REFERENCES orders(id),
                closed_by       INTEGER REFERENCES users(id),
                closed_at       TEXT,
                status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED'))
            );
            -- At most ONE live session per table (concurrency-safe).
            CREATE UNIQUE INDEX IF NOT EXISTS idx_table_sessions_open
                ON table_sessions(table_id) WHERE status = 'OPEN';
            CREATE INDEX IF NOT EXISTS idx_table_sessions_day
                ON table_sessions(business_day_id, status);
            CREATE INDEX IF NOT EXISTS idx_table_sessions_table
                ON table_sessions(table_id, opened_at);
        "#,
    },
    Migration {
        version: 6,
        name: "order context and takeaway orders",
        needs_fk_off: true,
        sql: r#"
            -- ============================================================
            -- ORDER CONTEXT (TABLE | TAKEAWAY)
            -- Takeaway is a first-class order context: never a fake table,
            -- never a reserved table number. Making `orders.table_id`
            -- nullable requires a rebuild (SQLite cannot drop NOT NULL);
            -- the standard 12-step procedure is used and every row keeps its
            -- id so invoice/line references stay valid.
            -- ============================================================
            -- The runner executes this migration with FK enforcement off and
            -- verifies integrity before committing (see `apply_migrations`).
            CREATE TABLE orders_new (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                order_type      TEXT NOT NULL DEFAULT 'TABLE'
                                CHECK (order_type IN ('TABLE','TAKEAWAY')),
                table_id        INTEGER REFERENCES cafe_tables(id),
                user_id         INTEGER NOT NULL REFERENCES users(id),
                business_day_id INTEGER REFERENCES business_days(id),
                shift_id        INTEGER,
                status          TEXT NOT NULL DEFAULT 'OPEN'
                                CHECK (status IN ('OPEN','READY_TO_PAY','CLOSED','CANCELLED')),
                takeaway_no     INTEGER,
                opened_at       TEXT NOT NULL DEFAULT (datetime('now')),
                ready_at        TEXT,
                closed_at       TEXT,
                customer_id     INTEGER REFERENCES customers(id),
                waiting_no      INTEGER,
                -- A table order always has a table; takeaway never does.
                CHECK ((order_type = 'TABLE' AND table_id IS NOT NULL)
                       OR (order_type = 'TAKEAWAY' AND table_id IS NULL))
            );

            -- Existing rows are all table orders (data preserved verbatim).
            INSERT INTO orders_new (id, order_type, table_id, user_id, business_day_id, shift_id,
                                    status, opened_at, ready_at, closed_at, customer_id, waiting_no)
                SELECT id, 'TABLE', table_id, user_id, business_day_id, shift_id,
                       status, opened_at, ready_at, closed_at, customer_id, waiting_no
                FROM orders;

            DROP TABLE orders;
            ALTER TABLE orders_new RENAME TO orders;

            CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_open_table
                ON orders(table_id) WHERE status IN ('OPEN','READY_TO_PAY');
            CREATE INDEX IF NOT EXISTS idx_orders_shift ON orders(shift_id);
            CREATE INDEX IF NOT EXISTS idx_orders_day ON orders(business_day_id);
            CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
            -- Per business-day takeaway sequence — uniqueness by constraint.
            CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_takeaway_day_no
                ON orders(business_day_id, takeaway_no) WHERE takeaway_no IS NOT NULL;

            -- Live orders that predate sessions get their session backfilled so
            -- the table grid stays correct and the history stays traceable.
            INSERT INTO table_sessions (table_id, business_day_id, shift_id, opened_by,
                                        opened_at, order_id)
                SELECT o.table_id, o.business_day_id, o.shift_id, o.user_id, o.opened_at, o.id
                FROM orders o
                WHERE o.status IN ('OPEN','READY_TO_PAY') AND o.table_id IS NOT NULL;
        "#,
    },
    Migration {
        version: 7,
        name: "invoice context snapshot and takeaway receipt type",
        needs_fk_off: false,
        sql: r#"
            -- ============================================================
            -- INVOICE SNAPSHOT OF THE ORDER CONTEXT
            -- The receipt must stay reproducible: the takeaway number is
            -- stored on the invoice, never re-derived from mutable rows.
            -- ============================================================
            ALTER TABLE invoices ADD COLUMN order_type TEXT NOT NULL DEFAULT 'TABLE';
            ALTER TABLE invoices ADD COLUMN takeaway_no INTEGER;

            -- ============================================================
            -- TAKEAWAY RECEIPT DOCUMENT TYPE
            -- print_jobs has a CHECK on doc_type → rebuild (append-only log,
            -- nothing references it; every row is preserved).
            -- ============================================================
            CREATE TABLE print_jobs_new (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_type     TEXT NOT NULL CHECK
                    (doc_type IN ('CAFE_INVOICE','WASH_INVOICE','HYBRID_INVOICE','TAKEAWAY_INVOICE',
                                  'WASH_TICKET','SHIFT_REPORT','DAY_REPORT','TEST')),
                ref_id       INTEGER,
                content_hash TEXT NOT NULL,
                status       TEXT NOT NULL DEFAULT 'PENDING'
                             CHECK (status IN ('PENDING','PRINTED','FAILED')),
                attempts     INTEGER NOT NULL DEFAULT 0,
                error        TEXT,
                created_at   TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO print_jobs_new (id, doc_type, ref_id, content_hash, status,
                                        attempts, error, created_at)
                SELECT id, doc_type, ref_id, content_hash, status, attempts, error, created_at
                FROM print_jobs;
            DROP TABLE print_jobs;
            ALTER TABLE print_jobs_new RENAME TO print_jobs;
            CREATE INDEX IF NOT EXISTS idx_print_jobs_hash ON print_jobs(content_hash);
        "#,
    },
];

pub fn migrate(conn: &Db) -> AppResult<()> {
    apply_migrations(conn, None)
}

/// Apply embedded migrations in version order. `up_to` is used by tests to
/// build a pre-upgrade database and verify the data-preserving path.
fn apply_migrations(conn: &Db, up_to: Option<i64>) -> AppResult<()> {
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
        if m.version <= current || up_to.is_some_and(|v| m.version > v) {
            continue;
        }
        // A table rebuild must run with FK enforcement off (SQLite ignores the
        // pragma inside a transaction); integrity is verified before commit.
        if m.needs_fk_off {
            conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
        }
        conn.execute_batch("BEGIN IMMEDIATE;")?;
        let result = conn
            .execute_batch(m.sql)
            .map_err(AppError::from)
            .and_then(|_| check_no_fk_violations(conn))
            .and_then(|_| {
                let n = conn
                    .execute(
                        "INSERT INTO _migrations (version, name) VALUES (?1, ?2)",
                        rusqlite::params![m.version, m.name],
                    )
                    .map_err(AppError::from)?;
                Ok(n)
            });
        match result {
            Ok(_) => conn.execute_batch("COMMIT;")?,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                if m.needs_fk_off {
                    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
                }
                return Err(e);
            }
        }
        if m.needs_fk_off {
            conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        }
        log::info!("applied migration {}: {}", m.version, m.name);
    }
    Ok(())
}

/// Safety net for migrations that rebuild tables: never leave the database
/// with dangling references (checked BEFORE the migration commits).
fn check_no_fk_violations(conn: &Db) -> AppResult<()> {
    let mut stmt = conn.prepare("PRAGMA foreign_key_check;")?;
    let mut rows = stmt.query([])?;
    if let Some(row) = rows.next()? {
        let table: String = row.get(0).unwrap_or_default();
        return Err(AppError::internal(format!(
            "foreign key violation in {table}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn
    }

    #[test]
    fn migrations_apply_in_order_and_are_idempotent() {
        let conn = memory_db();
        migrate(&conn).unwrap();
        // Running twice must be a no-op
        migrate(&conn).unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM _migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, MIGRATIONS.len() as i64);

        // Foundation tables exist
        for table in [
            "app_settings",
            "business_days",
            "audit_log",
            "users",
            "sessions",
            "products",
            "customers",
            "cars",
            "cafe_tables",
            "table_sessions",
            "orders",
            "order_lines",
            "invoices",
            "invoice_lines",
            "invoice_customers",
            "wash_tickets",
            "payments",
            "credit_accounts",
            "credit_payments",
            "shifts",
            "expenses",
            "inventory_items",
            "stock_movements",
            "print_jobs",
        ] {
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

    /// Production-like upgrade path: a database written by the previous schema
    /// (v4) must keep every order/invoice/line row and its references intact.
    #[test]
    fn order_context_upgrade_preserves_historical_data() {
        let conn = memory_db();
        apply_migrations(&conn, Some(4)).unwrap();

        // Legacy shape: a live order (with a line), a paid invoice + payment,
        // a closed order and a print job — all pre-upgrade data.
        conn.execute_batch(
            "INSERT INTO users (name, role, password_hash) VALUES ('u','STAFF','x');
             INSERT INTO cafe_tables (label) VALUES ('طاولة 01'), ('طاولة 02');
             INSERT INTO business_days (day_date, opened_at) VALUES ('2026-01-01', datetime('now'));
             INSERT INTO products (name, item_type, department, price_minor)
                 VALUES ('قهوة','PRODUCT','CAFE',3000);
             INSERT INTO orders (table_id, user_id, business_day_id, status, customer_id, waiting_no)
                 VALUES (1, 1, 1, 'OPEN', NULL, NULL);
             INSERT INTO orders (table_id, user_id, business_day_id, status)
                 VALUES (2, 1, 1, 'CLOSED');
             INSERT INTO order_lines (order_id, product_id, department, product_name, unit_price, quantity, line_total)
                 VALUES (1, 1, 'CAFE', 'قهوة', 3000, 2, 6000);
             INSERT INTO invoices (invoice_no, order_id, table_label, business_day_id, user_id,
                                   status, subtotal, total, paid_amount)
                 VALUES (1, 2, 'طاولة 02', 1, 1, 'PAID', 6000, 6000, 6000);
             INSERT INTO invoice_lines (invoice_id, department, product_name, unit_price, quantity, line_total)
                 VALUES (1, 'CAFE', 'قهوة', 3000, 2, 6000);
             INSERT INTO payments (invoice_id, method, amount, user_id) VALUES (1, 'CASH', 6000, 1);
             INSERT INTO print_jobs (doc_type, ref_id, content_hash, status)
                 VALUES ('CAFE_INVOICE', 1, 'hash1', 'PRINTED');",
        )
        .unwrap();

        // Upgrade.
        migrate(&conn).unwrap();

        let counts: (i64, i64, i64, i64, i64, i64) = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM orders),
                        (SELECT COUNT(*) FROM order_lines),
                        (SELECT COUNT(*) FROM invoices),
                        (SELECT COUNT(*) FROM invoice_lines),
                        (SELECT COUNT(*) FROM payments),
                        (SELECT COUNT(*) FROM print_jobs)",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(counts, (2, 1, 1, 1, 1, 1));

        // Order ids/references survive the rebuild and legacy rows read back.
        let (otype, table_id, status): (String, i64, String) = conn
            .query_row(
                "SELECT order_type, table_id, status FROM orders WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (otype.as_str(), table_id, status.as_str()),
            ("TABLE", 1, "OPEN")
        );

        // Live order → backfilled session linked to that order.
        let (sessions, session_order): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(order_id), 0) FROM table_sessions",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((sessions, session_order), (1, 1));

        // Invoice context defaults to a table order and keeps its order link.
        let (itype, takeaway, order_id): (String, Option<i64>, i64) = conn
            .query_row(
                "SELECT order_type, takeaway_no, order_id FROM invoices WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((itype.as_str(), takeaway, order_id), ("TABLE", None, 2));

        // The rebuilt orders table accepts a table-less takeaway order, refuses
        // one that fakes a table, and refuses a duplicate takeaway number.
        conn.execute(
            "INSERT INTO orders (order_type, user_id, business_day_id, takeaway_no)
             VALUES ('TAKEAWAY', 1, 1, 1)",
            [],
        )
        .unwrap();
        assert!(conn
            .execute(
                "INSERT INTO orders (order_type, table_id, user_id, business_day_id)
                 VALUES ('TAKEAWAY', 1, 1, 1)",
                [],
            )
            .is_err());
        assert!(conn
            .execute(
                "INSERT INTO orders (order_type, user_id, business_day_id, takeaway_no)
                 VALUES ('TAKEAWAY', 1, 1, 1)",
                [],
            )
            .is_err());
    }
}
