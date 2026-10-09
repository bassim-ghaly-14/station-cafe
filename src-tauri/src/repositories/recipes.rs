//! Raw-material inventory + product recipes repository.
//!
//! This domain sits BESIDE product inventory, not on top of it. A raw material
//! (Coffee Beans, Sugar, Milk) is consumed through recipes; a tracked PRODUCT
//! keeps its own stock in `inventory_items`. The two never share a table.
//!
//! # One authoritative source of truth
//!
//! `raw_materials.current_quantity` is the live balance, updated transactionally
//! TOGETHER with every `raw_material_movements` row by [`apply_movement`] — the
//! single controlled write path. There is no second cached balance and no
//! read-side recompute, so the two can never diverge.
//!
//! # Movement vocabulary
//!
//! A raw-material balance never changes silently. Every change is one movement
//! with a reason from the closed set `PURCHASE | SALE_CONSUMPTION | WASTE |
//! ADJUSTMENT`. There is no generic hidden decrement.

use crate::error::{AppError, AppResult};
use crate::repositories::Db;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A raw material: a consumable identity measured in a NORMALIZED base unit.
///
/// `current_quantity` is the authoritative live balance (grams or milliliters).
/// `last_purchase_unit_cost_minor` is the latest PER-BASE-UNIT cost from the
/// most recent purchase — an INFORMATIONAL display basis for Recipe Cost only,
/// never accounting truth and never a valuation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawMaterial {
    pub id: i64,
    pub name: String,
    pub department: String,
    /// `GRAM` or `MILLILITER` — the internal normalized unit.
    pub base_unit: String,
    /// Live balance in base units. Authoritative; never negative.
    pub current_quantity: i64,
    /// Latest per-base-unit cost in minor units, informational only.
    pub last_purchase_unit_cost_minor: Option<i64>,
    pub is_active: bool,
    pub created_at: String,
}

const MATERIAL_COLS: &str =
    "id, name, department, base_unit, current_quantity, last_purchase_unit_cost_minor, is_active, created_at";

fn material_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RawMaterial> {
    Ok(RawMaterial {
        id: r.get(0)?,
        name: r.get(1)?,
        department: r.get(2)?,
        base_unit: r.get(3)?,
        current_quantity: r.get(4)?,
        last_purchase_unit_cost_minor: r.get(5)?,
        is_active: r.get::<_, i64>(6)? != 0,
        created_at: r.get(7)?,
    })
}

/// The closed movement vocabulary a raw-material balance can change by.
pub const MOVEMENT_REASONS: &[&str] = &["PURCHASE", "SALE_CONSUMPTION", "WASTE", "ADJUSTMENT"];

/// A material manager input. Creation starts at zero stock; stock arrives only
/// through an explicit PURCHASE movement (see the service).
#[derive(Debug, Clone, Deserialize)]
pub struct NewMaterial {
    pub name: String,
    pub department: String,
    pub base_unit: String,
}

pub fn list_materials(conn: &Db, active_only: bool) -> AppResult<Vec<RawMaterial>> {
    let mut sql = format!("SELECT {MATERIAL_COLS} FROM raw_materials WHERE deleted_at IS NULL");
    if active_only {
        sql.push_str(" AND is_active = 1");
    }
    sql.push_str(" ORDER BY department, name");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], material_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get_material(conn: &Db, id: i64) -> AppResult<Option<RawMaterial>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MATERIAL_COLS} FROM raw_materials WHERE deleted_at IS NULL AND id = ?1"
    ))?;
    let mut rows = stmt.query([id])?;
    match rows.next()? {
        Some(r) => Ok(Some(material_row(r)?)),
        None => Ok(None),
    }
}

/// The live balance of one material, or `None` when it does not exist.
pub fn current_quantity(conn: &Db, id: i64) -> AppResult<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT current_quantity FROM raw_materials WHERE deleted_at IS NULL AND id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?)
}

/// Insert a material with zero stock. The caller owns the transaction.
pub fn insert_material(conn: &Db, p: &NewMaterial) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO raw_materials (name, department, base_unit, current_quantity)
         VALUES (?1, ?2, ?3, 0)",
        params![p.name, p.department, p.base_unit],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Rename / re-department / conditionally re-unit a material.
/// Quantity is NOT touched here — it changes only through a movement.
/// A base-unit change is allowed ONLY while the material has zero balance
/// AND is referenced by no recipe; otherwise existing quantities would be
/// silently reinterpreted (2000 g becoming 2000 ml). Enforced atomically
/// in the same statement so a concurrent purchase/recipe cannot slip in.
pub fn update_material(
    conn: &Db,
    id: i64,
    name: &str,
    department: &str,
    base_unit: &str,
) -> AppResult<bool> {
    let changed = conn.execute(
        "UPDATE raw_materials
         SET name = ?2, department = ?3, base_unit = ?4, updated_at = station_now()
         WHERE id = ?1 AND deleted_at IS NULL
           AND (base_unit = ?4
                OR (current_quantity = 0
                    AND NOT EXISTS (SELECT 1 FROM product_recipe_items WHERE raw_material_id = ?1)))",
        params![id, name, department, base_unit],
    )?;
    Ok(changed > 0)
}

/// Whether an attempted base-unit change was refused by the atomic guard
/// (material exists but has stock or recipe references).
pub fn base_unit_locked(conn: &Db, id: i64, base_unit: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM raw_materials
          WHERE id = ?1 AND deleted_at IS NULL AND base_unit != ?2
            AND (current_quantity != 0
                 OR EXISTS (SELECT 1 FROM product_recipe_items WHERE raw_material_id = ?1)))",
        params![id, base_unit],
        |r| r.get(0),
    )?)
}

/// Soft-delete a material. History (movements) is preserved by keeping the row;
/// it simply leaves the active catalog.
pub fn archive_material(conn: &Db, id: i64) -> AppResult<bool> {
    let changed = conn.execute(
        "UPDATE raw_materials
         SET deleted_at = station_now(), is_active = 0, updated_at = station_now()
         WHERE id = ?1 AND deleted_at IS NULL",
        [id],
    )?;
    Ok(changed > 0)
}

/// Is the material currently referenced by any product recipe?
pub fn material_in_use(conn: &Db, id: i64) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM product_recipe_items WHERE raw_material_id = ?1)",
        [id],
        |r| r.get(0),
    )?)
}

/// THE single controlled write path for a raw-material balance.
///
/// It reads the current balance, computes the new one, refuses to go negative,
/// updates `current_quantity` and writes ONE movement row — all inside the
/// caller's transaction, so the balance and the ledger can never diverge. There
/// is no silent path: a change always carries a legitimate reason.
///
/// Returns the new balance.
#[allow(clippy::too_many_arguments)]
pub fn apply_movement(
    conn: &Db,
    raw_material_id: i64,
    change: i64,
    reason: &str,
    note: Option<&str>,
    ref_invoice_id: Option<i64>,
    expense_id: Option<i64>,
    user_id: i64,
) -> AppResult<i64> {
    if change == 0 {
        return Err(AppError::validation("rawmaterials.zero_change"));
    }
    if !MOVEMENT_REASONS.contains(&reason) {
        return Err(AppError::validation("rawmaterials.invalid_reason"));
    }
    let current: i64 = current_quantity(conn, raw_material_id)?
        .ok_or_else(|| AppError::not_found("rawmaterials.not_found"))?;
    let new_quantity = current
        .checked_add(change)
        .ok_or_else(|| AppError::internal("rawmaterials.quantity_overflow"))?;
    if new_quantity < 0 {
        return Err(AppError::business("rawmaterials.insufficient_material"));
    }
    conn.execute(
        "UPDATE raw_materials SET current_quantity = ?2, updated_at = station_now()
         WHERE id = ?1 AND deleted_at IS NULL",
        params![raw_material_id, new_quantity],
    )?;
    conn.execute(
        "INSERT INTO raw_material_movements
            (raw_material_id, change, reason, note, ref_invoice_id, expense_id, user_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            raw_material_id,
            change,
            reason,
            note,
            ref_invoice_id,
            expense_id,
            user_id
        ],
    )?;
    Ok(new_quantity)
}

/// A movement row joined to its material and the actor who made it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawMaterialMovement {
    pub id: i64,
    pub raw_material_id: i64,
    pub raw_material_name: String,
    pub base_unit: String,
    pub change: i64,
    pub reason: String,
    pub note: Option<String>,
    pub ref_invoice_id: Option<i64>,
    pub expense_id: Option<i64>,
    pub user_name: Option<String>,
    pub created_at: String,
}

const MOVEMENT_COLS: &str = "m.id, m.raw_material_id, r.name, r.base_unit, m.change, m.reason,
    m.note, m.ref_invoice_id, m.expense_id, u.name, m.created_at";

fn movement_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RawMaterialMovement> {
    Ok(RawMaterialMovement {
        id: r.get(0)?,
        raw_material_id: r.get(1)?,
        raw_material_name: r.get(2)?,
        base_unit: r.get(3)?,
        change: r.get(4)?,
        reason: r.get(5)?,
        note: r.get(6)?,
        ref_invoice_id: r.get(7)?,
        expense_id: r.get(8)?,
        user_name: r.get(9)?,
        created_at: r.get(10)?,
    })
}

/// The most recent movements, optionally scoped to one material, newest first.
pub fn list_movements(
    conn: &Db,
    material_id: Option<i64>,
    limit: i64,
) -> AppResult<Vec<RawMaterialMovement>> {
    let sql = format!(
        "SELECT {MOVEMENT_COLS}
         FROM raw_material_movements m
         JOIN raw_materials r ON r.id = m.raw_material_id
         LEFT JOIN users u ON u.id = m.user_id
         WHERE (?1 IS NULL OR m.raw_material_id = ?1)
         ORDER BY m.id DESC LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![material_id, limit], movement_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// A recipe line: the raw materials ONE unit of a product consumes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeItem {
    pub id: i64,
    pub product_id: i64,
    pub raw_material_id: i64,
    pub raw_material_name: String,
    pub base_unit: String,
    /// Base units (grams/ml) consumed by ONE unit of the product.
    pub quantity_base: i64,
    /// The material's latest per-base-unit cost, for informational Recipe Cost.
    pub last_purchase_unit_cost_minor: Option<i64>,
}

const RECIPE_COLS: &str = "ri.id, ri.product_id, ri.raw_material_id, r.name, r.base_unit,
    ri.quantity_base, r.last_purchase_unit_cost_minor";

fn recipe_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RecipeItem> {
    Ok(RecipeItem {
        id: r.get(0)?,
        product_id: r.get(1)?,
        raw_material_id: r.get(2)?,
        raw_material_name: r.get(3)?,
        base_unit: r.get(4)?,
        quantity_base: r.get(5)?,
        last_purchase_unit_cost_minor: r.get(6)?,
    })
}

/// The recipe of a product, resolved by the STABLE product id (never a name).
pub fn get_recipe(conn: &Db, product_id: i64) -> AppResult<Vec<RecipeItem>> {
    let sql = format!(
        "SELECT {RECIPE_COLS}
         FROM product_recipe_items ri
         JOIN raw_materials r ON r.id = ri.raw_material_id
         WHERE ri.product_id = ?1
         ORDER BY r.name"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([product_id], recipe_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Does a product have ANY recipe rows? Drives the catalog `has_recipe` signal.
pub fn has_recipe(conn: &Db, product_id: i64) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM product_recipe_items WHERE product_id = ?1)",
        [product_id],
        |r| r.get(0),
    )?)
}

/// The set of (raw_material_id, quantity_base) a recipe is being set to.
pub struct RecipeInput {
    pub raw_material_id: i64,
    pub quantity_base: i64,
}

/// Replace a product's entire recipe atomically: delete the old rows, insert
/// the new. The caller owns the transaction.
///
/// An empty `items` clears the recipe — a tracked product may have no recipe.
pub fn set_recipe(conn: &Db, product_id: i64, items: &[RecipeInput]) -> AppResult<()> {
    conn.execute(
        "DELETE FROM product_recipe_items WHERE product_id = ?1",
        [product_id],
    )?;
    for item in items {
        if item.quantity_base <= 0 {
            return Err(AppError::validation("rawmaterials.invalid_quantity"));
        }
        conn.execute(
            "INSERT INTO product_recipe_items (product_id, raw_material_id, quantity_base)
             VALUES (?1, ?2, ?3)",
            params![product_id, item.raw_material_id, item.quantity_base],
        )?;
    }
    Ok(())
}

/// Aggregate the raw-material requirements of a set of order lines, keyed by
/// raw_material_id, resolving recipes by STABLE product_id.
///
/// Only products that actually have a recipe contribute. Lines that share a
/// material (Coffee and Tea both needing Sugar) are SUMMED here, which is what
/// makes a shared-material sale validate against the true total. Returns an
/// empty map when no ordered product has a recipe.
pub fn collect_requirements(
    conn: &Db,
    lines: &[(i64, i64)], // (product_id, quantity)
) -> AppResult<HashMap<i64, i64>> {
    let mut requirements: HashMap<i64, i64> = HashMap::new();
    for (product_id, line_qty) in lines {
        if *line_qty <= 0 {
            continue;
        }
        let mut stmt = conn.prepare(
            "SELECT raw_material_id, quantity_base
             FROM product_recipe_items WHERE product_id = ?1",
        )?;
        let rows = stmt.query_map([product_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (material_id, per_unit) = row?;
            let needed = per_unit
                .checked_mul(*line_qty)
                .ok_or_else(|| AppError::internal("rawmaterials.quantity_overflow"))?;
            let entry = requirements.entry(material_id).or_insert(0);
            *entry = entry
                .checked_add(needed)
                .ok_or_else(|| AppError::internal("rawmaterials.quantity_overflow"))?;
        }
    }
    Ok(requirements)
}

/// The current balances of the given materials, keyed by id. Used to validate
/// an aggregated requirement before applying any consumption.
pub fn current_quantities(conn: &Db, material_ids: &[i64]) -> AppResult<HashMap<i64, i64>> {
    let mut out = HashMap::new();
    for id in material_ids {
        if let Some(q) = current_quantity(conn, *id)? {
            out.insert(*id, q);
        }
    }
    Ok(out)
}
