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
use crate::repositories::{catalog, users};
use crate::services::auth;

/// Marker written into `app_settings` after the initial seed completes.
const SEED_MARKER: &str = "seed.completed_at";

/// Marker for the current starter catalog version.
const CATALOG_SEED_MARKER: &str = "seed.catalog.v3.completed_at";

/// Default starter accounts.
const DEFAULT_USERS: &[(&str, Option<&str>, &str, &str)] = &[
    ("admin", None, "ADMIN", "admin123"),
    ("manager", None, "MANAGER", "manager123"),
    ("amira", None, "MANAGER", "20192"),
    ("cashier", None, "STAFF", "cashier123"),
];

/// Current Station starter catalog.
///
/// Tuple: (name, item_type, department, price in EGP, category, opening stock).
/// Category names intentionally match the group comments above each record.
const DEFAULT_PRODUCTS: &[(&str, &str, &str, i64, &str, Option<i64>)] = &[
    // ============================================================
    // BREAKFAST
    // ============================================================
    ("CROISSANT ROMI", "PRODUCT", "CAFE", 74, "BREAKFAST", None),
    ("CROISSANT TURKEY", "PRODUCT", "CAFE", 98, "BREAKFAST", None),
    ("CROISSANT BEEF", "PRODUCT", "CAFE", 108, "BREAKFAST", None),
    ("GREECE SALAD", "PRODUCT", "CAFE", 59, "BREAKFAST", None),
    // ============================================================
    // CLASSIC & COFFEE
    // ============================================================
    (
        "CLASSIC TEA",
        "PRODUCT",
        "CAFE",
        25,
        "CLASSIC & COFFEE",
        None,
    ),
    (
        "FLAVOR TEA",
        "PRODUCT",
        "CAFE",
        28,
        "CLASSIC & COFFEE",
        None,
    ),
    ("HERBS", "PRODUCT", "CAFE", 32, "CLASSIC & COFFEE", None),
    (
        "TURKISH COFFEE (S)",
        "PRODUCT",
        "CAFE",
        39,
        "CLASSIC & COFFEE",
        None,
    ),
    (
        "TURKISH COFFEE (D)",
        "PRODUCT",
        "CAFE",
        44,
        "CLASSIC & COFFEE",
        None,
    ),
    (
        "TURKISH COFFEE (MS)",
        "PRODUCT",
        "CAFE",
        49,
        "CLASSIC & COFFEE",
        None,
    ),
    (
        "TURKISH COFFEE (MD)",
        "PRODUCT",
        "CAFE",
        54,
        "CLASSIC & COFFEE",
        None,
    ),
    (
        "FRENCH COFFEE",
        "PRODUCT",
        "CAFE",
        54,
        "CLASSIC & COFFEE",
        None,
    ),
    (
        "HAZELNUT COFFEE",
        "PRODUCT",
        "CAFE",
        59,
        "CLASSIC & COFFEE",
        None,
    ),
    // ============================================================
    // HOT DRINK
    // ============================================================
    ("ESPRESSO", "PRODUCT", "CAFE", 52, "HOT DRINK", None),
    ("MOCHA POT", "PRODUCT", "CAFE", 79, "HOT DRINK", None),
    ("AMERICANO", "PRODUCT", "CAFE", 69, "HOT DRINK", None),
    ("MICATO", "PRODUCT", "CAFE", 54, "HOT DRINK", None),
    ("CORTADO", "PRODUCT", "CAFE", 69, "HOT DRINK", None),
    ("CAPPUCCINO", "PRODUCT", "CAFE", 74, "HOT DRINK", None),
    ("LATTE", "PRODUCT", "CAFE", 79, "HOT DRINK", None),
    ("FLAT WHITE", "PRODUCT", "CAFE", 84, "HOT DRINK", None),
    ("MOCHA", "PRODUCT", "CAFE", 89, "HOT DRINK", None),
    (
        "CARAMEL MACCHIATO",
        "PRODUCT",
        "CAFE",
        89,
        "HOT DRINK",
        None,
    ),
    (
        "SALTED MACCHIATO CREAM",
        "PRODUCT",
        "CAFE",
        99,
        "HOT DRINK",
        None,
    ),
    (
        "CHOCOLATE CLASSIC",
        "PRODUCT",
        "CAFE",
        74,
        "HOT DRINK",
        None,
    ),
    ("CHOCOLATE ORIO", "PRODUCT", "CAFE", 79, "HOT DRINK", None),
    ("CHOCOLATE CREAM", "PRODUCT", "CAFE", 89, "HOT DRINK", None),
    (
        "CHOCOLATE MARSHEILO",
        "PRODUCT",
        "CAFE",
        84,
        "HOT DRINK",
        None,
    ),
    ("CARAMEL HOT", "PRODUCT", "CAFE", 69, "HOT DRINK", None),
    ("HOT CIDER", "PRODUCT", "CAFE", 75, "HOT DRINK", None),
    // ============================================================
    // FRESH JUICE
    // ============================================================
    ("ORANGE", "PRODUCT", "CAFE", 85, "FRESH JUICE", None),
    ("LEMON", "PRODUCT", "CAFE", 69, "FRESH JUICE", None),
    ("MANGO", "PRODUCT", "CAFE", 89, "FRESH JUICE", None),
    ("DATE", "PRODUCT", "CAFE", 87, "FRESH JUICE", None),
    ("GUAVA", "PRODUCT", "CAFE", 79, "FRESH JUICE", None),
    ("STRAWBERRY", "PRODUCT", "CAFE", 87, "FRESH JUICE", None),
    ("WATERMELON", "PRODUCT", "CAFE", 85, "FRESH JUICE", None),
    // ============================================================
    // DEZZERT
    // ============================================================
    ("MOLTEN", "PRODUCT", "CAFE", 94, "DEZZERT", None),
    ("CHOCOLATE", "PRODUCT", "CAFE", 85, "DEZZERT", None),
    ("LUTOS", "PRODUCT", "CAFE", 89, "DEZZERT", None),
    ("REDVALVET", "PRODUCT", "CAFE", 85, "DEZZERT", None),
    ("CHEESS CAKE", "PRODUCT", "CAFE", 89, "DEZZERT", None),
    ("CINNABON", "PRODUCT", "CAFE", 120, "DEZZERT", None),
    ("DONUTS", "PRODUCT", "CAFE", 70, "DEZZERT", None),
    ("WAFFEL", "PRODUCT", "CAFE", 90, "DEZZERT", None),
    ("PANCAKE", "PRODUCT", "CAFE", 99, "DEZZERT", None),
    // ============================================================
    // SOFT DRINK
    // ============================================================
    ("FAYROUZ", "PRODUCT", "CAFE", 40, "SOFT DRINK", Some(0)),
    ("PEPSI", "PRODUCT", "CAFE", 30, "SOFT DRINK", Some(0)),
    ("RED BULL", "PRODUCT", "CAFE", 80, "SOFT DRINK", Some(0)),
    ("WATER", "PRODUCT", "CAFE", 10, "SOFT DRINK", Some(0)),
    // ============================================================
    // EXTERA
    // ============================================================
    ("MILK", "PRODUCT", "CAFE", 19, "EXTERA", Some(0)),
    ("ICE CREAM", "PRODUCT", "CAFE", 30, "EXTERA", Some(0)),
    ("NUTEILA", "PRODUCT", "CAFE", 24, "EXTERA", Some(0)),
    ("SAUS", "PRODUCT", "CAFE", 20, "EXTERA", Some(0)),
    ("PUREE", "PRODUCT", "CAFE", 24, "EXTERA", Some(0)),
    ("PISTACHIO", "PRODUCT", "CAFE", 30, "EXTERA", Some(0)),
    ("HAZELNUT", "PRODUCT", "CAFE", 15, "EXTERA", Some(0)),
    ("SHOT", "PRODUCT", "CAFE", 30, "EXTERA", Some(0)),
    // ============================================================
    // ICED COFFEE
    // ============================================================
    ("ICE AMERICANO", "PRODUCT", "CAFE", 87, "ICED COFFEE", None),
    ("ICE LATTE", "PRODUCT", "CAFE", 89, "ICED COFFEE", None),
    ("ICE MOCHA", "PRODUCT", "CAFE", 93, "ICED COFFEE", None),
    (
        "ICE WHITE MOCHA",
        "PRODUCT",
        "CAFE",
        96,
        "ICED COFFEE",
        None,
    ),
    (
        "ICE CARAMEL MACCHIATO",
        "PRODUCT",
        "CAFE",
        93,
        "ICED COFFEE",
        None,
    ),
    ("SPANISH LATTE", "PRODUCT", "CAFE", 99, "ICED COFFEE", None),
    (
        "ICE SALTED CARAMEL",
        "PRODUCT",
        "CAFE",
        124,
        "ICED COFFEE",
        None,
    ),
    // ============================================================
    // FRAPPE
    // ============================================================
    ("VANILLA FRAPPE", "PRODUCT", "CAFE", 85, "FRAPPE", None),
    ("MOCHA FRAPPE", "PRODUCT", "CAFE", 89, "FRAPPE", None),
    ("CARAMEL FRAPPE", "PRODUCT", "CAFE", 89, "FRAPPE", None),
    ("PISTACHIO FRAPPE", "PRODUCT", "CAFE", 99, "FRAPPE", None),
    // ============================================================
    // SMOTHIE
    // ============================================================
    ("LIMON MINT", "PRODUCT", "CAFE", 69, "SMOTHIE", None),
    ("WATERMELON", "PRODUCT", "CAFE", 85, "SMOTHIE", None),
    ("BLUEBERRY", "PRODUCT", "CAFE", 88, "SMOTHIE", None),
    ("MANGO PASSION", "PRODUCT", "CAFE", 99, "SMOTHIE", None),
    ("STRAWBERRY", "PRODUCT", "CAFE", 87, "SMOTHIE", None),
    ("GREEN APPLE", "PRODUCT", "CAFE", 79, "SMOTHIE", None),
    // ============================================================
    // MILKSHAKE
    // ============================================================
    ("VANILLA", "PRODUCT", "CAFE", 87, "MILKSHAKE", None),
    ("CHOCOLATE", "PRODUCT", "CAFE", 89, "MILKSHAKE", None),
    ("LOTUS", "PRODUCT", "CAFE", 97, "MILKSHAKE", None),
    ("OREO", "PRODUCT", "CAFE", 97, "MILKSHAKE", None),
    ("MOCHA", "PRODUCT", "CAFE", 99, "MILKSHAKE", None),
    ("BLUEBERRY", "PRODUCT", "CAFE", 99, "MILKSHAKE", None),
    // ============================================================
    // MOCKTAIL
    // ============================================================
    ("BLUE SKY", "PRODUCT", "CAFE", 87, "MOCKTAIL", None),
    ("GREEN APPLE", "PRODUCT", "CAFE", 88, "MOCKTAIL", None),
    ("PASSION FRUIT", "PRODUCT", "CAFE", 83, "MOCKTAIL", None),
    ("BLUEBERRY", "PRODUCT", "CAFE", 87, "MOCKTAIL", None),
    ("STRAWBERRY", "PRODUCT", "CAFE", 88, "MOCKTAIL", None),
    ("CANDY LOVERS", "PRODUCT", "CAFE", 123, "MOCKTAIL", None),
    // ============================================================
    // CAR WASH SERVICES
    // ============================================================
    (
        "غسيل كامل سيدان",
        "SERVICE",
        "WASH",
        175,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "غسيل خارجي سيدان",
        "SERVICE",
        "WASH",
        85,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "غسيل كامل",
        "SERVICE",
        "WASH",
        200,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "غسيل خارجي",
        "SERVICE",
        "WASH",
        95,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "غسيل VIP",
        "SERVICE",
        "WASH",
        250,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "صالون كيماوي جلد",
        "SERVICE",
        "WASH",
        600,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "صالون كيماوي قماش",
        "SERVICE",
        "WASH",
        750,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "سقف كيماوي",
        "SERVICE",
        "WASH",
        350,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "جنط كيماوي",
        "SERVICE",
        "WASH",
        80,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "أرضية كيماوي",
        "SERVICE",
        "WASH",
        100,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "باب كيماوي",
        "SERVICE",
        "WASH",
        60,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "مانور كيماوي",
        "SERVICE",
        "WASH",
        100,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "كرسي كيماوي",
        "SERVICE",
        "WASH",
        150,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "كنية كيماوي",
        "SERVICE",
        "WASH",
        300,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "شنطة كيماوي",
        "SERVICE",
        "WASH",
        100,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "كاركير كامل (Car Care)",
        "SERVICE",
        "WASH",
        1500,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "تلميع مرحلة",
        "SERVICE",
        "WASH",
        1500,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "تلميع مرحلتين",
        "SERVICE",
        "WASH",
        1800,
        "CAR WASH SERVICES",
        None,
    ),
    (
        "تلميع 3 مراحل",
        "SERVICE",
        "WASH",
        2500,
        "CAR WASH SERVICES",
        None,
    ),
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

            log::info!("seed: catalog synchronized to v3");
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
    for (name, item_type, department, price_egp, category_name, stock_quantity) in DEFAULT_PRODUCTS
    {
        let price_minor = price_egp.checked_mul(100).ok_or_else(|| {
            crate::error::AppError::internal(format!(
                "price overflow while seeding product: {name}"
            ))
        })?;
        let category_id = catalog::ensure_category(conn, category_name)?;
        let track_inventory = stock_quantity.is_some();
        conn.execute(
            "INSERT INTO products
                (name, item_type, department, category_id, price_minor,
                 is_active, track_inventory, is_seed)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 1)",
            rusqlite::params![
                name,
                item_type,
                department,
                category_id,
                price_minor,
                track_inventory as i64
            ],
        )?;
        if let Some(quantity) = stock_quantity {
            let product_id = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO inventory_items (product_id, quantity) VALUES (?1, ?2)",
                rusqlite::params![product_id, quantity],
            )?;
            if *quantity != 0 {
                conn.execute(
                    "INSERT INTO stock_movements
                        (product_id, change, reason, note, ref_invoice_id, user_id)
                     VALUES (?1, ?2, 'ADJUSTMENT', 'initial_stock', NULL,
                        (SELECT id FROM users WHERE role = 'ADMIN' ORDER BY id LIMIT 1))",
                    rusqlite::params![product_id, quantity],
                )?;
            }
        }
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
    fn official_seed_maps_comments_to_categories_and_optional_inventory() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();

        let breakfast_category: i64 = conn
            .query_row(
                "SELECT category_id FROM products WHERE name = 'CROISSANT ROMI'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let breakfast_name: String = conn
            .query_row(
                "SELECT c.name FROM products p JOIN categories c ON c.id = p.category_id
                 WHERE p.name = 'CROISSANT ROMI'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(breakfast_name, "BREAKFAST");

        let water: (i64, String, i64) = conn
            .query_row(
                "SELECT p.id, c.name, i.quantity
                 FROM products p
                 JOIN categories c ON c.id = p.category_id
                 JOIN inventory_items i ON i.product_id = p.id
                 WHERE p.name = 'WATER'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(water, (water.0, "SOFT DRINK".to_string(), 0));
        let stock_visible: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM inventory_items i
                 JOIN products p ON p.id = i.product_id
                 WHERE p.track_inventory = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            stock_visible,
            DEFAULT_PRODUCTS
                .iter()
                .filter(|row| row.5.is_some())
                .count() as i64
        );

        let service_stock: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM products
                 WHERE item_type = 'SERVICE' AND track_inventory = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(service_stock, 0);

        let category_name: String = conn
            .query_row(
                "SELECT c.name FROM products p JOIN categories c ON c.id = p.category_id
                 WHERE p.name = 'كاركير كامل (Car Care)'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(category_name, "CAR WASH SERVICES");
        assert!(breakfast_category > 0);
    }

    #[test]
    fn official_seed_categories_are_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();
        let categories: i64 = conn
            .query_row("SELECT COUNT(*) FROM categories", [], |row| row.get(0))
            .unwrap();
        let products: i64 = conn
            .query_row("SELECT COUNT(*) FROM products", [], |row| row.get(0))
            .unwrap();
        run_if_empty(&conn).unwrap();
        let categories_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM categories", [], |row| row.get(0))
            .unwrap();
        let products_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM products", [], |row| row.get(0))
            .unwrap();
        assert_eq!(categories_after, categories);
        assert_eq!(products_after, products);
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
