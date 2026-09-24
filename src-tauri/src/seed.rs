//! Deterministic seed infrastructure.
//!
//! - Runs the full starter seed only on a fresh database.
//! - Catalog v2 is synchronized once for existing installations.
//! - Seed catalog entries are flagged (`is_seed = 1`).
//! - Historical transaction data is never deleted.
//! - Old catalog rows that are referenced by history are deactivated;
//!   unreferenced old seed rows can be removed safely.
//! - Categories are required for every catalog row; existing rows were
//!   backfilled to a seeded system category during migration 14.

use crate::db::Db;
use crate::error::AppResult;
use crate::repositories::users;
use crate::services::auth;

/// Marker written into `app_settings` after the initial seed completes.
const SEED_MARKER: &str = "seed.completed_at";

/// Marker for the current starter catalog version.
const CATALOG_SEED_MARKER: &str = "seed.catalog.v2.completed_at";

/// Default starter accounts.
const DEFAULT_USERS: &[(&str, Option<&str>, &str, &str)] = &[
    ("admin", None, "ADMIN", "admin123"),
    ("manager", None, "MANAGER", "manager123"),
    ("amira", None, "MANAGER", "20192"),
    ("cashier", None, "STAFF", "cashier123"),
];

/// Current Station starter catalog.
///
/// Tuple:
/// (name, item_type, department, price in EGP)
///
/// Every seeded row is assigned to the seeded system category ("عام").
const DEFAULT_PRODUCTS: &[(&str, &str, &str, i64)] = &[
    // ============================================================
    // BREAKFAST
    // ============================================================
    ("CROISSANT ROMI", "PRODUCT", "CAFE", 74),
    ("CROISSANT TURKEY", "PRODUCT", "CAFE", 98),
    ("CROISSANT BEEF", "PRODUCT", "CAFE", 108),
    ("GREECE SALAD", "PRODUCT", "CAFE", 59),
    // ============================================================
    // CLASSIC & COFFEE
    // ============================================================
    ("CLASSIC TEA", "PRODUCT", "CAFE", 25),
    ("FLAVOR TEA", "PRODUCT", "CAFE", 28),
    ("HERBS", "PRODUCT", "CAFE", 32),
    ("TURKISH COFFEE (S)", "PRODUCT", "CAFE", 39),
    ("TURKISH COFFEE (D)", "PRODUCT", "CAFE", 44),
    ("TURKISH COFFEE (MS)", "PRODUCT", "CAFE", 49),
    ("TURKISH COFFEE (MD)", "PRODUCT", "CAFE", 54),
    ("FRENCH COFFEE", "PRODUCT", "CAFE", 54),
    ("HAZELNUT COFFEE", "PRODUCT", "CAFE", 59),
    // ============================================================
    // HOT DRINK
    // ============================================================
    ("ESPRESSO", "PRODUCT", "CAFE", 52),
    ("MOCHA POT", "PRODUCT", "CAFE", 79),
    ("AMERICANO", "PRODUCT", "CAFE", 69),
    ("MICATO", "PRODUCT", "CAFE", 54),
    ("CORTADO", "PRODUCT", "CAFE", 69),
    ("CAPPUCCINO", "PRODUCT", "CAFE", 74),
    ("LATTE", "PRODUCT", "CAFE", 79),
    ("FLAT WHITE", "PRODUCT", "CAFE", 84),
    ("MOCHA", "PRODUCT", "CAFE", 89),
    ("CARAMEL MACCHIATO", "PRODUCT", "CAFE", 89),
    ("SALTED MACCHIATO CREAM", "PRODUCT", "CAFE", 99),
    ("CHOCOLATE CLASSIC", "PRODUCT", "CAFE", 74),
    ("CHOCOLATE ORIO", "PRODUCT", "CAFE", 79),
    ("CHOCOLATE CREAM", "PRODUCT", "CAFE", 89),
    ("CHOCOLATE MARSHEILO", "PRODUCT", "CAFE", 84),
    ("CARAMEL HOT", "PRODUCT", "CAFE", 69),
    ("HOT CIDER", "PRODUCT", "CAFE", 75),
    // ============================================================
    // FRESH JUICE
    // ============================================================
    ("ORANGE", "PRODUCT", "CAFE", 85),
    ("LEMON", "PRODUCT", "CAFE", 69),
    ("MANGO", "PRODUCT", "CAFE", 89),
    ("DATE", "PRODUCT", "CAFE", 87),
    ("GUAVA", "PRODUCT", "CAFE", 79),
    ("STRAWBERRY", "PRODUCT", "CAFE", 87),
    ("WATERMELON", "PRODUCT", "CAFE", 85),
    // ============================================================
    // DEZZERT
    // ============================================================
    ("MOLTEN", "PRODUCT", "CAFE", 94),
    ("CHOCOLATE", "PRODUCT", "CAFE", 85),
    ("LUTOS", "PRODUCT", "CAFE", 89),
    ("REDVALVET", "PRODUCT", "CAFE", 85),
    ("CHEESS CAKE", "PRODUCT", "CAFE", 89),
    ("CINNABON", "PRODUCT", "CAFE", 120),
    ("DONUTS", "PRODUCT", "CAFE", 70),
    ("WAFFEL", "PRODUCT", "CAFE", 90),
    ("PANCAKE", "PRODUCT", "CAFE", 99),
    // ============================================================
    // SOFT DRINK
    // ============================================================
    ("FAYROUZ", "PRODUCT", "CAFE", 40),
    ("PEPSI", "PRODUCT", "CAFE", 30),
    ("RED BULL", "PRODUCT", "CAFE", 80),
    ("WATER", "PRODUCT", "CAFE", 10),
    // ============================================================
    // EXTERA
    // ============================================================
    ("MILK", "PRODUCT", "CAFE", 19),
    ("ICE CREAM", "PRODUCT", "CAFE", 30),
    ("NUTEILA", "PRODUCT", "CAFE", 24),
    ("SAUS", "PRODUCT", "CAFE", 20),
    ("PUREE", "PRODUCT", "CAFE", 24),
    ("PISTACHIO", "PRODUCT", "CAFE", 30),
    ("HAZELNUT", "PRODUCT", "CAFE", 15),
    ("SHOT", "PRODUCT", "CAFE", 30),
    // ============================================================
    // ICED COFFEE
    // ============================================================
    ("ICE AMERICANO", "PRODUCT", "CAFE", 87),
    ("ICE LATTE", "PRODUCT", "CAFE", 89),
    ("ICE MOCHA", "PRODUCT", "CAFE", 93),
    ("ICE WHITE MOCHA", "PRODUCT", "CAFE", 96),
    ("ICE CARAMEL MACCHIATO", "PRODUCT", "CAFE", 93),
    ("SPANISH LATTE", "PRODUCT", "CAFE", 99),
    ("ICE SALTED CARAMEL", "PRODUCT", "CAFE", 124),
    // ============================================================
    // FRAPPE
    // ============================================================
    ("VANILLA FRAPPE", "PRODUCT", "CAFE", 85),
    ("MOCHA FRAPPE", "PRODUCT", "CAFE", 89),
    ("CARAMEL FRAPPE", "PRODUCT", "CAFE", 89),
    ("PISTACHIO FRAPPE", "PRODUCT", "CAFE", 99),
    // ============================================================
    // SMOTHIE
    // ============================================================
    ("LIMON MINT", "PRODUCT", "CAFE", 69),
    ("WATERMELON", "PRODUCT", "CAFE", 85),
    ("BLUEBERRY", "PRODUCT", "CAFE", 88),
    ("MANGO PASSION", "PRODUCT", "CAFE", 99),
    ("STRAWBERRY", "PRODUCT", "CAFE", 87),
    ("GREEN APPLE", "PRODUCT", "CAFE", 79),
    // ============================================================
    // MILKSHAKE
    // ============================================================
    ("VANILLA", "PRODUCT", "CAFE", 87),
    ("CHOCOLATE", "PRODUCT", "CAFE", 89),
    ("LOTUS", "PRODUCT", "CAFE", 97),
    ("OREO", "PRODUCT", "CAFE", 97),
    ("MOCHA", "PRODUCT", "CAFE", 99),
    ("BLUEBERRY", "PRODUCT", "CAFE", 99),
    // ============================================================
    // MOCKTAIL
    // ============================================================
    ("BLUE SKY", "PRODUCT", "CAFE", 87),
    ("GREEN APPLE", "PRODUCT", "CAFE", 88),
    ("PASSION FRUIT", "PRODUCT", "CAFE", 83),
    ("BLUEBERRY", "PRODUCT", "CAFE", 87),
    ("STRAWBERRY", "PRODUCT", "CAFE", 88),
    ("CANDY LOVERS", "PRODUCT", "CAFE", 123),
    // ============================================================
    // CAR WASH SERVICES
    // ============================================================
    ("غسيل كامل سيدان", "SERVICE", "WASH", 175),
    ("غسيل خارجي سيدان", "SERVICE", "WASH", 85),
    ("غسيل كامل", "SERVICE", "WASH", 200),
    ("غسيل خارجي", "SERVICE", "WASH", 95),
    ("غسيل VIP", "SERVICE", "WASH", 250),
    ("صالون كيماوي جلد", "SERVICE", "WASH", 600),
    ("صالون كيماوي قماش", "SERVICE", "WASH", 750),
    ("سقف كيماوي", "SERVICE", "WASH", 350),
    ("جنط كيماوي", "SERVICE", "WASH", 80),
    ("أرضية كيماوي", "SERVICE", "WASH", 100),
    ("باب كيماوي", "SERVICE", "WASH", 60),
    ("مانور كيماوي", "SERVICE", "WASH", 100),
    ("كرسي كيماوي", "SERVICE", "WASH", 150),
    ("كنية كيماوي", "SERVICE", "WASH", 300),
    ("شنطة كيماوي", "SERVICE", "WASH", 100),
    ("كاركير كامل (Car Care)", "SERVICE", "WASH", 1500),
    ("تلميع مرحلة", "SERVICE", "WASH", 1500),
    ("تلميع مرحلتين", "SERVICE", "WASH", 1800),
    ("تلميع 3 مراحل", "SERVICE", "WASH", 2500),
];

pub fn run_if_empty(conn: &Db) -> AppResult<()> {
    let done: i64 = conn.query_row(
        "SELECT COUNT(*) FROM app_settings WHERE key = ?1",
        [SEED_MARKER],
        |r| r.get(0),
    )?;

    // Fresh database: create users, catalog and tables.
    if done == 0 {
        conn.execute_batch("BEGIN IMMEDIATE;")?;

        let result = seed_content(conn).and_then(|_| {
            conn.execute(
                "INSERT INTO app_settings (key, value)
                 VALUES (?1, datetime('now'))
                 ON CONFLICT(key) DO NOTHING",
                [SEED_MARKER],
            )?;

            conn.execute(
                "INSERT INTO app_settings (key, value)
                 VALUES (?1, datetime('now'))
                 ON CONFLICT(key) DO NOTHING",
                [CATALOG_SEED_MARKER],
            )?;

            Ok(())
        });

        match result {
            Ok(_) => conn.execute_batch("COMMIT;")?,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err(e);
            }
        }

        log::info!("seed: fresh database initialized");
        return Ok(());
    }

    // Existing installation: synchronize the current catalog once.
    sync_catalog_if_needed(conn)?;

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

    insert_default_products(conn)?;

    for n in 1..=12 {
        conn.execute(
            "INSERT INTO cafe_tables (label)
             VALUES (?1)
             ON CONFLICT(label) DO NOTHING",
            rusqlite::params![format!("طاولة {n:02}")],
        )?;
    }

    log::info!(
        "seed: users, {} catalog entries and tables created",
        DEFAULT_PRODUCTS.len()
    );

    Ok(())
}

/// Synchronize the current starter catalog on an existing installation.
///
/// Important:
/// - Historical rows are never deleted.
/// - Products referenced by order_lines, inventory_items or stock_movements
///   are retained and simply deactivated.
/// - Unreferenced old seed products are deleted.
/// - The current catalog is inserted as fresh seed rows.
fn sync_catalog_if_needed(conn: &Db) -> AppResult<()> {
    let done: i64 = conn.query_row(
        "SELECT COUNT(*) FROM app_settings WHERE key = ?1",
        [CATALOG_SEED_MARKER],
        |r| r.get(0),
    )?;

    if done > 0 {
        return Ok(());
    }

    conn.execute_batch("BEGIN IMMEDIATE;")?;

    let result = sync_catalog(conn);

    match result {
        Ok(_) => {
            conn.execute(
                "INSERT INTO app_settings (key, value)
                 VALUES (?1, datetime('now'))
                 ON CONFLICT(key) DO NOTHING",
                [CATALOG_SEED_MARKER],
            )?;

            conn.execute_batch("COMMIT;")?;

            log::info!("seed: catalog synchronized to v2");
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(e)
        }
    }
}

fn sync_catalog(conn: &Db) -> AppResult<()> {
    // Existing seed products become inactive first.
    //
    // This guarantees that even if an old row is referenced by historical
    // transactions, it can no longer appear in the active catalog.
    conn.execute(
        "UPDATE products
         SET is_active = 0,
             updated_at = datetime('now')
         WHERE is_seed = 1",
        [],
    )?;

    // Delete old seed products only when absolutely nothing references them.
    //
    // Historical order_lines are snapshots, but their product_id FK still
    // references products, so referenced products must remain in the DB.
    conn.execute(
        "DELETE FROM products
         WHERE is_seed = 1
           AND NOT EXISTS (
               SELECT 1
               FROM order_lines
               WHERE order_lines.product_id = products.id
           )
           AND NOT EXISTS (
               SELECT 1
               FROM inventory_items
               WHERE inventory_items.product_id = products.id
           )
           AND NOT EXISTS (
               SELECT 1
               FROM stock_movements
               WHERE stock_movements.product_id = products.id
           )",
        [],
    )?;

    insert_default_products(conn)?;

    Ok(())
}

fn insert_default_products(conn: &Db) -> AppResult<()> {
    for (name, item_type, department, price_egp) in DEFAULT_PRODUCTS {
        let price_minor = price_egp.checked_mul(100).ok_or_else(|| {
            crate::error::AppError::internal(format!(
                "price overflow while seeding product: {name}"
            ))
        })?;

        conn.execute(
            "INSERT INTO products
                (name, item_type, department, category_id, price_minor, is_active, is_seed)
             VALUES (?1, ?2, ?3, (SELECT id FROM categories WHERE is_system = 1 ORDER BY id LIMIT 1), ?4, 1, 1)",
            rusqlite::params![name, item_type, department, price_minor],
        )?;
    }

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

        let marker_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = ?1",
                [SEED_MARKER],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(marker_count, 1);

        let catalog_marker_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = ?1",
                [CATALOG_SEED_MARKER],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(catalog_marker_count, 1);

        let product_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM products
                 WHERE is_seed = 1 AND is_active = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(product_count, DEFAULT_PRODUCTS.len() as i64);
    }

    #[test]
    fn fresh_seed_contains_expected_catalog() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM products
                 WHERE is_seed = 1 AND is_active = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(count, DEFAULT_PRODUCTS.len() as i64);

        let croissant_price: i64 = conn
            .query_row(
                "SELECT price_minor
                 FROM products
                 WHERE name = 'CROISSANT ROMI'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(croissant_price, 7400);

        let wash: (String, String, i64) = conn
            .query_row(
                "SELECT item_type, department, price_minor
                 FROM products
                 WHERE name = 'كاركير كامل (Car Care)'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();

        assert_eq!(wash, ("SERVICE".to_string(), "WASH".to_string(), 150000));
    }

    #[test]
    fn catalog_v2_replaces_old_unreferenced_seed_data() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();

        // Simulate an existing installation with the old seed marker.
        conn.execute(
            "INSERT INTO app_settings (key, value)
             VALUES (?1, datetime('now'))",
            [SEED_MARKER],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO products
                (name, item_type, department, category_id, price_minor, is_active, is_seed)
             VALUES ('قهوة قديمة', 'PRODUCT', 'CAFE', (SELECT id FROM categories WHERE is_system = 1), 3000, 1, 1)",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO products
                (name, item_type, department, category_id, price_minor, is_active, is_seed)
             VALUES ('مغسلة قديمة', 'SERVICE', 'WASH', (SELECT id FROM categories WHERE is_system = 1), 5000, 1, 1)",
            [],
        )
        .unwrap();

        run_if_empty(&conn).unwrap();

        let old_count: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM products
                 WHERE name IN ('قهوة قديمة', 'مغسلة قديمة')",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(old_count, 0);

        let new_count: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM products
                 WHERE is_seed = 1 AND is_active = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(new_count, DEFAULT_PRODUCTS.len() as i64);
    }

    #[test]
    fn referenced_old_seed_product_is_preserved_but_deactivated() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();

        conn.execute(
            "INSERT INTO users (name, role, password_hash)
             VALUES ('legacy-user', 'STAFF', 'x')",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO cafe_tables (label)
             VALUES ('Legacy Table')",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO products
                (name, item_type, department, category_id, price_minor, is_active, is_seed)
             VALUES ('Legacy Coffee', 'PRODUCT', 'CAFE', (SELECT id FROM categories WHERE is_system = 1), 3000, 1, 1)",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO orders
                (order_type, table_id, user_id, status)
             VALUES ('TABLE', 1, 1, 'CLOSED')",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO order_lines
                (order_id, product_id, department, product_name,
                 unit_price, quantity, line_total)
             VALUES (1, 1, 'CAFE', 'Legacy Coffee', 3000, 1, 3000)",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO app_settings (key, value)
             VALUES (?1, datetime('now'))",
            [SEED_MARKER],
        )
        .unwrap();

        run_if_empty(&conn).unwrap();

        let legacy: (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(is_active), 0)
                 FROM products
                 WHERE name = 'Legacy Coffee'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();

        assert_eq!(legacy, (1, 0));

        let order_line_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM order_lines
                 WHERE product_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(order_line_count, 1);
    }
}
