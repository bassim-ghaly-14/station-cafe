//! Deterministic seed infrastructure.
//!
//! - Runs the full starter seed only on a fresh database.
//! - Catalog v3 is synchronized once for existing installations.
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
    ("كرواسون رومي", "PRODUCT", "CAFE", 74, "الإفطار", None),
    ("كرواسون تركي", "PRODUCT", "CAFE", 98, "الإفطار", None),
    ("كرواسون لحم بقري", "PRODUCT", "CAFE", 108, "الإفطار", None),
    ("سلطة يونانية", "PRODUCT", "CAFE", 59, "الإفطار", None),
    // ============================================================
    // CLASSIC & COFFEE
    // ============================================================
    ("شاي كلاسيك", "PRODUCT", "CAFE", 25, "كلاسيك وقهوة", None),
    ("شاي نكهات", "PRODUCT", "CAFE", 28, "كلاسيك وقهوة", None),
    ("أعشاب", "PRODUCT", "CAFE", 32, "كلاسيك وقهوة", None),
    ("قهوة تركي صغير", "PRODUCT", "CAFE", 39, "كلاسيك وقهوة", None),
    ("قهوة تركي دبل", "PRODUCT", "CAFE", 44, "كلاسيك وقهوة", None),
    (
        "قهوة تركي وسط صغير",
        "PRODUCT",
        "CAFE",
        49,
        "كلاسيك وقهوة",
        None,
    ),
    (
        "قهوة تركي وسط دبل",
        "PRODUCT",
        "CAFE",
        54,
        "كلاسيك وقهوة",
        None,
    ),
    ("قهوة فرنسية", "PRODUCT", "CAFE", 54, "كلاسيك وقهوة", None),
    ("قهوة بالبندق", "PRODUCT", "CAFE", 59, "كلاسيك وقهوة", None),
    // ============================================================
    // HOT DRINK
    // ============================================================
    ("إسبريسو", "PRODUCT", "CAFE", 52, "مشروبات ساخنة", None),
    ("موكا بوت", "PRODUCT", "CAFE", 79, "مشروبات ساخنة", None),
    ("أمريكانو", "PRODUCT", "CAFE", 69, "مشروبات ساخنة", None),
    ("ماكياتو", "PRODUCT", "CAFE", 54, "مشروبات ساخنة", None),
    ("كورتادو", "PRODUCT", "CAFE", 69, "مشروبات ساخنة", None),
    ("كابتشينو", "PRODUCT", "CAFE", 74, "مشروبات ساخنة", None),
    ("لاتيه", "PRODUCT", "CAFE", 79, "مشروبات ساخنة", None),
    ("فلات وايت", "PRODUCT", "CAFE", 84, "مشروبات ساخنة", None),
    ("موكا", "PRODUCT", "CAFE", 89, "مشروبات ساخنة", None),
    (
        "كراميل ماكياتو",
        "PRODUCT",
        "CAFE",
        89,
        "مشروبات ساخنة",
        None,
    ),
    (
        "كريمة ماكياتو بالملح",
        "PRODUCT",
        "CAFE",
        99,
        "مشروبات ساخنة",
        None,
    ),
    (
        "شوكولاتة كلاسيك",
        "PRODUCT",
        "CAFE",
        74,
        "مشروبات ساخنة",
        None,
    ),
    (
        "شوكولاتة أوريو",
        "PRODUCT",
        "CAFE",
        79,
        "مشروبات ساخنة",
        None,
    ),
    (
        "شوكولاتة بالكريمة",
        "PRODUCT",
        "CAFE",
        89,
        "مشروبات ساخنة",
        None,
    ),
    (
        "شوكولاتة مارشميلو",
        "PRODUCT",
        "CAFE",
        84,
        "مشروبات ساخنة",
        None,
    ),
    ("كراميل ساخن", "PRODUCT", "CAFE", 69, "مشروبات ساخنة", None),
    ("سيدر ساخن", "PRODUCT", "CAFE", 75, "مشروبات ساخنة", None),
    // ============================================================
    // FRESH JUICE
    // ============================================================
    ("برتقال", "PRODUCT", "CAFE", 85, "عصائر طازجة", None),
    ("ليمون", "PRODUCT", "CAFE", 69, "عصائر طازجة", None),
    ("مانجو", "PRODUCT", "CAFE", 89, "عصائر طازجة", None),
    ("تمر", "PRODUCT", "CAFE", 87, "عصائر طازجة", None),
    ("جوافة", "PRODUCT", "CAFE", 79, "عصائر طازجة", None),
    ("فراولة", "PRODUCT", "CAFE", 87, "عصائر طازجة", None),
    ("بطيخ", "PRODUCT", "CAFE", 85, "عصائر طازجة", None),
    // ============================================================
    // DESSERT
    // ============================================================
    ("مولتن", "PRODUCT", "CAFE", 94, "حلويات", None),
    ("شوكولاتة", "PRODUCT", "CAFE", 85, "حلويات", None),
    ("لوتس", "PRODUCT", "CAFE", 89, "حلويات", None),
    ("ريد فيلفت", "PRODUCT", "CAFE", 85, "حلويات", None),
    ("تشيز كيك", "PRODUCT", "CAFE", 89, "حلويات", None),
    ("سينابون", "PRODUCT", "CAFE", 120, "حلويات", None),
    ("دونات", "PRODUCT", "CAFE", 70, "حلويات", None),
    ("وافل", "PRODUCT", "CAFE", 90, "حلويات", None),
    ("بان كيك", "PRODUCT", "CAFE", 99, "حلويات", None),
    // ============================================================
    // SOFT DRINK
    // ============================================================
    ("فيروز", "PRODUCT", "CAFE", 40, "مشروبات غازية", Some(0)),
    ("بيبسي", "PRODUCT", "CAFE", 30, "مشروبات غازية", Some(0)),
    ("ريد بول", "PRODUCT", "CAFE", 80, "مشروبات غازية", Some(0)),
    ("مياه", "PRODUCT", "CAFE", 10, "مشروبات غازية", Some(0)),
    // ============================================================
    // EXTRAS
    // ============================================================
    ("لبن", "PRODUCT", "CAFE", 19, "إضافات", Some(0)),
    ("آيس كريم", "PRODUCT", "CAFE", 30, "إضافات", Some(0)),
    ("نوتيلا", "PRODUCT", "CAFE", 24, "إضافات", Some(0)),
    ("صوص", "PRODUCT", "CAFE", 20, "إضافات", Some(0)),
    ("بوريه", "PRODUCT", "CAFE", 24, "إضافات", Some(0)),
    ("فستق", "PRODUCT", "CAFE", 30, "إضافات", Some(0)),
    ("بندق", "PRODUCT", "CAFE", 15, "إضافات", Some(0)),
    ("شوت", "PRODUCT", "CAFE", 30, "إضافات", Some(0)),
    // ============================================================
    // ICED COFFEE
    // ============================================================
    ("آيس أمريكانو", "PRODUCT", "CAFE", 87, "قهوة مثلجة", None),
    ("آيس لاتيه", "PRODUCT", "CAFE", 89, "قهوة مثلجة", None),
    ("آيس موكا", "PRODUCT", "CAFE", 93, "قهوة مثلجة", None),
    ("آيس وايت موكا", "PRODUCT", "CAFE", 96, "قهوة مثلجة", None),
    (
        "آيس كراميل ماكياتو",
        "PRODUCT",
        "CAFE",
        93,
        "قهوة مثلجة",
        None,
    ),
    ("سبانيش لاتيه", "PRODUCT", "CAFE", 99, "قهوة مثلجة", None),
    (
        "آيس كراميل مملح",
        "PRODUCT",
        "CAFE",
        124,
        "قهوة مثلجة",
        None,
    ),
    // ============================================================
    // FRAPPE
    // ============================================================
    ("فرابيه فانيليا", "PRODUCT", "CAFE", 85, "فرابيه", None),
    ("فرابيه موكا", "PRODUCT", "CAFE", 89, "فرابيه", None),
    ("فرابيه كراميل", "PRODUCT", "CAFE", 89, "فرابيه", None),
    ("فرابيه فستق", "PRODUCT", "CAFE", 99, "فرابيه", None),
    // ============================================================
    // SMOOTHIE
    // ============================================================
    ("ليمون بالنعناع", "PRODUCT", "CAFE", 69, "سموذي", None),
    ("بطيخ", "PRODUCT", "CAFE", 85, "سموذي", None),
    ("توت أزرق", "PRODUCT", "CAFE", 88, "سموذي", None),
    ("مانجو باشن", "PRODUCT", "CAFE", 99, "سموذي", None),
    ("فراولة", "PRODUCT", "CAFE", 87, "سموذي", None),
    ("تفاح أخضر", "PRODUCT", "CAFE", 79, "سموذي", None),
    // ============================================================
    // MILKSHAKE
    // ============================================================
    ("ميلك شيك فانيليا", "PRODUCT", "CAFE", 87, "ميلك شيك", None),
    ("ميلك شيك شوكولاتة", "PRODUCT", "CAFE", 89, "ميلك شيك", None),
    ("ميلك شيك لوتس", "PRODUCT", "CAFE", 97, "ميلك شيك", None),
    ("ميلك شيك أوريو", "PRODUCT", "CAFE", 97, "ميلك شيك", None),
    ("ميلك شيك موكا", "PRODUCT", "CAFE", 99, "ميلك شيك", None),
    ("ميلك شيك توت أزرق", "PRODUCT", "CAFE", 99, "ميلك شيك", None),
    // ============================================================
    // MOCKTAIL
    // ============================================================
    ("بلو سكاي", "PRODUCT", "CAFE", 87, "موكتيل", None),
    ("تفاح أخضر", "PRODUCT", "CAFE", 88, "موكتيل", None),
    ("باشن فروت", "PRODUCT", "CAFE", 83, "موكتيل", None),
    ("توت أزرق", "PRODUCT", "CAFE", 87, "موكتيل", None),
    ("فراولة", "PRODUCT", "CAFE", 88, "موكتيل", None),
    ("كاندي لافرز", "PRODUCT", "CAFE", 123, "موكتيل", None),
    // ============================================================
    // CAR WASH SERVICES
    // ============================================================
    (
        "غسيل كامل سيدان",
        "SERVICE",
        "WASH",
        175,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "غسيل خارجي سيدان",
        "SERVICE",
        "WASH",
        85,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "غسيل كامل",
        "SERVICE",
        "WASH",
        200,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "غسيل خارجي",
        "SERVICE",
        "WASH",
        95,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "غسيل VIP",
        "SERVICE",
        "WASH",
        250,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "صالون كيماوي جلد",
        "SERVICE",
        "WASH",
        600,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "صالون كيماوي قماش",
        "SERVICE",
        "WASH",
        750,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "سقف كيماوي",
        "SERVICE",
        "WASH",
        350,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "جنط كيماوي",
        "SERVICE",
        "WASH",
        80,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "أرضية كيماوي",
        "SERVICE",
        "WASH",
        100,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "باب كيماوي",
        "SERVICE",
        "WASH",
        60,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "مانور كيماوي",
        "SERVICE",
        "WASH",
        100,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "كرسي كيماوي",
        "SERVICE",
        "WASH",
        150,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "كنبة كيماوي",
        "SERVICE",
        "WASH",
        300,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "شنطة كيماوي",
        "SERVICE",
        "WASH",
        100,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "كار كير كامل",
        "SERVICE",
        "WASH",
        1500,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "تلميع مرحلة واحدة",
        "SERVICE",
        "WASH",
        1500,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "تلميع مرحلتين",
        "SERVICE",
        "WASH",
        1800,
        "خدمات غسيل السيارات",
        None,
    ),
    (
        "تلميع ثلاث مراحل",
        "SERVICE",
        "WASH",
        2500,
        "خدمات غسيل السيارات",
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
                 VALUES (?1, station_now())
                 ON CONFLICT(key) DO NOTHING",
                [SEED_MARKER],
            )?;

            conn.execute(
                "INSERT INTO app_settings (key, value)
                 VALUES (?1, station_now())
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
                 VALUES (?1, station_now())
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
             updated_at = station_now()
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
                "INSERT INTO inventory_items (product_id, quantity)
                 VALUES (?1, ?2)",
                rusqlite::params![product_id, quantity],
            )?;

            if *quantity != 0 {
                conn.execute(
                    "INSERT INTO stock_movements
                        (product_id, change, reason, note, ref_invoice_id, user_id)
                     VALUES (?1, ?2, 'ADJUSTMENT', 'initial_stock', NULL,
                        (SELECT id FROM users
                         WHERE role = 'ADMIN'
                         ORDER BY id
                         LIMIT 1))",
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
                 WHERE name = 'كرواسون رومي'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(croissant_price, 7400);

        let wash: (String, String, i64) = conn
            .query_row(
                "SELECT item_type, department, price_minor
                 FROM products
                 WHERE name = 'كار كير كامل'",
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
                "SELECT category_id
                 FROM products
                 WHERE name = 'كرواسون رومي'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        let breakfast_name: String = conn
            .query_row(
                "SELECT c.name
                 FROM products p
                 JOIN categories c ON c.id = p.category_id
                 WHERE p.name = 'كرواسون رومي'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(breakfast_name, "الإفطار");

        let water: (i64, String, i64) = conn
            .query_row(
                "SELECT p.id, c.name, i.quantity
                 FROM products p
                 JOIN categories c ON c.id = p.category_id
                 JOIN inventory_items i ON i.product_id = p.id
                 WHERE p.name = 'مياه'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(water, (water.0, "مشروبات غازية".to_string(), 0));

        let stock_visible: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM inventory_items i
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
                "SELECT COUNT(*)
                 FROM products
                 WHERE item_type = 'SERVICE'
                   AND track_inventory = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(service_stock, 0);

        let category_name: String = conn
            .query_row(
                "SELECT c.name
                 FROM products p
                 JOIN categories c ON c.id = p.category_id
                 WHERE p.name = 'كار كير كامل'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(category_name, "خدمات غسيل السيارات");
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
    fn catalog_v3_replaces_old_unreferenced_seed_data() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();

        // Simulate an existing installation with the old seed marker.
        conn.execute(
            "INSERT INTO app_settings (key, value)
             VALUES (?1, station_now())",
            [SEED_MARKER],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO products
                (name, item_type, department, category_id, price_minor, is_active, is_seed)
             VALUES (
                'قهوة قديمة',
                'PRODUCT',
                'CAFE',
                (SELECT id FROM categories WHERE is_system = 1),
                3000,
                1,
                1
             )",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO products
                (name, item_type, department, category_id, price_minor, is_active, is_seed)
             VALUES (
                'مغسلة قديمة',
                'SERVICE',
                'WASH',
                (SELECT id FROM categories WHERE is_system = 1),
                5000,
                1,
                1
             )",
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
             VALUES (
                'Legacy Coffee',
                'PRODUCT',
                'CAFE',
                (SELECT id FROM categories WHERE is_system = 1),
                3000,
                1,
                1
             )",
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
             VALUES (?1, station_now())",
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
                "SELECT COUNT(*)
                 FROM order_lines
                 WHERE product_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(order_line_count, 1);
    }
}
