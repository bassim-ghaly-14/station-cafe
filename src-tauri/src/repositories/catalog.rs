//! Product catalog repository.

use crate::error::AppResult;
use crate::repositories::Db;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Product {
    pub id: i64,
    pub name: String,
    pub item_type: String,  // PRODUCT | SERVICE
    pub department: String, // CAFE | WASH
    pub category_id: i64,
    pub category_name: String,
    pub price_minor: i64,
    pub is_active: bool,
    pub track_inventory: bool,
    pub stock_quantity: i64,
    pub min_quantity: i64,
    pub is_seed: bool,
    /// Presentation flag: this is a recent addition, independent of `is_active`.
    pub is_new: bool,
    /// Whether this product has a raw-material recipe. Only meaningful for a
    /// tracked product; drives the catalog "recipe" affordance and the POS
    /// recipe-availability signal. Computed, never stored on the product row.
    pub has_recipe: bool,
}

const COLS: &str =
    "p.id, p.name, p.item_type, p.department, p.category_id, c.name, p.price_minor, p.is_active, p.track_inventory, COALESCE(i.quantity, 0), COALESCE(i.min_quantity, 0), p.is_seed, p.is_new, EXISTS(SELECT 1 FROM product_recipe_items ri WHERE ri.product_id = p.id)";

/// An archived item is excluded from EVERY catalog read: POS, product
/// management, selectors, category counts and by-id lookups. Its row is kept
/// (not deleted) so history, stock movements and audit stay referentially
/// intact — `order_lines`/`invoice_lines` are snapshots and never need it.
const NOT_ARCHIVED: &str = "p.deleted_at IS NULL";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Product> {
    Ok(Product {
        id: row.get(0)?,
        name: row.get(1)?,
        item_type: row.get(2)?,
        department: row.get(3)?,
        category_id: row.get(4)?,
        category_name: row.get(5)?,
        price_minor: row.get(6)?,
        is_active: row.get::<_, i64>(7)? != 0,
        track_inventory: row.get::<_, i64>(8)? != 0,
        stock_quantity: row.get(9)?,
        min_quantity: row.get(10)?,
        is_seed: row.get::<_, i64>(11)? != 0,
        is_new: row.get::<_, i64>(12)? != 0,
        has_recipe: row.get::<_, i64>(13)? != 0,
    })
}

/// Staff-facing list: active items only. Manager list: everything.
/// Archived (ADMIN-deleted) items are never returned in either mode.
pub fn list(conn: &Db, department: Option<&str>, active_only: bool) -> AppResult<Vec<Product>> {
    let mut sql = format!("SELECT {COLS} FROM products p JOIN categories c ON c.id = p.category_id LEFT JOIN inventory_items i ON i.product_id = p.id WHERE {NOT_ARCHIVED}");
    if active_only {
        sql.push_str(" AND p.is_active = 1");
    }
    if department.is_some() {
        sql.push_str(" AND p.department = ?1");
    }
    sql.push_str(" ORDER BY p.department, p.name");
    let mut stmt = conn.prepare(&sql)?;
    // The department placeholder only exists when a filter was appended;
    // binding unconditionally would fail with "Got 1, needed 0".
    let rows = match department {
        Some(d) => stmt.query_map(params![d], row)?,
        None => stmt.query_map([], row)?,
    };
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get(conn: &Db, id: i64) -> AppResult<Option<Product>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM products p JOIN categories c ON c.id = p.category_id LEFT JOIN inventory_items i ON i.product_id = p.id WHERE {NOT_ARCHIVED} AND p.id = ?1"))?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(r) => Ok(Some(row(r)?)),
        None => Ok(None),
    }
}

pub fn category_exists(conn: &Db, id: i64) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM categories WHERE id = ?1)",
        [id],
        |r| r.get(0),
    )?)
}

pub fn category_name_exists(conn: &Db, name: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM categories WHERE name = ?1)",
        [name],
        |r| r.get(0),
    )?)
}

pub fn insert_category(conn: &Db, name: &str) -> AppResult<i64> {
    conn.execute("INSERT INTO categories (name) VALUES (?1)", [name])?;
    Ok(conn.last_insert_rowid())
}

/// Create a category only when the trimmed name is not already present.
/// This is used by deterministic seed synchronization.
pub fn ensure_category(conn: &Db, name: &str) -> AppResult<i64> {
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM categories WHERE name = ?1 ORDER BY id LIMIT 1",
            [name],
            |row| row.get(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    insert_category(conn, name)
}

/// The stored row behind a category, including the SYSTEM flag.
///
/// `is_system` marks the built-in category every pre-migration product was
/// moved onto. It is deliberately NOT part of the [`Category`] shape the UI
/// reads: what a category is called and whether it may be removed are two
/// different questions, and only the second one needs the flag.
pub struct StoredCategory {
    pub id: i64,
    pub name: String,
    pub is_system: bool,
}

/// One category by id, or `None` for an id that does not exist.
pub fn get_category(conn: &Db, id: i64) -> AppResult<Option<StoredCategory>> {
    Ok(conn
        .query_row(
            "SELECT id, name, is_system FROM categories WHERE id = ?1",
            [id],
            |row| {
                Ok(StoredCategory {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    is_system: row.get::<_, i64>(2)? != 0,
                })
            },
        )
        .optional()?)
}

/// Uniqueness is the DATABASE's guarantee (`name ... COLLATE NOCASE UNIQUE`).
/// This is the readable pre-check the service uses, and it must IGNORE the row
/// being saved: otherwise re-submitting a category's own unchanged name would be
/// rejected as a duplicate of itself.
pub fn category_name_exists_except(conn: &Db, name: &str, except_id: i64) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM categories WHERE name = ?1 AND id != ?2)",
        params![name, except_id],
        |r| r.get(0),
    )?)
}

/// Rename a category. Returns `false` for an id that is not there, so the
/// service can answer "not found" instead of reporting a silent success.
pub fn update_category(conn: &Db, id: i64, name: &str) -> AppResult<bool> {
    let changed = conn.execute(
        "UPDATE categories SET name = ?2, updated_at = station_now() WHERE id = ?1",
        params![id, name],
    )?;
    Ok(changed > 0)
}

/// Every product still pointing at the category, ARCHIVED ones INCLUDED.
///
/// The count is deliberately taken over the whole `products` table and not over
/// the live catalog: an archived item keeps its row and its `category_id`, so it
/// is a live foreign key exactly like an active one. Counting only active items
/// would let the service delete a category the database would then refuse, which
/// is the kind of disagreement the service is here to prevent.
pub fn category_product_count(conn: &Db, id: i64) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM products WHERE category_id = ?1",
        [id],
        |r| r.get(0),
    )?)
}

/// Remove an empty category. The caller is responsible for proving the category
/// is empty and not the system one — see `services::catalog::delete_category`.
pub fn delete_category(conn: &Db, id: i64) -> AppResult<bool> {
    let deleted = conn.execute("DELETE FROM categories WHERE id = ?1", [id])?;
    Ok(deleted > 0)
}

pub struct NewProduct<'a> {
    pub name: &'a str,
    pub item_type: &'a str,
    pub department: &'a str,
    pub category_id: i64,
    pub price_minor: i64,
    pub track_inventory: bool,
    /// Opening stock quantity; only applied when `track_inventory` is true.
    pub stock_quantity: i64,
    /// Minimum-stock threshold; only applied when `track_inventory` is true.
    /// Inserted atomically with the product row — never a second call.
    pub min_quantity: i64,
    /// Whether the item is flagged as a recent addition.
    pub is_new: bool,
    /// Actor recorded on the opening stock movement.
    pub user_id: i64,
}

pub fn insert(conn: &Db, p: &NewProduct<'_>) -> AppResult<i64> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO products (name, item_type, department, category_id, price_minor, track_inventory, is_new)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            p.name,
            p.item_type,
            p.department,
            p.category_id,
            p.price_minor,
            p.track_inventory as i64,
            p.is_new as i64
        ],
    )?;
    let id = tx.last_insert_rowid();
    if p.track_inventory {
        tx.execute(
            "INSERT INTO inventory_items (product_id, quantity, min_quantity) VALUES (?1, ?2, ?3)",
            params![id, p.stock_quantity, p.min_quantity.max(0)],
        )?;
        crate::repositories::ops::sync_notification_for_product(&tx, id)?;
        if p.stock_quantity != 0 {
            tx.execute(
                "INSERT INTO stock_movements
                    (product_id, change, reason, note, ref_invoice_id, user_id)
                 VALUES (?1, ?2, 'ADJUSTMENT', 'initial_stock', NULL, ?3)",
                params![id, p.stock_quantity, p.user_id],
            )?;
        }
    }
    tx.commit()?;
    Ok(id)
}

/// Returns the previous row state (name/price/active) for audit purposes.
/// Archived items are immutable: an edit can never revive a deleted row.
pub fn update_price(conn: &Db, id: i64, price_minor: i64) -> AppResult<i64> {
    let old: i64 = conn.query_row(
        "SELECT price_minor FROM products WHERE id = ?1 AND deleted_at IS NULL",
        [id],
        |r| r.get(0),
    )?;
    conn.execute(
        "UPDATE products SET price_minor = ?2, updated_at = station_now() WHERE id = ?1 AND deleted_at IS NULL",
        params![id, price_minor],
    )?;
    Ok(old)
}

pub fn update(
    conn: &Db,
    id: i64,
    name: &str,
    category_id: i64,
    price_minor: i64,
    track_inventory: bool,
    stock_quantity: Option<i64>,
    min_quantity: Option<i64>,
    is_new: bool,
    user_id: i64,
) -> AppResult<bool> {
    let tx = conn.unchecked_transaction()?;
    let changed = tx.execute(
        "UPDATE products SET name = ?2, category_id = ?3, price_minor = ?4,
             track_inventory = ?5, is_new = ?6, updated_at = station_now()
         WHERE id = ?1 AND deleted_at IS NULL",
        params![
            id,
            name,
            category_id,
            price_minor,
            track_inventory as i64,
            is_new as i64
        ],
    )?;
    if changed == 0 {
        tx.commit()?;
        return Ok(false);
    }

    // Stock is optional: disabling tracking hides the item from inventory
    // flows but deliberately keeps its last quantity for re-enabling.
    // Re-enabling a row that already exists preserves its stored quantity —
    // the row is NOT zeroed — and any supplied quantity/minimum apply on top.
    if track_inventory {
        let existing: Option<(i64, i64)> = tx
            .query_row(
                "SELECT quantity, min_quantity FROM inventory_items WHERE product_id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (old_quantity, old_min) = existing.unwrap_or((0, 0));
        if existing.is_none() {
            tx.execute(
                "INSERT INTO inventory_items (product_id, quantity, min_quantity) VALUES (?1, 0, 0)",
                [id],
            )?;
        }
        if let Some(target) = stock_quantity {
            let change = target - old_quantity;
            if change != 0 {
                tx.execute(
                    "UPDATE inventory_items
                     SET quantity = ?2, updated_at = station_now()
                     WHERE product_id = ?1",
                    params![id, target],
                )?;
                tx.execute(
                    "INSERT INTO stock_movements
                        (product_id, change, reason, note, ref_invoice_id, user_id)
                     VALUES (?1, ?2, 'ADJUSTMENT', 'product_edit', NULL, ?3)",
                    params![id, change, user_id],
                )?;
            }
        }
        if let Some(min) = min_quantity {
            if min != old_min {
                tx.execute(
                    "UPDATE inventory_items
                     SET min_quantity = ?2, updated_at = station_now()
                     WHERE product_id = ?1",
                    params![id, min.max(0)],
                )?;
            }
        }
        crate::repositories::ops::sync_notification_for_product(&tx, id)?;
    }
    tx.commit()?;
    Ok(true)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: i64,
    pub name: String,
}

pub fn list_categories(conn: &Db) -> AppResult<Vec<Category>> {
    let mut stmt = conn.prepare("SELECT id, name FROM categories ORDER BY name")?;
    let rows = stmt.query_map([], |r| {
        Ok(Category {
            id: r.get(0)?,
            name: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Toggle operational availability. An archived (deleted) item can never be
/// re-activated: `deleted_at` is the terminal state, `is_active` is not.
pub fn set_active(conn: &Db, id: i64, active: bool) -> AppResult<()> {
    conn.execute(
        "UPDATE products SET is_active = ?2, updated_at = station_now()
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id, active as i64],
    )?;
    Ok(())
}

pub fn rename(conn: &Db, id: i64, name: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE products SET name = ?2, updated_at = station_now()
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id, name],
    )?;
    Ok(())
}

/// Soft delete: archive the item instead of removing the row.
///
/// The row (and its original name, price, type, department, category and
/// stock) is RETAINED, so `order_lines.product_id`, `inventory_items` and
/// `stock_movements` keep resolving and every historical document still
/// describes the item exactly as it was sold. `is_active` is cleared at the
/// same time so the archived item also disappears from POS immediately.
///
/// Returns `false` when the id is unknown OR was already archived, which is
/// what the service turns into a not-found result.
pub fn archive(conn: &Db, id: i64) -> AppResult<bool> {
    let changed = conn.execute(
        "UPDATE products
         SET deleted_at = station_now(),
             is_active = 0,
             updated_at = station_now()
         WHERE id = ?1 AND deleted_at IS NULL",
        [id],
    )?;
    Ok(changed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate;
    use crate::demo_data::seed_for_development as run_if_empty;
    use rusqlite::Connection;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();
        conn
    }

    /// Regression: the department filter is appended conditionally, so an
    /// unfiltered list must bind ZERO parameters (was "Got 1, needed 0").
    #[test]
    fn list_without_department_filter_binds_no_params() {
        let conn = fresh();
        let all = list(&conn, None, false).unwrap();
        assert!(!all.is_empty());
        let active = list(&conn, None, true).unwrap();
        assert!(active.iter().all(|p| p.is_active));
        let cafe = list(&conn, Some("CAFE"), false).unwrap();
        assert!(!cafe.is_empty() && cafe.iter().all(|p| p.department == "CAFE"));
    }

    fn system_category(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT id FROM categories WHERE is_system = 1 ORDER BY id LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn admin_user(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT id FROM users WHERE role = 'ADMIN' ORDER BY id LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn new_product<'a>(
        category_id: i64,
        track_inventory: bool,
        stock_quantity: i64,
        user_id: i64,
    ) -> NewProduct<'a> {
        NewProduct {
            name: "Test Item",
            item_type: "PRODUCT",
            department: "CAFE",
            category_id,
            price_minor: 1000,
            track_inventory,
            stock_quantity,
            min_quantity: 0,
            is_new: false,
            user_id,
        }
    }

    #[test]
    fn ensure_category_reuses_an_existing_case_insensitive_name() {
        let conn = fresh();
        let first = ensure_category(&conn, "Drinks").unwrap();
        let second = ensure_category(&conn, "drinks").unwrap();
        assert_eq!(first, second);
        assert!(!insert_category(&conn, "drinks").is_ok());
    }

    /// A stock-managed item is created together with its inventory row and an
    /// auditable opening movement; a non-stock item creates no inventory row.
    #[test]
    fn insert_syncs_optional_inventory_state() {
        let conn = fresh();
        let category = system_category(&conn);
        let admin = admin_user(&conn);

        let tracked_id = insert(&conn, &new_product(category, true, 7, admin)).unwrap();
        let quantity: i64 = conn
            .query_row(
                "SELECT quantity FROM inventory_items WHERE product_id = ?1",
                [tracked_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(quantity, 7);
        let movement: (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(change), 0)
                 FROM stock_movements WHERE product_id = ?1",
                [tracked_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(movement, (1, 7));

        let plain_id = insert(&conn, &new_product(category, false, 99, admin)).unwrap();
        let inventory_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM inventory_items WHERE product_id = ?1",
                [plain_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(inventory_rows, 0);
    }

    /// Disabling stock management hides the item from inventory flows without
    /// destroying the last quantity, so re-enabling is lossless.
    #[test]
    fn update_toggles_stock_management_without_data_loss() {
        let conn = fresh();
        let category = system_category(&conn);
        let admin = admin_user(&conn);
        let id = insert(&conn, &new_product(category, true, 5, admin)).unwrap();

        assert!(update(
            &conn,
            id,
            "Test Item",
            category,
            1000,
            true,
            Some(9),
            None,
            false,
            admin
        )
        .unwrap());
        let adjustment: (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(change), 0)
                 FROM stock_movements WHERE product_id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(adjustment, (2, 9));

        update(
            &conn,
            id,
            "Test Item",
            category,
            1000,
            false,
            None,
            None,
            false,
            admin,
        )
        .unwrap();
        let disabled: (i64, i64) = conn
            .query_row(
                "SELECT p.track_inventory, i.quantity
                 FROM products p JOIN inventory_items i ON i.product_id = p.id
                 WHERE p.id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(disabled, (0, 9));
    }

    /// The "new item" flag is independent of availability: a product can be
    /// new and active, new and inactive, or neither, and each combination
    /// survives insert → update → read unchanged.
    #[test]
    fn is_new_is_persisted_independently_of_availability() {
        let conn = fresh();
        let category = system_category(&conn);
        let admin = admin_user(&conn);

        // Seeded products keep the safe legacy default: not new.
        assert!(list(&conn, None, false).unwrap().iter().all(|p| !p.is_new));

        let id = insert(
            &conn,
            &NewProduct {
                is_new: true,
                ..new_product(category, false, 0, admin)
            },
        )
        .unwrap();
        assert!(get(&conn, id).unwrap().unwrap().is_new);

        // Turning it off persists, and availability stays independent.
        update(
            &conn,
            id,
            "Test Item",
            category,
            1000,
            false,
            None,
            None,
            false,
            admin,
        )
        .unwrap();
        let after = get(&conn, id).unwrap().unwrap();
        assert!(!after.is_new && after.is_active);

        set_active(&conn, id, false).unwrap();
        let disabled = get(&conn, id).unwrap().unwrap();
        assert!(!disabled.is_new && !disabled.is_active);
    }
}
