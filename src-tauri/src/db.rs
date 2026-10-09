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
    conn.create_scalar_function("station_now", 0, FunctionFlags::SQLITE_UTF8, |_ctx| {
        Ok(crate::time::now_db_timestamp())
    })?;
    conn.create_scalar_function("station_today", 0, FunctionFlags::SQLITE_UTF8, |_ctx| {
        Ok(crate::time::today_business_date())
    })?;
    register_business_date(conn)?;
    Ok(())
}

/// Register `station_business_date(x)` alongside the clock.
///
/// `x` is any timestamp this application writes (the explicit `...Z` form) or
/// any legacy form it still reads; the result is that instant's calendar day in
/// Station's business timezone.
///
/// This exists as a SQL function because SQLite's own `date(x, 'Africa/Cairo')`
/// silently yields NULL on a build without IANA zone data, and because a daily
/// report must agree with `crate::time::business_date_of` to the letter. Deriving
/// the day in Rust keeps ONE definition — `BUSINESS_TZ` — behind every caller,
/// with no hardcoded `+03:00` and no dependence on the host's tzdata.
fn register_business_date(conn: &Db) -> AppResult<()> {
    conn.create_scalar_function(
        "station_business_date",
        1,
        FunctionFlags::SQLITE_UTF8,
        |ctx| {
            // A NULL or non-text argument yields NULL rather than a guessed day.
            Ok(ctx
                .get_raw(0)
                .as_str()
                .ok()
                .and_then(crate::time::parse_timestamp)
                // An unparseable value is not a date we may invent. Yielding NULL
                // excludes the row from any day-scoped count instead of filing it
                // under a guess.
                .map(crate::time::business_date_of))
        },
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
    Migration {
        version: 23,
        name: "restore the global shared discount pin",
        needs_fk_off: false,
        sql: r#"
            -- Corrective migration. Discount authorization is ONE global shared
            -- PIN for the cafe, stored in app_settings like every other Station
            -- setting. It is NOT owned by a cashier and never was: there is no
            -- per-user credential anywhere in the model.
            --
            -- Step 1 — do not lose the shared credential. Migration 22 copied the
            -- previous global hash into EVERY user row, so the oldest non-null
            -- value is still that one shared Argon2id hash. Restore it to
            -- app_settings before removing the per-user column. Only inserted
            -- when no global credential exists yet (never overwrite a PIN that
            -- was configured after the upgrade).
            INSERT INTO app_settings (key, value, updated_at)
            SELECT 'discount_authorization_hash',
                   json_quote(discount_password_hash),
                   station_now()
            FROM users
            WHERE discount_password_hash IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM app_settings WHERE key = 'discount_authorization_hash'
              )
            ORDER BY id
            LIMIT 1;

            -- Step 2 — remove the misleading per-cashier credential column. The
            -- authoritative shared PIN now lives in app_settings only.
            ALTER TABLE users DROP COLUMN discount_password_hash;
        "#,
    },
    Migration {
        version: 24,
        name: "catalog is_new flag",
        needs_fk_off: false,
        sql: r#"
            -- "New item" is a PRESENTATION promise about the catalog entry
            -- (a recent addition a cashier should notice), and it is entirely
            -- separate from `is_active` (operational availability). Overloading
            -- availability for it would make a disabled-but-new item
            -- indistinguishable from a plain disabled one.
            --
            -- Fully additive and backward compatible: SQLite gives every
            -- EXISTING product the safe default 0 (not new), so no historical
            -- product is suddenly badged, and the CHECK keeps the value a
            -- domain boolean exactly like `is_active`.
            ALTER TABLE products ADD COLUMN is_new INTEGER NOT NULL DEFAULT 0
                CHECK (is_new IN (0, 1));
        "#,
    },
    Migration {
        version: 25,
        name: "shift-scoped cash expenses and closing reconciliation snapshot",
        needs_fk_off: true,
        sql: r#"
            -- ===================================================================
            -- CASHIER EXPENSES BECOME A SHIFT-LEVEL CONCEPT
            -- ===================================================================
            -- Expenses used to be day-level only, which made two things wrong:
            -- a cashier could not book a spend against the drawer they were
            -- responsible for, and shift closing could not deduct it from the
            -- expected cash (`expected_cash` was `opening + cash_sales` only).
            --
            -- `shift_id` attributes an expense to the shift that was open when
            -- it was recorded, so the drawer reconciliation can be exact. It is
            -- NULLABLE: a manager may still record a general day-level expense
            -- (rent, a supplier bill) that belongs to no single till.

            -- Reusable expense categories. Station already had six hardcoded
            -- enum values duplicated in Rust and in the UI; a real table makes
            -- the breakdown data-driven and lets the Arabic label live with the
            -- category instead of being hardcoded in a component.
            CREATE TABLE expense_categories (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                code       TEXT NOT NULL UNIQUE
                           CHECK (code = trim(code) AND length(code) > 0),
                name_ar    TEXT NOT NULL CHECK (name_ar = trim(name_ar) AND length(name_ar) > 0),
                is_system  INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
                is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
                created_at TEXT NOT NULL DEFAULT (station_now())
            );

            -- Seeded from the EXACT enum the old CHECK enforced, so every
            -- historical expense keeps a valid category with no data rewrite.
            -- The Arabic labels are the domain names Station already used.
            INSERT INTO expense_categories (code, name_ar, is_system) VALUES
                ('MAINTENANCE', 'صيانة', 1),
                ('SUPPLIES',    'مشتريات', 1),
                ('UTILITY',     'كهرباء ومياه', 1),
                ('SALARY',      'رواتب', 1),
                ('EMERGENCY',   'طارئ', 1),
                ('OTHER',       'أخرى', 1);

            -- Rebuild `expenses`: the old CHECK limited `category` to a closed
            -- enum, so it is now a plain FK-backed key into expense_categories
            -- instead. `paid_from_cash` states whether the spend physically left
            -- the drawer; only a CASH expense may reduce expected cash (a card
            -- or credit expense never touched the till).
            CREATE TABLE expenses_new (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                category        TEXT NOT NULL
                                REFERENCES expense_categories(code),
                amount          INTEGER NOT NULL CHECK (amount > 0),
                description     TEXT,
                expense_date    TEXT NOT NULL,
                is_recurring    INTEGER NOT NULL DEFAULT 0 CHECK (is_recurring IN (0,1)),
                recurrence      TEXT CHECK (recurrence IN ('WEEKLY','MONTHLY') OR is_recurring = 0),
                business_day_id INTEGER REFERENCES business_days(id),
                shift_id        INTEGER REFERENCES shifts(id),
                paid_from_cash  INTEGER NOT NULL DEFAULT 1 CHECK (paid_from_cash IN (0,1)),
                user_id         INTEGER NOT NULL REFERENCES users(id),
                is_seed         INTEGER NOT NULL DEFAULT 0,
                created_at      TEXT NOT NULL DEFAULT (station_now())
            );
            INSERT INTO expenses_new
                (id, category, amount, description, expense_date, is_recurring,
                 recurrence, business_day_id, shift_id, paid_from_cash, user_id,
                 is_seed, created_at)
            SELECT id, category, amount, description, expense_date, is_recurring,
                 recurrence, business_day_id, NULL, 1, user_id, is_seed, created_at
            FROM expenses;
            DROP TABLE expenses;
            ALTER TABLE expenses_new RENAME TO expenses;
            CREATE INDEX idx_expenses_date ON expenses(expense_date);
            CREATE INDEX idx_expenses_shift ON expenses(shift_id);
            CREATE INDEX idx_expenses_day ON expenses(business_day_id);

            -- ===================================================================
            -- CLOSING SNAPSHOT — the immutable reconciliation record
            -- ===================================================================
            -- The aggregate columns on `shifts` are the CLOSING SNAPSHOT: they
            -- are written exactly once, at close, and every historical shift
            -- report is reproduced from them. They are therefore extended, not
            -- recomputed, so a closed shift's figures can never move afterwards.
            --
            -- `cafe_invoices` / `wash_invoices` count invoices by the business
            -- area they actually contain and `hybrid_invoices` counts the ones
            -- containing BOTH, so the three are mutually exclusive and
            -- `cafe + wash + hybrid = invoices_count` always holds. A hybrid
            -- invoice's money still lands in BOTH `cafe_sales` and
            -- `wash_sales`, because those are per-department line sums; only
            -- the COUNT is exclusive, so the counts never double a document.
            ALTER TABLE shifts ADD COLUMN cafe_invoices   INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE shifts ADD COLUMN wash_invoices   INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE shifts ADD COLUMN hybrid_invoices INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE shifts ADD COLUMN total_sales     INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE shifts ADD COLUMN subtotal        INTEGER NOT NULL DEFAULT 0;
            -- Money of the cafe lines and of the wash lines. A hybrid invoice
            -- contributes to BOTH, because these are sums of per-department line
            -- totals, not counts. Only the invoice COUNTS above are exclusive.
            ALTER TABLE shifts ADD COLUMN cafe_sales      INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE shifts ADD COLUMN wash_sales      INTEGER NOT NULL DEFAULT 0;
            -- Cash that physically left this shift's drawer.
            ALTER TABLE shifts ADD COLUMN cash_expenses   INTEGER NOT NULL DEFAULT 0;
            -- Every expense booked to this shift, whatever the payment source.
            ALTER TABLE shifts ADD COLUMN expenses        INTEGER NOT NULL DEFAULT 0;

            -- The same snapshot columns on the immutable day closing, so a
            -- closed business day reports exactly what its settled shifts
            -- contributed and is never recalculated from live rows.
            ALTER TABLE day_closings ADD COLUMN cafe_invoices   INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE day_closings ADD COLUMN wash_invoices   INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE day_closings ADD COLUMN hybrid_invoices INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE day_closings ADD COLUMN shift_count     INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE day_closings ADD COLUMN opening_cash    INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE day_closings ADD COLUMN cash_expenses   INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE day_closings ADD COLUMN expected_cash   INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE day_closings ADD COLUMN actual_cash     INTEGER NOT NULL DEFAULT 0;
            -- Shortage and surplus are stored as NON-NEGATIVE magnitudes on
            -- opposite sides, so a settled day can never be both, and the
            -- signed `difference` is always `actual - expected`.
            ALTER TABLE day_closings ADD COLUMN shortage        INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE day_closings ADD COLUMN surplus         INTEGER NOT NULL DEFAULT 0;
        "#,
    },
    Migration {
        version: 26,
        name: "immutable closing expense breakdown snapshot",
        needs_fk_off: false,
        sql: r#"
            -- The per-category expense breakdown is part of the CLOSING DOCUMENT,
            -- so it belongs to the closing snapshot exactly like the totals do.
            -- It used to be rebuilt with a live query every time a closed shift or
            -- a closed day was reported, which meant the printed total and the
            -- printed breakdown could come from two different moments in time.
            --
            -- The column stores the resolved rows (code, Arabic label, count,
            -- amount) as JSON, so a historical document keeps the category names
            -- that were true at closing time even if a category is later renamed
            -- or deactivated. A closing written before this migration has `'[]'`,
            -- and `BreakdownRow` decoding treats that as "no expenses", which is
            -- exactly what such a closing recorded.
            ALTER TABLE shifts       ADD COLUMN expense_breakdown TEXT NOT NULL DEFAULT '[]';
            ALTER TABLE day_closings ADD COLUMN expense_breakdown TEXT NOT NULL DEFAULT '[]';
        "#,
    },
    Migration {
        version: 27,
        name: "catalog soft delete archive marker",
        needs_fk_off: false,
        sql: r#"
            -- Deleting a catalog row must NEVER destroy or orphan history.
            --
            -- `order_lines.product_id`, `inventory_items.product_id` and
            -- `stock_movements.product_id` are live foreign keys, and every
            -- order/invoice line is an immutable SNAPSHOT (product_name,
            -- unit_price, department frozen at the moment of sale). Deleting
            -- the row would therefore break referential integrity for no
            -- benefit, because history never reads the name or price back
            -- from `products`.
            --
            -- `deleted_at` is the archive marker for an ADMIN-only delete. It is
            -- deliberately SEPARATE from `is_active`, which is a reversible
            -- operational switch a MANAGER may flip back: a deleted item must
            -- never be reachable by "Activate" again, so the two states cannot
            -- share one flag.
            --
            -- Fully additive and backward compatible: existing rows get NULL
            -- (i.e. never deleted), so no installation changes behaviour on
            -- upgrade and no historical row is touched.
            ALTER TABLE products ADD COLUMN deleted_at TEXT;
            CREATE INDEX IF NOT EXISTS idx_products_deleted_at ON products(deleted_at);
        "#,
    },
    Migration {
        version: 28,
        name: "employees",
        needs_fk_off: false,
        sql: r#"
            -- ============================================================
            -- EMPLOYEES — the HR record, deliberately NOT the login
            -- ============================================================
            -- Station's `users` table is an AUTHENTICATION record: it carries a
            -- mandatory Argon2 hash and every row can open a session and open a
            -- shift. A wash worker must do none of those things, yet is still an
            -- employee with attendance, a salary and performance. So the two are
            -- kept apart and linked:
            --
            --   employees  — the person as the business knows them.
            --   users      — the login, present only for a CASHIER.
            --
            -- The three concepts the spec insists on separating are therefore
            -- physically separated here:
            --   * employee type   -> `employees.employee_type`
            --   * auth role       -> `users.role` (ADMIN / MANAGER / STAFF)
            --   * authorization   -> the service layer, never a column
            --
            -- The CHECK makes the linkage itself a database rule: a CASHIER
            -- always has a login, a WASH_WORKER never can have one, so a wash
            -- worker cannot become an authenticating user by any code path.
            CREATE TABLE IF NOT EXISTS employees (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id       INTEGER REFERENCES users(id),
                name          TEXT NOT NULL,
                phone         TEXT,
                employee_type TEXT NOT NULL
                                CHECK (employee_type IN ('CASHIER','WASH_WORKER')),
                status        TEXT NOT NULL DEFAULT 'ACTIVE'
                                CHECK (status IN ('ACTIVE','INACTIVE')),
                -- Money is ALWAYS minor units (piasters), exactly like every
                -- other monetary column in Station. No floats, ever.
                base_salary   INTEGER NOT NULL DEFAULT 0 CHECK (base_salary >= 0),
                notes         TEXT,
                created_at    TEXT NOT NULL DEFAULT (station_now()),
                updated_at    TEXT NOT NULL DEFAULT (station_now()),
                CHECK (
                    (employee_type = 'CASHIER'     AND user_id IS NOT NULL)
                 OR (employee_type = 'WASH_WORKER' AND user_id IS NULL)
                )
            );
            -- One employee per login: the same account can never be two people.
            CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_user
                ON employees(user_id) WHERE user_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_employees_type_status
                ON employees(employee_type, status);
            CREATE INDEX IF NOT EXISTS idx_employees_name ON employees(name);

            -- Every existing login IS a cashier: Station had a single employee
            -- concept until this migration, and the authenticated `users` rows
            -- are exactly the people who work the till. Backfilling them keeps
            -- the historical link (shifts.user_id, invoices.user_id) reachable
            -- from the employee record without rewriting a single existing row
            -- of transactional history. A SUSPENDED login becomes an INACTIVE
            -- employee — the two words describe the same operational reality.
            INSERT INTO employees (user_id, name, phone, employee_type, status,
                                   base_salary, created_at, updated_at)
            SELECT id, name, phone, 'CASHIER',
                   CASE WHEN status = 'ACTIVE' THEN 'ACTIVE' ELSE 'INACTIVE' END,
                   0, created_at, updated_at
            FROM users;
        "#,
    },
    Migration {
        version: 29,
        name: "attendance days",
        needs_fk_off: false,
        sql: r#"
            -- ============================================================
            -- ATTENDANCE — one immutable row per employee per business day
            -- ============================================================
            -- Attendance is a DAY record, not two nullable columns on the
            -- employee: it has to answer "was this person here at all?", it has
            -- to distinguish an EXPLICIT absence from a day nobody wrote down,
            -- and it has to keep the person who pressed the button.
            --
            -- actual vs effective
            -- ------------------
            -- `*_actual_at` is the untouched instant, preserved for audit
            -- forever. `*_effective_at` is the business-rounded instant every
            -- calculation reads, so 09:13 and 09:14 both count as 09:10 and
            -- 09:16 counts as 09:20. Both are canonical UTC instants, exactly
            -- like every other timestamp in Station.
            --
            -- state
            -- -----
            -- A day is PRESENT (has a check-in), ABSENT, or LEAVE. Absence and
            -- leave are EXPLICIT records: the absence of a row means "nobody
            -- wrote anything down", which is NOT the same fact and is never
            -- inferred as an absence anywhere in this application.
            --
            -- The CHECK constraint makes an impossible state unrepresentable:
            -- you cannot store a PRESENT day without a check-in, an ABSENT or
            -- LEAVE day carrying a punch pair, or a check-out whose effective
            -- timestamp exists without its actual one.
            CREATE TABLE IF NOT EXISTS attendance_days (
                id                     INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_id            INTEGER NOT NULL REFERENCES employees(id),
                business_date          TEXT NOT NULL,   -- YYYY-MM-DD, Africa/Cairo
                state                  TEXT NOT NULL
                                         CHECK (state IN ('PRESENT','ABSENT','LEAVE')),
                check_in_actual_at     TEXT,
                check_in_effective_at  TEXT,
                check_out_actual_at    TEXT,
                check_out_effective_at TEXT,
                -- The shift the recorder was operating, for wash-worker events.
                shift_id               INTEGER REFERENCES shifts(id),
                -- ALWAYS the authenticated session user, resolved server-side.
                -- A wash worker has no login, so without this column "who
                -- recorded Mahmoud's check-in" would be unknowable.
                recorded_by_user_id    INTEGER NOT NULL REFERENCES users(id),
                note                   TEXT,
                -- Corrections never mutate history: the superseded row is
                -- voided (kept forever) and a replacement row is written. The
                -- partial unique index below is what makes "one live record per
                -- employee per day" a DATABASE rule rather than a service
                -- convention, so two writers can never both win.
                voided_at              TEXT,
                voided_by_user_id      INTEGER REFERENCES users(id),
                created_at             TEXT NOT NULL DEFAULT (station_now()),
                updated_at             TEXT NOT NULL DEFAULT (station_now()),
                CHECK (
                    (state = 'PRESENT'
                        AND check_in_actual_at IS NOT NULL
                        AND check_in_effective_at IS NOT NULL
                        AND (check_out_actual_at IS NULL) = (check_out_effective_at IS NULL))
                 OR (state IN ('ABSENT','LEAVE')
                        AND check_in_actual_at IS NULL
                        AND check_in_effective_at IS NULL
                        AND check_out_actual_at IS NULL
                        AND check_out_effective_at IS NULL)
                )
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_live
                ON attendance_days(employee_id, business_date) WHERE voided_at IS NULL;
            -- Range scans for the KPI band and the list aggregate.
            CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_days(business_date);
            CREATE INDEX IF NOT EXISTS idx_attendance_recorder ON attendance_days(recorded_by_user_id);
            CREATE INDEX IF NOT EXISTS idx_attendance_shift ON attendance_days(shift_id);
        "#,
    },
    Migration {
        version: 30,
        name: "employee advances and payroll snapshots",
        needs_fk_off: false,
        sql: r#"
            -- ============================================================
            -- ADVANCES — an append-only money ledger
            -- ============================================================
            -- An advance is money that left the till to the employee, so it is a
            -- financial transaction: never deleted, never edited in place. A
            -- mistake is corrected by REVERSAL — a status transition on the
            -- original row plus the audit trail, which is the same correction
            -- model Station already uses for invoices and closings.
            CREATE TABLE IF NOT EXISTS employee_advances (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_id  INTEGER NOT NULL REFERENCES employees(id),
                amount       INTEGER NOT NULL CHECK (amount > 0),  -- piasters
                advance_date TEXT NOT NULL,                            -- YYYY-MM-DD
                reason       TEXT NOT NULL,
                status       TEXT NOT NULL DEFAULT 'RECORDED'
                               CHECK (status IN ('RECORDED','REVERSED')),
                reverses_id  INTEGER REFERENCES employee_advances(id),
                created_by   INTEGER NOT NULL REFERENCES users(id),
                created_at   TEXT NOT NULL DEFAULT (station_now()),
                reversed_at  TEXT,
                reversed_by  INTEGER REFERENCES users(id),
                CHECK (
                    (status = 'RECORDED' AND reversed_at IS NULL AND reversed_by IS NULL)
                 OR (status = 'REVERSED' AND reversed_at IS NOT NULL
                        AND reversed_by IS NOT NULL AND reverses_id IS NOT NULL)
                )
            );
            CREATE INDEX IF NOT EXISTS idx_advances_employee_date
                ON employee_advances(employee_id, advance_date);

            -- ============================================================
            -- PAYROLL — a monthly SNAPSHOT, never a live query
            -- ============================================================
            -- The point of this table is immutability. Everything a payslip
            -- shows is copied onto the row at the moment the run is created:
            -- the base salary as it was THAT month, the attendance counters,
            -- the advances already given, and the resulting net. Changing the
            -- employee's salary in October cannot move a finalized September
            -- run, because September's row no longer reads `employees`.
            --
            -- `deductions` exists for a manager-entered figure only. Station
            -- has NO documented attendance-based deduction rule, so the service
            -- never derives one — absence and leave are REPORTED, not priced.
            CREATE TABLE IF NOT EXISTS payroll_runs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_id     INTEGER NOT NULL REFERENCES employees(id),
                period          TEXT NOT NULL,        -- 'YYYY-MM'
                base_salary     INTEGER NOT NULL CHECK (base_salary >= 0),
                attendance_days INTEGER NOT NULL DEFAULT 0,
                worked_minutes  INTEGER NOT NULL DEFAULT 0,
                absence_days    INTEGER NOT NULL DEFAULT 0,
                leave_days      INTEGER NOT NULL DEFAULT 0,
                advances        INTEGER NOT NULL DEFAULT 0,
                deductions      INTEGER NOT NULL DEFAULT 0,
                net_salary      INTEGER NOT NULL,
                status          TEXT NOT NULL DEFAULT 'DRAFT'
                                CHECK (status IN ('DRAFT','FINALIZED')),
                created_by      INTEGER NOT NULL REFERENCES users(id),
                created_at      TEXT NOT NULL DEFAULT (station_now()),
                finalized_by    INTEGER REFERENCES users(id),
                finalized_at    TEXT,
                CHECK (
                    (status = 'DRAFT'     AND finalized_at IS NULL)
                 OR (status = 'FINALIZED' AND finalized_at IS NOT NULL
                        AND finalized_by IS NOT NULL)
                )
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_employee_period
                ON payroll_runs(employee_id, period);
        "#,
    },
    Migration {
        version: 31,
        name: "wash invoice employee attribution",
        needs_fk_off: false,
        sql: r#"
            -- ============================================================
            -- WASH-WORKER ATTRIBUTION
            -- ============================================================
            -- Before this migration a wash invoice knew its CASHIER
            -- (`invoices.user_id`) and nothing about who actually washed the
            -- car, because a wash worker has no login to record. Performance
            -- for a wash worker is therefore impossible to derive, and
            -- inventing it in the UI would be a fabrication — so the smallest
            -- clean extension is added here: an explicit, nullable
            -- attribution column.
            --
            -- The order carries the ATTRIBUTION (the cashier picks the worker
            -- while the job is in progress) and the invoice SNAPSHOTS it, which
            -- is the same rule every other invoice field follows: a finalized
            -- document never reads back from a mutable master.
            --
            -- NULL is meaningful and permanent: an invoice raised before this
            -- migration, or one whose worker was never recorded, is simply
            -- unattributed. It is never back-filled with a guess.
            ALTER TABLE orders   ADD COLUMN wash_employee_id INTEGER REFERENCES employees(id);
            ALTER TABLE invoices ADD COLUMN wash_employee_id INTEGER REFERENCES employees(id);
            CREATE INDEX IF NOT EXISTS idx_orders_wash_employee   ON orders(wash_employee_id);
            CREATE INDEX IF NOT EXISTS idx_invoices_wash_employee ON invoices(wash_employee_id);
        "#,
    },
    Migration {
        version: 32,
        name: "invoice cancellation is not a Station business state",
        needs_fk_off: true,
        sql: r#"
            -- ============================================================
            -- INVOICE CANCELLATION IS NOT PART OF THE DOMAIN
            -- ============================================================
            -- Station does not support cancelling an invoice. The status and the
            -- `cancelled_at` stamp existed only to serve a cancellation flow
            -- that the application never exposed, so they are removed here
            -- rather than left behind as a state the app can never reach.
            --
            -- WHY A FORWARD REBUILD AND NOT AN EDIT OF MIGRATION 1:
            -- migration 1 has already been applied to every existing database,
            -- so its CHECK constraint cannot be changed retroactively. SQLite
            -- cannot alter a CHECK in place either, so the documented 12-step
            -- table rebuild is used: the runner executes this migration with
            -- foreign keys off and verifies integrity before committing
            -- (see `apply_migrations`).
            --
            -- DATA SAFETY: every row keeps its `id`, so `invoice_lines`,
            -- `payments`, `invoice_customers`, `wash_tickets` and the credit
            -- ledger keep pointing at the same documents. Had this database
            -- somehow held a `CANCELLED` invoice, the INSERT below would
            -- violate the new CHECK and the whole migration would roll back
            -- and report the error, rather than silently rewriting or
            -- discarding a numbered financial document.
            CREATE TABLE invoices_new (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                invoice_no        INTEGER NOT NULL UNIQUE,
                order_id          INTEGER REFERENCES orders(id),
                table_label       TEXT,
                business_day_id   INTEGER REFERENCES business_days(id),
                shift_id          INTEGER,
                user_id           INTEGER NOT NULL REFERENCES users(id),
                customer_id       INTEGER REFERENCES customers(id),
                -- The real Station invoice lifecycle: raised, then settled in
                -- full, in part, or on the customer's credit account. There is
                -- no fourth outcome.
                status            TEXT NOT NULL DEFAULT 'PENDING_PAYMENT'
                                  CHECK (status IN ('PENDING_PAYMENT','PAID','PARTIALLY_PAID','CREDIT')),
                subtotal          INTEGER NOT NULL CHECK (subtotal >= 0),
                discount_minor    INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
                discount_mode     TEXT CHECK (discount_mode IN ('FIXED','PERCENT')),
                discount_value    INTEGER,
                service_charge    INTEGER NOT NULL DEFAULT 0 CHECK (service_charge >= 0),
                total             INTEGER NOT NULL CHECK (total >= 0),
                paid_amount       INTEGER NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
                cafe_total        INTEGER NOT NULL DEFAULT 0,
                wash_total        INTEGER NOT NULL DEFAULT 0,
                created_at        TEXT NOT NULL DEFAULT (station_now()),
                paid_at           TEXT,
                order_type        TEXT NOT NULL DEFAULT 'TABLE',
                takeaway_no       INTEGER,
                wash_employee_id  INTEGER REFERENCES employees(id)
            );

            INSERT INTO invoices_new (id, invoice_no, order_id, table_label, business_day_id,
                                      shift_id, user_id, customer_id, status, subtotal,
                                      discount_minor, discount_mode, discount_value,
                                      service_charge, total, paid_amount, cafe_total, wash_total,
                                      created_at, paid_at, order_type, takeaway_no,
                                      wash_employee_id)
                SELECT id, invoice_no, order_id, table_label, business_day_id,
                       shift_id, user_id, customer_id, status, subtotal,
                       discount_minor, discount_mode, discount_value,
                       service_charge, total, paid_amount, cafe_total, wash_total,
                       created_at, paid_at, order_type, takeaway_no,
                       wash_employee_id
                FROM invoices;

            DROP TABLE invoices;
            ALTER TABLE invoices_new RENAME TO invoices;

            CREATE INDEX IF NOT EXISTS idx_invoices_day       ON invoices(business_day_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_invoices_shift     ON invoices(shift_id);
            CREATE INDEX IF NOT EXISTS idx_invoices_customer  ON invoices(customer_id);
            CREATE INDEX IF NOT EXISTS idx_invoices_wash_employee ON invoices(wash_employee_id);
        "#,
    },
    Migration {
        version: 33,
        name: "invoice cashier snapshot",
        needs_fk_off: false,
        sql: r#"
            -- ============================================================
            -- INVOICE CASHIER SNAPSHOT
            -- ============================================================
            -- An invoice already snapshots its CUSTOMER (`invoice_customers`),
            -- but the cashier was only ever a live foreign key: `invoices.user_id`
            -- points at a mutable login. Printing therefore had to resolve the
            -- cashier at print time, which means a renamed employee silently
            -- rewrote the identity of every invoice they ever raised, and a
            -- reprint from another device could disagree with the original.
            --
            -- `cashier_name` closes that gap with the same rule every other
            -- invoice field follows: the document carries its own copy of the
            -- identity that was true at the moment of the sale, and a finalized
            -- invoice never reads it back from a mutable master.
            --
            -- The employee record is the person as the business knows them, so
            -- the backfill prefers `employees.name` and falls back to the login
            -- name. This is a BEST-KNOWN value recorded once, at upgrade time:
            -- it is better than no cashier at all on a historical document, and
            -- it is never refreshed afterwards. An invoice whose cashier cannot
            -- be resolved is left NULL and prints no cashier row rather than an
            -- invented one.
            ALTER TABLE invoices ADD COLUMN cashier_name TEXT;

            UPDATE invoices
               SET cashier_name = COALESCE(
                       (SELECT e.name FROM employees e WHERE e.user_id = invoices.user_id),
                       (SELECT u.name FROM users u WHERE u.id = invoices.user_id))
             WHERE cashier_name IS NULL;
        "#,
    },
    Migration {
        version: 34,
        name: "employee-linked expenses and deductions",
        needs_fk_off: false,
        sql: r#"
            -- ============================================================
            -- AN EMPLOYEE ADVANCE IS AN EXPENSE — linked, never duplicated
            -- ============================================================
            -- An advance is money that left the till to an employee, so it belongs
            -- in the expense totals like any other spend. Before this migration the
            -- two halves of that fact lived apart: `employee_advances` recorded the
            -- salary side and `expenses` recorded the money side, with no way to
            -- tell that a given expense WAS an advance.
            --
            -- This migration joins them with ONE stable key:
            --   * `expenses.employee_id`   — WHO the spend is for. NULL for every
            --     pre-existing expense, which is correct: they were not advances.
            --   * `employee_advances.expense_id` — the expense this advance IS.
            --     NULL for every pre-existing advance, which is equally correct:
            --     historical advances stay exactly as they were and are never
            --     back-filled with a fabricated expense.
            --   * the UNIQUE index makes it a DATABASE rule that one expense can
            --     never be claimed by two advance rows, so the link cannot fan out.
            --
            -- NOTHING EXISTING IS REINTERPRETED. No row is rewritten, re-dated,
            -- re-priced or deleted by this migration; it only adds columns, one
            -- system category, one table and the indexes below.

            ALTER TABLE expenses ADD COLUMN employee_id INTEGER REFERENCES employees(id);
            -- Range scans for "this employee's expenses inside a period", which is
            -- the advance query behind the salary cards.
            CREATE INDEX IF NOT EXISTS idx_expenses_employee
                ON expenses(employee_id, expense_date);

            -- ============================================================
            -- THE EMPLOYEE REQUIREMENT IS DATA, NOT CODE
            -- ============================================================
            -- Station's expense categories are deliberately a TABLE, not an enum,
            -- so the service, the repository and the UI contain no hardcoded
            -- category code. Requiring an employee follows the same rule: it is a
            -- PROPERTY of the category, carried in the category payload the UI
            -- already receives. A future employee-linked category therefore needs
            -- no frontend change at all.
            ALTER TABLE expense_categories
                ADD COLUMN requires_employee INTEGER NOT NULL DEFAULT 0
                    CHECK (requires_employee IN (0,1));

            -- The seeded system category for an employee advance. `is_system` keeps
            -- it out of the ADMIN delete list, and the column CHECK keeps the flag
            -- itself honest.
            INSERT INTO expense_categories (code, name_ar, is_system, requires_employee)
            VALUES ('ADVANCE', 'سلفة', 1, 1);

            ALTER TABLE employee_advances
                ADD COLUMN expense_id INTEGER REFERENCES expenses(id);
            -- One expense, at most one advance. Partial, so the historical rows
            -- (many NULLs) are unaffected and a legacy advance stays valid.
            CREATE UNIQUE INDEX IF NOT EXISTS idx_advances_expense
                ON employee_advances(expense_id) WHERE expense_id IS NOT NULL;

            -- ============================================================
            -- THE EXPENSE OWNS A LINKED ADVANCE'S MONEY AND DATE
            -- ============================================================
            -- `employee_advances` keeps its own `amount` and `advance_date` columns
            -- because the historical rows have no expense to read them from, and
            -- because the columns are NOT NULL. For a LINKED row those columns are
            -- a DENORMALIZED COPY, and a copy is only safe if it cannot drift. This
            -- trigger is what makes that true: once an expense is claimed by an
            -- advance, its amount and business date are frozen, so the copy can
            -- never diverge from the record that is the truth. An UPDATE that would
            -- break the invariant is refused by the DATABASE, not by a service
            -- convention that a future caller could bypass.
            CREATE TRIGGER IF NOT EXISTS expenses_linked_advance_frozen
            BEFORE UPDATE OF amount, expense_date ON expenses
            WHEN EXISTS (
                SELECT 1 FROM employee_advances a WHERE a.expense_id = OLD.id
            )
            BEGIN
                SELECT RAISE(ABORT, 'expenses.linked_advance_frozen');
            END;

            -- ============================================================
            -- DEDUCTIONS — money withheld, never spent
            -- ============================================================
            -- A deduction reduces what an employee takes home and NOTHING else. It
            -- is not a purchase, so it is deliberately NOT an expense, NOT an
            -- expense category and NOT part of any expense aggregate: the company
            -- neither paid it nor received it. It lives in its own table so that
            -- distinction is enforced by the schema rather than remembered at every
            -- call site.
            --
            -- It mirrors `employee_advances` deliberately: append-only, never
            -- edited in place and never deleted, because a payroll fact that can be
            -- silently rewritten is not a payroll fact. `reason` is nullable because
            -- a manager may withhold a figure without justifying it in free text.
            CREATE TABLE IF NOT EXISTS employee_deductions (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_id    INTEGER NOT NULL REFERENCES employees(id),
                amount         INTEGER NOT NULL CHECK (amount > 0),  -- piasters
                deduction_date TEXT NOT NULL,                            -- YYYY-MM-DD
                reason         TEXT,
                created_by     INTEGER NOT NULL REFERENCES users(id),
                created_at     TEXT NOT NULL DEFAULT (station_now())
            );
            CREATE INDEX IF NOT EXISTS idx_deductions_employee_date
                ON employee_deductions(employee_id, deduction_date);
        "#,
    },
    Migration {
        version: 35,
        name: "salary expenses are employee-linked",
        needs_fk_off: false,
        sql: r#"
            -- ============================================================
            -- "NEEDS AN EMPLOYEE" AND "IS AN ADVANCE" ARE TWO DIFFERENT FACTS
            -- ============================================================
            -- Until now `create_expense` wrote the `employee_advances` half for
            -- EVERY employee-linked category, because those two things happened
            -- to coincide: the advance was the only seeded employee-linked
            -- category. Making SALARY employee-linked without this column would
            -- silently fabricate an advance ledger row for every salary payment —
            -- and advances are SUBTRACTED from net pay, so each payroll would be
            -- charged twice.
            --
            -- Splitting them here keeps the data-driven design intact: the UI and
            -- the service still recognise no category code, and a future
            -- employee-linked category that is not an advance needs no code
            -- change.
            --
            -- ORDER MATTERS. `records_advance` is seeded FIRST, from the
            -- categories that ALREADY required an employee — today exactly the
            -- advance — so the salary is not swept into it by the statement that
            -- follows. Seeding it after would mark the salary as an advance and
            -- reintroduce the very double-charge this column exists to prevent.
            --
            -- NOTHING EXISTING IS REWRITTEN. No expense row is re-dated,
            -- re-priced, re-categorized, relinked or deleted. Existing SALARY
            -- expenses keep `employee_id = NULL`: they predate the rule, they are
            -- still fully readable, and inventing an employee for them would be a
            -- fabrication. The rule applies to what is recorded from now on.
            ALTER TABLE expense_categories
                ADD COLUMN records_advance INTEGER NOT NULL DEFAULT 0
                    CHECK (records_advance IN (0,1));

            UPDATE expense_categories SET records_advance = 1
                WHERE requires_employee = 1 AND records_advance = 0;

            -- ============================================================
            -- A SALARY PAYMENT IS MONEY PAID TO A NAMED PERSON
            -- ============================================================
            -- `requires_employee` already exists and already means "an expense in
            -- this category must name the employee it is for". The seeded SALARY
            -- category ('رواتب') was inserted before that column existed, so it
            -- still carries the default 0 — which is why a salary could be booked
            -- with nobody behind it while the identical ADVANCE flow could not.
            -- Setting the flag is the whole fix: the service, both dialogs and the
            -- shared selector are already driven by this column, so Salary now
            -- follows exactly the path Advance always did, from POS and from the
            -- Expenses page alike. It is deliberately NOT an advance, so
            -- `records_advance` stays 0 for it.
            UPDATE expense_categories SET requires_employee = 1 WHERE code = 'SALARY';
        "#,
    },
    Migration {
        version: 36,
        name: "shift closure actor",
        needs_fk_off: false,
        sql: r#"
            -- ============================================================
            -- SHIFT CLOSURE ACTOR — who closed the shift vs who owns it
            -- ============================================================
            -- `shifts.user_id` is the OWNER (the cashier who opened the
            -- shift) and never changes. Until now nothing recorded WHO
            -- closed it: a self-close and a managerial close looked
            -- identical, and the audit row was the only witness.
            --
            -- `closed_by` is the authenticated user who performed the
            -- close (`users.id`). NULL for rows closed before this
            -- migration — those keep their financial snapshot byte-identical
            -- and are simply reported as "closed by the owner".
            --
            -- Fully additive: no row is rewritten, no status changes, no
            -- index beyond the FK-adjacent lookup the reports already do.
            ALTER TABLE shifts ADD COLUMN closed_by INTEGER REFERENCES users(id);
            CREATE INDEX IF NOT EXISTS idx_shifts_closed_by ON shifts(closed_by);
        "#,
    },
    Migration {
        version: 37,
        name: "inventory notifications outbox",
        needs_fk_off: false,
        sql: r#"
            -- ============================================================
            -- INVENTORY NOTIFICATIONS — manager-only low/at-minimum outbox
            -- ============================================================
            -- One ACTIVE row per product at most: the partial unique index
            -- below is the DEDUPLICATION guarantee, not application code.
            -- A row morphs AT_MINIMUM <-> BELOW_MINIMUM in place when the
            -- severity changes, so 6 -> 5 -> 4 yields ONE active alert, not
            -- two. Recovery (quantity > min_quantity) RESOLVEs the row so a
            -- later fall re-arms with a fresh ACTIVE row.
            --
            -- Shared MANAGER queue: no per-user recipient column. Station is
            -- a single-cafe offline till; the backend MANAGER gate on every
            -- notification command is the visibility rule, so STAFF can never
            -- read or mutate these rows. `read_at` NULL means unread; opening
            -- the Inventory page never writes it — only the explicit
            -- mark-read commands do.
            CREATE TABLE IF NOT EXISTS inventory_notifications (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id   INTEGER NOT NULL REFERENCES products(id),
                kind         TEXT NOT NULL CHECK (kind IN ('BELOW_MINIMUM','AT_MINIMUM')),
                quantity     INTEGER NOT NULL,
                min_quantity INTEGER NOT NULL CHECK (min_quantity >= 0),
                status       TEXT NOT NULL DEFAULT 'ACTIVE'
                             CHECK (status IN ('ACTIVE','RESOLVED')),
                created_at   TEXT NOT NULL DEFAULT (station_now()),
                resolved_at  TEXT,
                read_at      TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_notifications_active
                ON inventory_notifications(product_id) WHERE status = 'ACTIVE';
            CREATE INDEX IF NOT EXISTS idx_inventory_notifications_status
                ON inventory_notifications(status, created_at);
        "#,
    },
    Migration {
        version: 38,
        name: "raw materials, movements and product recipes",
        needs_fk_off: false,
        sql: r#"
            -- RAW MATERIALS: a SEPARATE inventory domain from products.
            -- A raw material (Coffee Beans, Sugar) is consumed through recipes.
            -- It shares no table with `products`/`inventory_items`; a tracked
            -- PRODUCT keeps its own stock, a raw material keeps this one.
            --
            -- ONE AUTHORITATIVE SOURCE: `current_quantity` is the live balance,
            -- updated transactionally with EVERY movement row. The two never
            -- diverge — the only writer is `repositories::recipes::apply_movement`,
            -- which writes both in the caller's transaction.
            --
            -- `base_unit` is the NORMALIZED unit (GRAM or MILLILITER). A manager
            -- buys in KG/L; the service multiplies by 1000 and stores the
            -- base-unit integer. No string parsing, no floats.
            --
            -- `last_purchase_unit_cost_minor` is the LATEST PER-BASE-UNIT cost
            -- (minor/gram/ml). INFORMATIONAL basis for Recipe Cost only — never
            -- accounting truth, never a FIFO/average valuation, never rewrites a
            -- historical expense. NULL until first purchase.
            CREATE TABLE IF NOT EXISTS raw_materials (
                id                               INTEGER PRIMARY KEY AUTOINCREMENT,
                name                             TEXT NOT NULL
                                                   CHECK (name = trim(name) AND length(name) > 0),
                department                       TEXT NOT NULL CHECK (department IN ('CAFE','WASH')),
                base_unit                        TEXT NOT NULL CHECK (base_unit IN ('GRAM','MILLILITER')),
                current_quantity                 INTEGER NOT NULL DEFAULT 0
                                                   CHECK (current_quantity >= 0),
                last_purchase_unit_cost_minor    INTEGER
                                                   CHECK (last_purchase_unit_cost_minor IS NULL
                                                          OR last_purchase_unit_cost_minor >= 0),
                is_active                        INTEGER NOT NULL DEFAULT 1,
                created_at                       TEXT NOT NULL DEFAULT (station_now()),
                updated_at                       TEXT NOT NULL DEFAULT (station_now()),
                deleted_at                       TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_raw_materials_active
                ON raw_materials(is_active, department, name);

            -- RAW MATERIAL MOVEMENTS: every stock change is explicit. A balance
            -- NEVER changes silently. `reason` is a closed vocabulary:
            --   PURCHASE          stock in (links the Expense it created)
            --   SALE_CONSUMPTION  stock out at checkout (links the invoice)
            --   WASTE             stock out, recorded loss
            --   ADJUSTMENT        manual correction, + or −
            -- No generic hidden decrement path.
            --
            -- `expense_id` is the purchase↔expense link, kept on the movement
            -- side so the expense stays a normal existing Expense with no
            -- generic metadata column. Populated only for PURCHASE.
            CREATE TABLE IF NOT EXISTS raw_material_movements (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                raw_material_id  INTEGER NOT NULL REFERENCES raw_materials(id),
                change           INTEGER NOT NULL CHECK (change != 0),
                reason           TEXT NOT NULL
                                   CHECK (reason IN ('PURCHASE','SALE_CONSUMPTION','WASTE','ADJUSTMENT')),
                note             TEXT,
                ref_invoice_id   INTEGER REFERENCES invoices(id),
                expense_id       INTEGER REFERENCES expenses(id),
                user_id          INTEGER NOT NULL REFERENCES users(id),
                created_at       TEXT NOT NULL DEFAULT (station_now())
            );
            CREATE INDEX IF NOT EXISTS idx_raw_material_movements_material
                ON raw_material_movements(raw_material_id, id);
            CREATE INDEX IF NOT EXISTS idx_raw_material_movements_expense
                ON raw_material_movements(expense_id) WHERE expense_id IS NOT NULL;

            -- PRODUCT RECIPES: which raw materials a tracked product uses.
            -- Ownership is STRUCTURAL: product_id -> products.id, the stable id,
            -- never a name. Checkout consumption resolves by the order line's
            -- product_id, so it never breaks on a rename or a shared name.
            --
            -- A recipe is OPTIONAL even for a tracked product: no rows for a
            -- product means "no recipe, no consumption". One material may appear
            -- in MANY recipes (Sugar in Coffee, Tea, Juice), each with its own
            -- quantity_base — enforced by the UNIQUE pair below.
            --
            -- `quantity_base` is in the material's base unit for ONE unit of the
            -- product; the engine multiplies by the sold quantity.
            CREATE TABLE IF NOT EXISTS product_recipe_items (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id       INTEGER NOT NULL REFERENCES products(id),
                raw_material_id  INTEGER NOT NULL REFERENCES raw_materials(id),
                quantity_base    INTEGER NOT NULL CHECK (quantity_base > 0),
                UNIQUE (product_id, raw_material_id)
            );
            CREATE INDEX IF NOT EXISTS idx_product_recipe_items_material
                ON product_recipe_items(raw_material_id);
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

/// A TEST SEAM: migrate a connection only up to `up_to`, or all the way when
/// `up_to` is `None`.
///
/// This exists so the upgrade tests can build a database written by an OLDER
/// schema, put real rows in it, and then apply the remaining migrations to prove
/// the upgrade preserves them. Application code never calls it: `migrate` is the
/// only entry point the running app uses.
pub fn migrate_up_to(conn: &Db, up_to: Option<i64>) -> AppResult<()> {
    register_clock(conn)?;
    apply_migrations(conn, up_to)
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

    /// The migration that retires invoice cancellation must PRESERVE every
    /// historical document: it is a table rebuild, so it is the change most able
    /// to silently lose a numbered financial record. It must keep the rows, keep
    /// their ids (so lines, payments and snapshots still resolve), and keep every
    /// non-status column byte-identical.
    #[test]
    fn the_cancellation_migration_preserves_every_invoice() {
        let conn = memory_db();
        // A database that predates the retirement, with real data in it.
        apply_migrations(&conn, Some(31)).unwrap();
        conn.execute_batch(
            "INSERT INTO users (id, name, role, password_hash) VALUES (1,'cashier','STAFF','x');
             INSERT INTO business_days (id, day_date, opened_at) VALUES (1,'2026-09-10','2026-09-10 08:00:00');
             INSERT INTO invoices (id, invoice_no, business_day_id, user_id, status,
                                   subtotal, service_charge, total, paid_amount,
                                   cafe_total, wash_total)
             VALUES (7, 101, 1, 1, 'CREDIT', 4_000, 500, 4_500, 0, 4_000, 0),
                    (8, 102, 1, 1, 'PARTIALLY_PAID', 2_000, 0, 2_000, 1_000, 2_000, 0);
             INSERT INTO invoice_lines (invoice_id, department, product_name, unit_price,
                                        quantity, line_total)
             VALUES (7,'CAFE','كابتشينو',4_000,1,4_000);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let rows: Vec<(i64, i64, String, i64, i64, i64, i64)> = conn
            .prepare(
                "SELECT id, invoice_no, status, subtotal, total, paid_amount, cafe_total
                 FROM invoices ORDER BY id",
            )
            .unwrap()
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows.len(), 2, "every invoice is preserved");
        assert_eq!(
            rows[0].0, 7,
            "ids are preserved, so references still resolve"
        );
        assert_eq!(rows[0].1, 101);
        assert_eq!(rows[0].2, "CREDIT", "a supported status is untouched");
        assert_eq!(
            (rows[0].3, rows[0].4, rows[0].5, rows[0].6),
            (4_000, 4_500, 0, 4_000)
        );
        assert_eq!(rows[1].2, "PARTIALLY_PAID");
        assert_eq!(
            (rows[1].3, rows[1].4, rows[1].5, rows[1].6),
            (2_000, 2_000, 1_000, 2_000)
        );

        // The dependent rows still point at a real invoice.
        let lines: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = 7",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(lines, 1, "invoice lines survive the rebuild");
    }

    /// The retirement must be a DATABASE rule, not just a convention: after the
    /// migration there is no way to write a cancelled invoice at all.
    #[test]
    fn the_cancellation_migration_makes_a_cancelled_invoice_impossible() {
        let conn = memory_db();
        migrate(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO users (id, name, role, password_hash) VALUES (1,'cashier','STAFF','x');
             INSERT INTO business_days (id, day_date, opened_at) VALUES (1,'2026-09-10','2026-09-10 08:00:00');
             INSERT INTO invoices (id, invoice_no, business_day_id, user_id, status,
                                   subtotal, total, cafe_total)
             VALUES (1, 1, 1, 1, 'PAID', 1_000, 1_000, 1_000);",
        )
        .unwrap();

        assert!(
            conn.execute("UPDATE invoices SET status = 'CANCELLED'", [])
                .is_err(),
            "the CHECK constraint must refuse a cancelled invoice"
        );
        // Every real status is still accepted, and `cancelled_at` is gone.
        for status in ["PENDING_PAYMENT", "PAID", "PARTIALLY_PAID", "CREDIT"] {
            conn.execute("UPDATE invoices SET status = ?1 WHERE id = 1", [status])
                .unwrap_or_else(|e| panic!("{status} must remain a valid status: {e}"));
        }
        let cancelled_at: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('invoices') WHERE name = 'cancelled_at'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cancelled_at, 0, "the cancellation stamp column is removed");
    }

    /// The corrective migration must not lose the shared credential: an
    /// installation that ran migration 22 (global hash copied into every user)
    /// ends up with exactly ONE global hash in app_settings and no per-user
    /// column at all.
    #[test]
    fn discount_authorization_migration_restores_the_global_pin() {
        let conn = memory_db();
        apply_migrations(&conn, Some(22)).unwrap();
        conn.execute_batch(
            "INSERT INTO users (name, role, password_hash, discount_password_hash) VALUES
                ('legacy-cashier', 'STAFF', 'x', '$argon2id$v=19$legacy$hash'),
                ('legacy-manager', 'MANAGER', 'x', '$argon2id$v=19$legacy$hash');",
        )
        .unwrap();

        migrate(&conn).unwrap();

        // Exactly ONE shared global credential, holding the same Argon2id hash.
        let global: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'discount_authorization_hash'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(global, r#""$argon2id$v=19$legacy$hash""#);
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = 'discount_authorization_hash'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        // The per-user credential column is gone: no misleading per-cashier
        // architecture is left behind.
        let column: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('users')
                 WHERE name = 'discount_password_hash'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(column, 0);
    }

    /// The shift-scoped expense migration must be DATA PRESERVING.
    ///
    /// `expenses` used to carry a hardcoded CHECK enum and no shift link. The
    /// rebuild swaps the enum for a foreign key into `expense_categories` and
    /// adds `shift_id` / `paid_from_cash`. Every pre-existing row must survive
    /// with its category still valid, attributed to no shift (it predates shifts)
    /// and explicitly paid from the drawer — never silently dropped or retyped.
    #[test]
    fn the_shift_scoped_expense_migration_preserves_every_historical_row() {
        let conn = memory_db();
        apply_migrations(&conn, Some(24)).unwrap();
        conn.execute_batch(
            "INSERT INTO users (name, role, password_hash) VALUES ('legacy', 'MANAGER', 'x');
             INSERT INTO business_days (day_date, opened_at) VALUES ('2026-01-01', '2026-01-01 08:00:00Z');
             INSERT INTO expenses (category, amount, description, expense_date, business_day_id, user_id) VALUES
               ('SUPPLIES', 100, 'legacy supplies', '2026-01-01', 1, 1),
               ('SALARY', 250, NULL, '2026-01-01', 1, 1),
               ('UTILITY', 75, 'legacy power', '2026-01-01', NULL, 1);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        // No row is lost, and no amount is rewritten.
        let rows: Vec<(String, i64, Option<String>, Option<i64>, i64)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT category, amount, description, business_day_id, paid_from_cash
                     FROM expenses ORDER BY id",
                )
                .unwrap();
            let mapped = stmt
                .query_map([], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })
                .unwrap();
            mapped.collect::<Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(rows.len(), 3, "every historical expense survives");
        assert_eq!(rows[0].0, "SUPPLIES");
        assert_eq!(rows[0].1, 100);
        assert_eq!(rows[0].2.as_deref(), Some("legacy supplies"));
        assert_eq!(rows[0].3, Some(1));
        assert_eq!(rows[1].0, "SALARY");
        assert_eq!(
            rows[2].3, None,
            "a row recorded without a business day keeps none"
        );
        assert!(
            rows.iter().all(|r| r.4 == 1),
            "an upgraded expense defaults to paid from the drawer"
        );
        // The category enum became a table with the SAME six codes, so every
        // historical label is still resolvable.
        let orphan: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM expenses e
                 LEFT JOIN expense_categories c ON c.code = e.category
                 WHERE c.code IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphan, 0, "no historical expense lost its category");
        // Historical expenses belong to no shift, which is what keeps them out of
        // every drawer's reconciliation.
        let attributed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM expenses WHERE shift_id IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(attributed, 0);
    }

    /// A category that is later deactivated (or renamed) must not corrupt or
    /// rewrite history: the FK keeps the row, the code is the join key, and the
    /// closing snapshot keeps the label that was true when it was issued.
    #[test]
    fn deactivating_a_category_keeps_history_readable() {
        let conn = memory_db();
        migrate(&conn).unwrap();
        crate::seed::run_if_empty(&conn).unwrap();
        let user: i64 = conn
            .query_row(
                "SELECT id FROM users WHERE role = 'MANAGER' LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO expenses (category, amount, expense_date, user_id)
             VALUES ('SUPPLIES', 500, '2026-02-02', ?1)",
            [user],
        )
        .unwrap();
        conn.execute(
            "UPDATE expense_categories SET is_active = 0 WHERE code = 'SUPPLIES'",
            [],
        )
        .unwrap();

        // Still readable, still resolvable to its Arabic name…
        let name: Option<String> = conn
            .query_row(
                "SELECT c.name_ar FROM expenses e
                 LEFT JOIN expense_categories c ON c.code = e.category
                 WHERE e.amount = 500",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name.as_deref(), Some("مشتريات"));
        // …but no longer offered as a choice for a NEW expense.
        let offered: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM expense_categories WHERE is_active = 1 AND code = 'SUPPLIES'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(offered, 0);
        // Deleting it is refused by the foreign key: history cannot be corrupted.
        let delete = conn.execute("DELETE FROM expense_categories WHERE code = 'SUPPLIES'", []);
        assert!(delete.is_err(), "a category in use must not be deletable");
    }

    /// A fresh database ends up with the correct global model too: no per-user
    /// column, and simply no PIN until an ADMIN/MANAGER configures one.
    #[test]
    fn discount_authorization_migration_is_safe_on_a_fresh_database() {
        let conn = memory_db();
        migrate(&conn).unwrap();
        crate::seed::run_if_empty(&conn).unwrap();

        let column: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('users')
                 WHERE name = 'discount_password_hash'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(column, 0);
        let global_left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = 'discount_authorization_hash'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(global_left, 0);
    }

    /// An installation that never had any credential keeps none: the corrective
    /// migration must not invent a PIN, and a second run must not duplicate one.
    #[test]
    fn discount_authorization_migration_never_invents_or_duplicates_a_pin() {
        let conn = memory_db();
        apply_migrations(&conn, Some(22)).unwrap();
        conn.execute_batch(
            "INSERT INTO users (name, role, password_hash) VALUES
                ('plain-cashier', 'STAFF', 'x'),
                ('plain-manager', 'MANAGER', 'x');",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let global_left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = 'discount_authorization_hash'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(global_left, 0);

        // A PIN configured after the upgrade is never overwritten by a re-run.
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('discount_authorization_hash', ?1)",
            [r#""$argon2id$v=19$fresh$hash""#],
        )
        .unwrap();
        let stored: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'discount_authorization_hash'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, r#""$argon2id$v=19$fresh$hash""#);
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
        // Stop AT migration 19 rather than migrating to the latest: this test
        // re-runs migration 19's own SQL below, and that SQL names the columns
        // as they existed then. A later migration may legitimately retire a
        // column it normalised (the invoice-cancellation migration dropped
        // `invoices.cancelled_at`), and re-running the historical SQL against a
        // newer schema would then fail on a column that no longer exists —
        // testing the schema instead of the migration.
        apply_migrations(&conn, Some(19)).unwrap();
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
            .query_row("SELECT created_at FROM users WHERE name = 'a'", [], |r| {
                r.get(0)
            })
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
        // Migrate only to 19, for the same reason as the test above.
        apply_migrations(&conn, Some(19)).unwrap();
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
        // Migrate only to 19, for the same reason as the test above.
        apply_migrations(&conn, Some(19)).unwrap();
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
