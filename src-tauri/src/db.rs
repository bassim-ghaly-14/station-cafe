//! SQLite connection + migration management.
//!
//! Migration strategy: numbered SQL migrations embedded in the binary,
//! applied inside transactions, tracked in `_migrations` (schema_migrations).
//! Never edit an applied migration — always add a new numbered file.

use crate::error::{AppError, AppResult};
use rusqlite::functions::FunctionFlags;
use rusqlite::Connection;
use std::path::Path;

pub type Db = Connection;

/// Register the canonical Station clock as SQLite scalar functions.
///
/// This is the centralized clock abstraction: SQL anywhere in the application
/// asks for the time through these functions instead of embedding its own
/// notion of "now". It also means the *same* OS clock drives the backend, with
/// no internet time source and no attempt to change the machine's clock.
///
/// * `station_now()`  — the current instant, explicit UTC (`...Z`).
/// * `station_today()` — today's *business* date in `Africa/Cairo`.
///
/// `migrate` calls this for every connection, so tests and production share
/// one clock definition.
pub fn register_clock(conn: &Db) -> AppResult<()> {
    // Both functions take zero arguments.
    conn.create_scalar_function(
        "station_now",
        0,
        FunctionFlags::SQLITE_UTF8,
        |_ctx| Ok(crate::time::now_db_timestamp()),
    )?;
    conn.create_scalar_function(
        "station_today",
        0,
        FunctionFlags::SQLITE_UTF8,
        |_ctx| Ok(crate::time::today_business_date()),
    )?;
    Ok(())
}

/// The single active SQLite database file.
pub const DB_FILE: &str = "station_cafe.db";

pub fn open(data_dir: &Path) -> AppResult<Db> {
    std::fs::create_dir_all(data_dir)?;
    let db_path = data_dir.join(DB_FILE);
    let conn = Connection::open(&db_path)?;

    // The canonical clock must exist before any migration default or query uses it.
    register_clock(&conn)?;

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
            updated_at  TEXT NOT NULL DEFAULT (station_now())
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
            created_at  TEXT NOT NULL DEFAULT (station_now())
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
                created_at    TEXT NOT NULL DEFAULT (station_now()),
                updated_at    TEXT NOT NULL DEFAULT (station_now())
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name ON users(name);
            CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status);

            -- Sessions: token stored SHA-256 hashed; raw token lives client-side only.
            CREATE TABLE IF NOT EXISTS sessions (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL REFERENCES users(id),
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL DEFAULT (station_now()),
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
                created_at     TEXT NOT NULL DEFAULT (station_now()),
                updated_at     TEXT NOT NULL DEFAULT (station_now())
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
                created_at TEXT NOT NULL DEFAULT (station_now()),
                updated_at TEXT NOT NULL DEFAULT (station_now())
            );
            CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
            CREATE INDEX IF NOT EXISTS idx_customers_name  ON customers(name);

            CREATE TABLE IF NOT EXISTS cars (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL REFERENCES customers(id),
                plate_no    TEXT NOT NULL,
                car_model   TEXT,
                notes       TEXT,
                created_at  TEXT NOT NULL DEFAULT (station_now()),
                updated_at  TEXT NOT NULL DEFAULT (station_now())
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
                opened_at    TEXT NOT NULL DEFAULT (station_now()),
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
                created_at     TEXT NOT NULL DEFAULT (station_now())
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
                created_at      TEXT NOT NULL DEFAULT (station_now()),
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
                issued_at  TEXT NOT NULL DEFAULT (station_now())
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
                created_at   TEXT NOT NULL DEFAULT (station_now())
            );
            CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);

            CREATE TABLE IF NOT EXISTS credit_accounts (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id    INTEGER NOT NULL UNIQUE REFERENCES customers(id),
                original_total INTEGER NOT NULL CHECK (original_total >= 0),
                paid_total     INTEGER NOT NULL DEFAULT 0 CHECK (paid_total >= 0),
                status         TEXT NOT NULL DEFAULT 'UNPAID'
                               CHECK (status IN ('UNPAID','PARTIALLY_PAID','PAID')),
                created_at     TEXT NOT NULL DEFAULT (station_now()),
                updated_at     TEXT NOT NULL DEFAULT (station_now())
            );

            CREATE TABLE IF NOT EXISTS credit_payments (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                credit_account_id INTEGER NOT NULL REFERENCES credit_accounts(id),
                amount            INTEGER NOT NULL CHECK (amount > 0),
                user_id           INTEGER NOT NULL REFERENCES users(id),
                created_at        TEXT NOT NULL DEFAULT (station_now())
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
                opened_at       TEXT NOT NULL DEFAULT (station_now()),
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
                created_at      TEXT NOT NULL DEFAULT (station_now())
            );
            CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);

            CREATE TABLE IF NOT EXISTS inventory_items (
                product_id   INTEGER PRIMARY KEY REFERENCES products(id),
                quantity     INTEGER NOT NULL DEFAULT 0,
                min_quantity INTEGER NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
                updated_at   TEXT NOT NULL DEFAULT (station_now())
            );

            CREATE TABLE IF NOT EXISTS stock_movements (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id     INTEGER NOT NULL REFERENCES products(id),
                change         INTEGER NOT NULL CHECK (change != 0),
                reason         TEXT NOT NULL CHECK (reason IN ('SALE','PURCHASE','ADJUSTMENT','WASTE','SEED')),
                note           TEXT,
                ref_invoice_id INTEGER REFERENCES invoices(id),
                user_id        INTEGER NOT NULL REFERENCES users(id),
                created_at     TEXT NOT NULL DEFAULT (station_now())
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
                created_at   TEXT NOT NULL DEFAULT (station_now())
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
                issued_at  TEXT NOT NULL DEFAULT (station_now())
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
                opened_at       TEXT NOT NULL DEFAULT (station_now()),
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
                opened_at       TEXT NOT NULL DEFAULT (station_now()),
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
                created_at   TEXT NOT NULL DEFAULT (station_now())
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
    Migration {
        version: 9,
        name: "remove demo data provenance",
        needs_fk_off: false,
        sql: r#"
            DROP TABLE IF EXISTS demo_data_records;
        "#,
    },
    Migration {
        version: 10,
        name: "incremental day settlements and single active shift",
        needs_fk_off: false,
        sql: r#"
            -- Station is a single till: enforce the operational invariant in SQLite,
            -- not only in the UI/service preflight checks.
            CREATE UNIQUE INDEX idx_shifts_one_active_global
                ON shifts((1)) WHERE status = 'ACTIVE';

            -- A settlement is an immutable checkpoint. The existing
            -- business_days CLOSED state remains the final operational closure.
            CREATE TABLE day_closings (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                business_day_id   INTEGER NOT NULL REFERENCES business_days(id),
                closed_by         INTEGER NOT NULL REFERENCES users(id),
                closed_at         TEXT NOT NULL DEFAULT (station_now()),
                invoices_count    INTEGER NOT NULL DEFAULT 0,
                cafe_sales        INTEGER NOT NULL DEFAULT 0,
                wash_sales        INTEGER NOT NULL DEFAULT 0,
                subtotal          INTEGER NOT NULL DEFAULT 0,
                discounts         INTEGER NOT NULL DEFAULT 0,
                service_charges   INTEGER NOT NULL DEFAULT 0,
                total_sales       INTEGER NOT NULL DEFAULT 0,
                cash              INTEGER NOT NULL DEFAULT 0,
                card              INTEGER NOT NULL DEFAULT 0,
                credit            INTEGER NOT NULL DEFAULT 0,
                expenses          INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX idx_day_closings_day ON day_closings(business_day_id, id);

            CREATE TABLE day_closing_shifts (
                day_closing_id INTEGER NOT NULL REFERENCES day_closings(id),
                shift_id       INTEGER NOT NULL UNIQUE REFERENCES shifts(id),
                PRIMARY KEY (day_closing_id, shift_id)
            );
            CREATE INDEX idx_day_closing_shifts_closing
                ON day_closing_shifts(day_closing_id, shift_id);

            -- Expenses are day-level today. Associate each with exactly one
            -- checkpoint so later checkpoints cannot report it again.
            CREATE TABLE day_closing_expenses (
                day_closing_id INTEGER NOT NULL REFERENCES day_closings(id),
                expense_id     INTEGER NOT NULL UNIQUE REFERENCES expenses(id),
                PRIMARY KEY (day_closing_id, expense_id)
            );
        "#,
    },
    Migration {
        version: 11,
        name: "persist order discount selection",
        needs_fk_off: false,
        sql: r#"
            -- Discount belongs to the persistent order, not React state:
            -- refresh / reopen / restart must reconstruct it from SQLite.
            ALTER TABLE orders ADD COLUMN discount_mode TEXT
                CHECK (discount_mode IN ('FIXED','PERCENT'));
            ALTER TABLE orders ADD COLUMN discount_value INTEGER;
        "#,
    },
    Migration {
        version: 12,
        name: "final immutable business day report snapshot",
        needs_fk_off: false,
        sql: r#"
            ALTER TABLE day_closings ADD COLUMN final_snapshot INTEGER NOT NULL DEFAULT 0;
            CREATE UNIQUE INDEX idx_day_closings_one_final
                ON day_closings(business_day_id) WHERE final_snapshot = 1;
        "#,
    },
    Migration {
        version: 13,
        name: "one open business day and repeatable operational days",
        needs_fk_off: true,
        sql: r#"
            -- Business-day identity is operational, not the calendar label.
            -- Keep all historical rows while allowing a new day after an
            -- explicit close even when both days have the same date.
            CREATE TABLE business_days_new (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                day_date    TEXT NOT NULL,
                opened_at   TEXT NOT NULL,
                closed_at   TEXT,
                status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
                opened_by   INTEGER,
                closed_by   INTEGER
            );
            INSERT INTO business_days_new
                (id, day_date, opened_at, closed_at, status, opened_by, closed_by)
            SELECT id, day_date, opened_at, closed_at, status, opened_by, closed_by
            FROM business_days;
            DROP TABLE business_days;
            ALTER TABLE business_days_new RENAME TO business_days;
            CREATE INDEX idx_bday_status ON business_days(status);
            CREATE UNIQUE INDEX idx_business_days_one_open
                ON business_days(status) WHERE status = 'OPEN';
        "#,
    },
    Migration {
        version: 14,
        name: "required catalog categories and consistent stock state",
        needs_fk_off: true,
        sql: r#"
            CREATE TABLE categories (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL COLLATE NOCASE UNIQUE
                           CHECK (name = trim(name) AND length(name) > 0),
                is_system  INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
                created_at TEXT NOT NULL DEFAULT (station_now()),
                updated_at TEXT NOT NULL DEFAULT (station_now())
            );
            INSERT INTO categories (name, is_system) VALUES ('عام', 1);

            CREATE TABLE products_new (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                name            TEXT NOT NULL,
                item_type       TEXT NOT NULL CHECK (item_type IN ('PRODUCT','SERVICE')),
                department      TEXT NOT NULL CHECK (department IN ('CAFE','WASH')),
                category_id     INTEGER NOT NULL REFERENCES categories(id),
                price_minor     INTEGER NOT NULL CHECK (price_minor >= 0),
                is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
                track_inventory INTEGER NOT NULL DEFAULT 0 CHECK (track_inventory IN (0,1)),
                is_seed         INTEGER NOT NULL DEFAULT 0,
                created_at      TEXT NOT NULL DEFAULT (station_now()),
                updated_at      TEXT NOT NULL DEFAULT (station_now())
            );
            INSERT INTO products_new
                (id, name, item_type, department, category_id, price_minor,
                 is_active, track_inventory, is_seed, created_at, updated_at)
            SELECT p.id, p.name, p.item_type, p.department,
                   (SELECT id FROM categories WHERE is_system = 1 ORDER BY id LIMIT 1),
                   p.price_minor, p.is_active, p.track_inventory, p.is_seed,
                   p.created_at, p.updated_at
            FROM products p;
            DROP TABLE products;
            ALTER TABLE products_new RENAME TO products;
            CREATE INDEX idx_products_dept_active ON products(department, is_active);
            CREATE INDEX idx_products_category ON products(category_id);

            INSERT OR IGNORE INTO inventory_items (product_id, quantity, min_quantity)
                SELECT id, 0, 0 FROM products WHERE track_inventory = 1;
            -- Keep legacy inventory rows for history; list_stock filters to tracked items.
            -- Runtime stock changes continue through inventory services.
        "#,
    },
    Migration {
        version: 15,
        name: "canonical developer settings and credit enablement",
        needs_fk_off: false,
        sql: r#"
            -- Legacy keys remain for compatibility with already-applied seeds.
            -- Runtime accessors below use these canonical JSON keys only.
            INSERT INTO app_settings (key, value) VALUES
              ('service_charge', json_object(
                'mode', json(COALESCE((SELECT value FROM app_settings WHERE key = 'service_charge.mode'), '"NONE"')),
                'value', CAST(COALESCE((SELECT value FROM app_settings WHERE key = 'service_charge.value'), '0') AS INTEGER)
              )),
              ('credit', json_object(
                'enabled', json('true'),
                'mode', json(COALESCE((SELECT value FROM app_settings WHERE key = 'credit.mode'), '"LIST"')),
                'allowed_customer_ids', json(COALESCE((SELECT value FROM app_settings WHERE key = 'credit.allowed_customer_ids'), '[]'))
              )),
              ('discount_limit', '{"mode":"PERCENT","value":100000}')
            ON CONFLICT(key) DO NOTHING;
        "#,
    },
    Migration {
        version: 16,
        name: "normalize legacy developer settings JSON",
        needs_fk_off: false,
        sql: r#"
            -- Migration 15 wrapped legacy JSON fragments with json(...), which
            -- encoded enum tokens and arrays as JSON strings. Normalize only
            -- those observed shapes; valid canonical rows remain unchanged.
            UPDATE app_settings
            SET value = json_object(
                'mode', CASE
                    WHEN json_type(value, '$.mode') = 'text'
                         AND json_valid(json_extract(value, '$.mode'))
                        THEN json(json_extract(value, '$.mode'))
                    ELSE json_extract(value, '$.mode')
                END,
                'value', CAST(json_extract(value, '$.value') AS INTEGER)
            )
            WHERE key = 'service_charge'
              AND json_valid(value)
              AND json_type(value, '$.mode') = 'text'
              AND json_valid(json_extract(value, '$.mode'));

            UPDATE app_settings
            SET value = json_object(
                'enabled', CASE
                    WHEN json_type(value, '$.enabled') = 'true' THEN json('true')
                    WHEN json_type(value, '$.enabled') = 'false' THEN json('false')
                    ELSE json_extract(value, '$.enabled')
                END,
                'mode', CASE
                    WHEN json_type(value, '$.mode') = 'text'
                         AND json_valid(json_extract(value, '$.mode'))
                        THEN json(json_extract(value, '$.mode'))
                    ELSE json_extract(value, '$.mode')
                END,
                'allowed_customer_ids', CASE
                    WHEN json_type(value, '$.allowed_customer_ids') = 'text'
                         AND json_valid(json_extract(value, '$.allowed_customer_ids'))
                        THEN json(json_extract(value, '$.allowed_customer_ids'))
                    ELSE json_extract(value, '$.allowed_customer_ids')
                END
            )
            WHERE key = 'credit'
              AND json_valid(value)
              AND (
                    (json_type(value, '$.mode') = 'text'
                     AND json_valid(json_extract(value, '$.mode')))
                    OR (json_type(value, '$.allowed_customer_ids') = 'text'
                        AND json_valid(json_extract(value, '$.allowed_customer_ids')))
                  );
        "#,
    },
    Migration {
        version: 17,
        name: "normalize credit enabled boolean",
        needs_fk_off: false,
        sql: r#"
            -- Older JSON1 normalization could materialize a boolean as 0/1.
            -- Preserve the domain boolean while repairing only those exact types.
            UPDATE app_settings
            SET value = json_set(value, '$.enabled',
                CASE json_extract(value, '$.enabled')
                    WHEN 0 THEN json('false')
                    WHEN 1 THEN json('true')
                    ELSE json_extract(value, '$.enabled')
                END)
            WHERE key = 'credit'
              AND json_valid(value)
              AND json_type(value, '$.enabled') = 'integer'
              AND json_extract(value, '$.enabled') IN (0, 1);
        "#,
    },
    Migration {
        version: 18,
        name: "fixed service charge options and discount authorization",
        needs_fk_off: false,
        sql: r#"
            -- Percentage mode is replaced, never converted into a percentage.
            INSERT INTO app_settings (key, value, updated_at) VALUES
              ('service_charge', '[]', station_now())
            ON CONFLICT(key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at;

            DELETE FROM app_settings WHERE key = 'discount_limit';
        "#,
    },
    Migration {
        version: 19,
        name: "explicit utc instant timestamps",
        needs_fk_off: false,
        sql: r#"
            -- Every timestamp column historically held SQLite's
            -- `datetime('now')` output: `YYYY-MM-DD HH:MM:SS` in UTC with NO
            -- timezone marker. That is a correct instant but an ambiguous
            -- string, and the UI was displaying those UTC digits as if they
            -- were Station local time.
            --
            -- This migration changes the REPRESENTATION only, never the
            -- instant: it appends the `Z` that makes each value explicitly
            -- UTC. No time is shifted, re-interpreted, or re-zoned, so every
            -- historical invoice, shift, expense and audit record keeps exactly
            -- the real-world moment it always referred to.
            --
            -- The `substr(col, -1) <> 'Z'` guard makes this idempotent: a row
            -- already carrying the marker is left untouched, so re-running
            -- the migration (or opening a migrated database) is a no-op.
            -- `length(col) = 19` matches the exact legacy shape, so a value
            -- that is not a plain `YYYY-MM-DD HH:MM:SS` is left alone rather
            -- than mangled.

            -- Business days.
            UPDATE business_days SET opened_at = opened_at || 'Z'
                WHERE opened_at IS NOT NULL AND length(opened_at) = 19 AND substr(opened_at, -1) <> 'Z';
            UPDATE business_days SET closed_at = closed_at || 'Z'
                WHERE closed_at IS NOT NULL AND length(closed_at) = 19 AND substr(closed_at, -1) <> 'Z';

            -- Shifts.
            UPDATE shifts SET opened_at = opened_at || 'Z'
                WHERE length(opened_at) = 19 AND substr(opened_at, -1) <> 'Z';
            UPDATE shifts SET closed_at = closed_at || 'Z'
                WHERE closed_at IS NOT NULL AND length(closed_at) = 19 AND substr(closed_at, -1) <> 'Z';

            -- Orders and table sessions.
            UPDATE orders SET opened_at = opened_at || 'Z'
                WHERE opened_at IS NOT NULL AND length(opened_at) = 19 AND substr(opened_at, -1) <> 'Z';
            UPDATE orders SET ready_at = ready_at || 'Z'
                WHERE ready_at IS NOT NULL AND length(ready_at) = 19 AND substr(ready_at, -1) <> 'Z';
            UPDATE orders SET closed_at = closed_at || 'Z'
                WHERE closed_at IS NOT NULL AND length(closed_at) = 19 AND substr(closed_at, -1) <> 'Z';
            UPDATE table_sessions SET opened_at = opened_at || 'Z'
                WHERE opened_at IS NOT NULL AND length(opened_at) = 19 AND substr(opened_at, -1) <> 'Z';
            UPDATE table_sessions SET closed_at = closed_at || 'Z'
                WHERE closed_at IS NOT NULL AND length(closed_at) = 19 AND substr(closed_at, -1) <> 'Z';

            -- Sales documents.
            UPDATE invoices SET created_at = created_at || 'Z'
                WHERE length(created_at) = 19 AND substr(created_at, -1) <> 'Z';
            UPDATE invoices SET paid_at = paid_at || 'Z'
                WHERE paid_at IS NOT NULL AND length(paid_at) = 19 AND substr(paid_at, -1) <> 'Z';
            UPDATE invoices SET cancelled_at = cancelled_at || 'Z'
                WHERE cancelled_at IS NOT NULL AND length(cancelled_at) = 19 AND substr(cancelled_at, -1) <> 'Z';
            UPDATE payments SET created_at = created_at || 'Z'
                WHERE length(created_at) = 19 AND substr(created_at, -1) <> 'Z';

            -- Wash tickets and day closing snapshots.
            UPDATE wash_tickets SET issued_at = issued_at || 'Z'
                WHERE length(issued_at) = 19 AND substr(issued_at, -1) <> 'Z';
            UPDATE day_closings SET closed_at = closed_at || 'Z'
                WHERE length(closed_at) = 19 AND substr(closed_at, -1) <> 'Z';

            -- Master data and ledgers.
            UPDATE users SET created_at = created_at || 'Z'
                WHERE length(created_at) = 19 AND substr(created_at, -1) <> 'Z';
            UPDATE users SET updated_at = updated_at || 'Z'
                WHERE length(updated_at) = 19 AND substr(updated_at, -1) <> 'Z';
            UPDATE products SET created_at = created_at || 'Z'
                WHERE length(created_at) = 19 AND substr(created_at, -1) <> 'Z';
            UPDATE products SET updated_at = updated_at || 'Z'
                WHERE length(updated_at) = 19 AND substr(updated_at, -1) <> 'Z';
            UPDATE customers SET created_at = created_at || 'Z'
                WHERE length(created_at) = 19 AND substr(created_at, -1) <> 'Z';
            UPDATE customers SET updated_at = updated_at || 'Z'
                WHERE length(updated_at) = 19 AND substr(updated_at, -1) <> 'Z';
            UPDATE cars SET created_at = created_at || 'Z'
                WHERE length(created_at) = 19 AND substr(created_at, -1) <> 'Z';
            UPDATE cars SET updated_at = updated_at || 'Z'
                WHERE length(updated_at) = 19 AND substr(updated_at, -1) <> 'Z';
            UPDATE categories SET created_at = created_at || 'Z'
                WHERE length(created_at) = 19 AND substr(created_at, -1) <> 'Z';
            UPDATE categories SET updated_at = updated_at || 'Z'
                WHERE length(updated_at) = 19 AND substr(updated_at, -1) <> 'Z';
            UPDATE order_lines SET created_at = created_at || 'Z'
                WHERE length(created_at) = 19 AND substr(created_at, -1) <> 'Z';
            UPDATE stock_movements SET created_at = created_at || 'Z'
                WHERE length(created_at) = 19 AND substr(created_at, -1) <> 'Z';
            UPDATE inventory_items SET updated_at = updated_at || 'Z'
                WHERE length(updated_at) = 19 AND substr(updated_at, -1) <> 'Z';
            UPDATE credit_accounts SET created_at = created_at || 'Z'
                WHERE length(created_at) = 19 AND substr(created_at, -1) <> 'Z';
            UPDATE credit_accounts SET updated_at = updated_at || 'Z'
                WHERE length(updated_at) = 19 AND substr(updated_at, -1) <> 'Z';
            UPDATE credit_payments SET created_at = created_at || 'Z'
                WHERE length(created_at) = 19 AND substr(created_at, -1) <> 'Z';
            UPDATE expenses SET created_at = created_at || 'Z'
                WHERE length(created_at) = 19 AND substr(created_at, -1) <> 'Z';
            UPDATE print_jobs SET created_at = created_at || 'Z'
                WHERE length(created_at) = 19 AND substr(created_at, -1) <> 'Z';
            UPDATE audit_log SET created_at = created_at || 'Z'
                WHERE length(created_at) = 19 AND substr(created_at, -1) <> 'Z';
            UPDATE app_settings SET updated_at = updated_at || 'Z'
                WHERE length(updated_at) = 19 AND substr(updated_at, -1) <> 'Z';

            -- Sessions. Expiry was written by `datetime('now', '+N hours')`,
            -- which is still a UTC instant, so the same marker applies.
            UPDATE sessions SET created_at = created_at || 'Z'
                WHERE length(created_at) = 19 AND substr(created_at, -1) <> 'Z';
            UPDATE sessions SET expires_at = expires_at || 'Z'
                WHERE length(expires_at) = 19 AND substr(expires_at, -1) <> 'Z';
            UPDATE sessions SET revoked_at = revoked_at || 'Z'
                WHERE revoked_at IS NOT NULL AND length(revoked_at) = 19 AND substr(revoked_at, -1) <> 'Z';
        "#,
    },
    Migration {
        version: 20,
        name: "admin discount options and normalized identity keys",
        needs_fk_off: false,
        sql: r#"
            -- Discount options are ADMIN configuration, exactly like service
            -- charge amounts: the POS may only ever select from this list and
            -- can never invent a value of its own.
            INSERT INTO app_settings (key, value) VALUES
              ('discount_options', '{"amounts":[2000,5000,10000]}')
            ON CONFLICT(key) DO NOTHING;

            -- Normalized comparison keys for duplicate prevention. The keys are
            -- backfilled by `normalize_identity_keys` right after the
            -- migrations run, and the unique indexes are created there too:
            -- a legacy database may already hold two spellings of one phone
            -- number, and the backfill resolves that WITHOUT deleting a row.
            ALTER TABLE customers ADD COLUMN phone_key TEXT;
            ALTER TABLE cars ADD COLUMN plate_key TEXT;
        "#,
    },
    Migration {
        version: 21,
        name: "starter service charge options",
        needs_fk_off: false,
        sql: r#"
            -- The Station starter service-charge options (10 / 30 / 50 / 70 / 100
            -- EGP), in piastres.
            --
            -- Idempotent AND configuration-preserving: the list is written only
            -- when nothing is configured yet, so a database where an admin has
            -- already chosen their own amounts (or deliberately cleared them)
            -- keeps that decision. Re-running this migration is a no-op.
            UPDATE app_settings
            SET value = '{"amounts":[1000,3000,5000,7000,10000]}',
                updated_at = station_now()
            WHERE key = 'service_charge'
              AND (
                NOT json_valid(value)
                OR json_type(value, '$.amounts') IS NULL
                OR json_type(value, '$.amounts') <> 'array'
                OR json_array_length(value, '$.amounts') = 0
              );
        "#,
    },
    Migration {
        version: 22,
        name: "per-cashier discount authorization credential",
        needs_fk_off: false,
        sql: r#"
            -- Discount authorization is a CASHIER-SPECIFIC credential, stored
            -- exactly like every other Station credential: an Argon2id PHC
            -- string in the user row, never plaintext, never exposed by a
            -- user API, never in an invoice.
            --
            -- NULL means "this cashier has no discount credential yet" — a
            -- safe, non-breaking default: such a cashier simply cannot apply a
            -- discount until an ADMIN/MANAGER configures one.
            ALTER TABLE users ADD COLUMN discount_password_hash TEXT;

            -- Upgrade path for installations that already ran the previous
            -- GLOBAL discount password: every existing account inherits that
            -- exact credential, so no cashier loses the ability to authorize a
            -- discount and no staff account is invalidated by the upgrade.
            -- The stored value is a JSON string, hence json_extract.
            UPDATE users
            SET discount_password_hash = (
                SELECT json_extract(app_settings.value, '$')
                FROM app_settings
                WHERE app_settings.key = 'discount_authorization_hash'
                  AND json_valid(app_settings.value)
            )
            WHERE discount_password_hash IS NULL
              AND EXISTS (
                SELECT 1 FROM app_settings
                WHERE key = 'discount_authorization_hash'
                  AND json_valid(value)
                  AND json_type(value) = 'text'
              );

            -- The global password is retired: a single shared secret is
            -- exactly what per-cashier authorization replaces.
            DELETE FROM app_settings WHERE key = 'discount_authorization_hash';
        "#,
    },
];

/// Populate `customers.phone_key` / `cars.plate_key` from the stored values and
/// create the unique indexes that make duplicate prevention a DATABASE rule,
/// not a UI convention.
///
/// Fully non-destructive: no customer or vehicle row is ever deleted or
/// merged. When a legacy database already contains two rows that normalize to
/// the same identity (e.g. "01001234567" and "0100 123 4567"), the lowest id
/// keeps the key — it is the one new inserts will be compared against — and
/// the other rows keep their data with a NULL key. Idempotent by construction.
fn normalize_identity_keys(conn: &Db) -> AppResult<()> {
    let customers_rows: Vec<(i64, Option<String>, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT id, phone, phone_key FROM customers")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (id, phone, current) in customers_rows {
        if current.is_some() {
            continue;
        }
        if let Some(key) = crate::normalize::normalize_phone(phone.as_deref().unwrap_or("")) {
            let taken: i64 = conn.query_row(
                "SELECT COUNT(*) FROM customers WHERE phone_key = ?1 AND id <> ?2",
                rusqlite::params![key, id],
                |r| r.get(0),
            )?;
            if taken == 0 {
                conn.execute(
                    "UPDATE customers SET phone_key = ?2 WHERE id = ?1",
                    rusqlite::params![id, key],
                )?;
            }
        }
    }

    let cars_rows: Vec<(i64, String, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT id, plate_no, plate_key FROM cars")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (id, plate, current) in cars_rows {
        if current.is_some() {
            continue;
        }
        if let Some(key) = crate::normalize::normalize_plate(&plate) {
            let taken: i64 = conn.query_row(
                "SELECT COUNT(*) FROM cars WHERE plate_key = ?1 AND id <> ?2",
                rusqlite::params![key, id],
                |r| r.get(0),
            )?;
            if taken == 0 {
                conn.execute(
                    "UPDATE cars SET plate_key = ?2 WHERE id = ?1",
                    rusqlite::params![id, key],
                )?;
            }
        }
    }

    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone_key
            ON customers(phone_key) WHERE phone_key IS NOT NULL;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_cars_plate_key ON cars(plate_key);",
    )?;
    Ok(())
}

pub fn migration_count() -> i64 {
    MIGRATIONS.len() as i64
}

pub fn migrate(conn: &Db) -> AppResult<()> {
    // Tests open bare in-memory connections, so the clock is registered here
    // too: every connection that migrates gets the same canonical time source.
    register_clock(conn)?;
    apply_migrations(conn, None)?;
    normalize_identity_keys(conn)
}

/// Apply embedded migrations in version order. `up_to` is used by tests to
/// build a pre-upgrade database and verify the data-preserving path.
fn apply_migrations(conn: &Db, up_to: Option<i64>) -> AppResult<()> {
    // Registered here (not only in `migrate`) so every entry point — including
    // the tests that migrate to a specific version — has the canonical clock
    // available for the column defaults that depend on it.
    register_clock(conn)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
            version     INTEGER PRIMARY KEY,
            name        TEXT NOT NULL,
            applied_at  TEXT NOT NULL DEFAULT (station_now())
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

    /// The per-cashier discount credential must arrive without breaking an
    /// installation that already used the previous GLOBAL discount password:
    /// every existing account inherits that credential, and the global secret
    /// itself is retired.
    #[test]
    fn discount_authorization_migration_preserves_existing_installations() {
        let conn = memory_db();
        apply_migrations(&conn, Some(21)).unwrap();
        // A pre-upgrade database: two staff accounts and one configured global
        // discount password (stored as a JSON string, like every setting).
        conn.execute_batch(
            "INSERT INTO users (name, role, password_hash) VALUES
                ('legacy-cashier', 'STAFF', 'x'),
                ('legacy-manager', 'MANAGER', 'x');",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('discount_authorization_hash', ?1)",
            [r#""$argon2id$v=19$legacy$hash""#],
        )
        .unwrap();

        migrate(&conn).unwrap();

        // Both accounts keep working: they own the previous credential.
        let migrated: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM users
                 WHERE discount_password_hash = '$argon2id$v=19$legacy$hash'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(migrated, 2);
        // And the shared global secret is gone, so it can never be reused.
        let global_left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = 'discount_authorization_hash'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(global_left, 0);
        // The new column is nullable: an account nobody configured is a valid,
        // non-breaking state (it simply cannot authorize a discount yet).
        let notnull: i64 = conn
            .query_row(
                "SELECT \"notnull\" FROM pragma_table_info('users') WHERE name = 'discount_password_hash'",
                [],
                |r| r.get(0),
            )
            .expect("the credential column exists after the migration");
        assert_eq!(notnull, 0, "the column must stay nullable");
    }

    /// A fresh database needs no global password at all: the column simply
    /// starts empty and every seeded account stays usable.
    #[test]
    fn discount_authorization_migration_is_safe_on_a_fresh_database() {
        let conn = memory_db();
        migrate(&conn).unwrap();
        crate::seed::run_if_empty(&conn).unwrap();

        let users: i64 = conn
            .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
            .unwrap();
        let without: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM users WHERE discount_password_hash IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // No account is invalidated by the upgrade; nobody is forced to have a
        // credential before an ADMIN/MANAGER configures one.
        assert_eq!(users, without);
        let global_left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = 'discount_authorization_hash'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(global_left, 0);
    }
    #[test]
    fn settings_migration_normalizes_observed_legacy_json() {
        let conn = memory_db();
        apply_migrations(&conn, Some(15)).unwrap();
        conn.execute_batch(
            "UPDATE app_settings SET value = '{\"mode\":\"\\\"NONE\\\"\",\"value\":\"0\"}'
               WHERE key = 'service_charge';
             UPDATE app_settings SET value =
               '{\"enabled\":true,\"mode\":\"\\\"LIST\\\"\",\"allowed_customer_ids\":\"[]\"}'
               WHERE key = 'credit';",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let service: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'service_charge'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // The legacy `{mode, value}` JSON is gone, and the shape it became is
        // the readable one the POS deserializes — seeded with the starter
        // options rather than left as the unparseable bare `[]` array.
        let config: crate::services::settings::ServiceChargeConfig =
            serde_json::from_str(&service).expect("service charge is a readable config object");
        assert_eq!(config.amounts, vec![1_000, 3_000, 5_000, 7_000, 10_000]);
        assert!(
            !service.contains("mode"),
            "the legacy mode/value shape is replaced"
        );
        let old_limit: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = 'discount_limit'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old_limit, 0);

        let credit: (String, String, String) = conn
            .query_row(
                "SELECT value,
                        json_type(value, '$.mode'),
                        json_type(value, '$.allowed_customer_ids')
                 FROM app_settings WHERE key = 'credit'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            credit,
            (
                "{\"enabled\":true,\"mode\":\"LIST\",\"allowed_customer_ids\":[]}".into(),
                "text".into(),
                "array".into()
            )
        );

        // The migration is idempotent and does not touch business tables.
        migrate(&conn).unwrap();
        let same: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'credit'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(same, credit.0);
    }

    /// Every timestamp column carries an explicit UTC marker after migration 19.
    #[test]
    fn explicit_utc_migration_marks_every_timestamp() {
        let conn = memory_db();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO users (name, role, password_hash) VALUES ('a', 'ADMIN', 'x')",
            [],
        )
        .unwrap();
        // Force a legacy-shaped value and re-run only migration 19's SQL.
        conn.execute(
            "UPDATE users SET created_at = '2026-09-25 14:30:00' WHERE name = 'a'",
            [],
        )
        .unwrap();

        let sql = MIGRATIONS
            .iter()
            .find(|m| m.version == 19)
            .expect("migration 19 exists")
            .sql;
        conn.execute_batch(sql).unwrap();

        let stored: String = conn
            .query_row(
                "SELECT created_at FROM users WHERE name = 'a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // The same instant, now explicitly UTC.
        assert_eq!(stored, "2026-09-25 14:30:00Z");
        // And it still parses back to the identical instant.
        assert_eq!(
            crate::time::parse_timestamp(&stored).unwrap(),
            crate::time::parse_timestamp("2026-09-25 14:30:00").unwrap()
        );
    }

    /// Re-running the timestamp migration must not append a second `Z`.
    #[test]
    fn explicit_utc_migration_is_idempotent() {
        let conn = memory_db();
        migrate(&conn).unwrap();
        let sql = MIGRATIONS
            .iter()
            .find(|m| m.version == 19)
            .expect("migration 19 exists")
            .sql;
        conn.execute_batch(sql).unwrap();
        let once: String = conn
            .query_row(
                "SELECT updated_at FROM app_settings WHERE key = 'service_charge'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute_batch(sql).unwrap();
        let twice: String = conn
            .query_row(
                "SELECT updated_at FROM app_settings WHERE key = 'service_charge'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(once, twice, "a second run must be a no-op");
        assert!(!twice.ends_with("ZZ"));
    }

    /// A fresh database is seeded with the five starter service-charge options.
    #[test]
    fn starter_service_charge_options_are_seeded() {
        let conn = memory_db();
        migrate(&conn).unwrap();

        let raw: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'service_charge'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let config: crate::services::settings::ServiceChargeConfig =
            serde_json::from_str(&raw).expect("service charge config parses");
        assert_eq!(config.amounts, vec![1_000, 3_000, 5_000, 7_000, 10_000]);
    }

    /// The seed must never overwrite an amount list an admin already chose, and
    /// re-running it must not change anything.
    #[test]
    fn starter_service_charge_seed_is_idempotent_and_preserves_configuration() {
        let conn = memory_db();
        migrate(&conn).unwrap();

        let sql = MIGRATIONS
            .iter()
            .find(|m| m.version == 21)
            .expect("migration 21 exists")
            .sql;

        // An admin's own configuration survives the seed.
        conn.execute(
            "UPDATE app_settings SET value = '{\"amounts\":[2500]}' WHERE key = 'service_charge'",
            [],
        )
        .unwrap();
        conn.execute_batch(sql).unwrap();
        let configured: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'service_charge'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(configured, "{\"amounts\":[2500]}");

        // Re-running the seed on the already-seeded database is a no-op.
        let seeded: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'service_charge'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute_batch(sql).unwrap();
        let again: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'service_charge'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(seeded, again);
    }

    /// Business dates are pure calendar days and must never gain a `Z`.
    #[test]
    fn business_dates_are_never_rewritten_as_instants() {
        let conn = memory_db();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO business_days (day_date, opened_at) VALUES ('2026-09-25', '2026-09-25 09:00:00')",
            [],
        )
        .unwrap();
        let sql = MIGRATIONS
            .iter()
            .find(|m| m.version == 19)
            .expect("migration 19 exists")
            .sql;
        conn.execute_batch(sql).unwrap();
        let (day_date, opened_at): (String, String) = conn
            .query_row(
                "SELECT day_date, opened_at FROM business_days WHERE day_date = '2026-09-25'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        // The calendar day is untouched; only the instant is marked.
        assert_eq!(day_date, "2026-09-25");
        assert_eq!(opened_at, "2026-09-25 09:00:00Z");
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

    #[test]
    fn catalog_migration_backfills_category_and_syncs_inventory() {
        let conn = memory_db();
        apply_migrations(&conn, Some(13)).unwrap();

        conn.execute_batch(
            "INSERT INTO products (name, item_type, department, price_minor, track_inventory)
                 VALUES ('stocked', 'PRODUCT', 'CAFE', 1000, 1);
             INSERT INTO products (name, item_type, department, price_minor, track_inventory)
                 VALUES ('plain', 'PRODUCT', 'CAFE', 1000, 0);
             INSERT INTO inventory_items (product_id, quantity, min_quantity)
                 VALUES (2, 5, 1);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let system: (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(is_system), 0)
                 FROM categories WHERE name = 'عام'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(system, (1, 1));

        let system_id: i64 = conn
            .query_row(
                "SELECT id FROM categories WHERE is_system = 1 ORDER BY id LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let missing_categories: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM products WHERE category_id != ?1",
                [system_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(missing_categories, 0);

        let stocked: (i64, i64) = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM inventory_items WHERE product_id = 1),
                        (SELECT quantity FROM inventory_items WHERE product_id = 2)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(stocked, (1, 5));

        // Required category is now enforced by the rebuilt table.
        assert!(conn
            .execute(
                "INSERT INTO products (name, item_type, department, price_minor)
                 VALUES ('missing-category', 'PRODUCT', 'CAFE', 1)",
                [],
            )
            .is_err());
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
