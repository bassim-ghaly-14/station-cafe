//! Raw-material + recipe business rules.
//!
//! Raw materials are a domain BESIDE product inventory. This service owns every
//! rule that is not SQL: role gates, unit normalization, the atomic purchase
//! (stock + movement + expense), and the checkout consumption engine.
//!
//! # Units
//!
//! A manager works in the unit they bought in (KG, L, g, ml). The service
//! NORMALIZES to the material's base unit (GRAM or MILLILITER) with integer
//! arithmetic — never floats, never string parsing — and stores the base-unit
//! quantity. Purchase cost is entered as the TOTAL for the purchase, so the
//! amount is unambiguous and can never be multiplied twice by the base
//! quantity.
//!
//! # Purchase cost is informational
//!
//! `last_purchase_unit_cost_minor` (per base unit) is recorded for display of
//! Recipe Cost only. It is NOT accounting truth and never rewrites a historical
//! expense.

use crate::error::{AppError, AppResult};
use crate::repositories::expenses;
use crate::repositories::recipes::{
    self, NewMaterial, RawMaterial, RawMaterialMovement, RecipeInput, RecipeItem,
};
use crate::repositories::{catalog, Db};
use crate::services::audit;
use crate::services::auth::{require_role, User};
use std::collections::HashMap;

/// Purchase units a manager may select, and their factor to the base unit.
///
/// A material's base unit is GRAM or MILLILITER. Mass units normalize to grams,
/// volume units to milliliters. This is the ONLY place a unit is converted.
fn unit_factor(unit: &str) -> AppResult<i64> {
    match unit {
        "GRAM" | "MILLILITER" => Ok(1),
        "KILOGRAM" | "LITER" => Ok(1000),
        _ => Err(AppError::validation("rawmaterials.invalid_unit")),
    }
}

/// The base unit a purchase unit belongs to (`GRAM` family or `MILLILITER`).
fn unit_family(unit: &str) -> AppResult<&'static str> {
    match unit {
        "GRAM" | "KILOGRAM" => Ok("GRAM"),
        "MILLILITER" | "LITER" => Ok("MILLILITER"),
        _ => Err(AppError::validation("rawmaterials.invalid_unit")),
    }
}

fn validate_base_unit(base_unit: &str) -> AppResult<()> {
    if !matches!(base_unit, "GRAM" | "MILLILITER") {
        return Err(AppError::validation("rawmaterials.invalid_unit"));
    }
    Ok(())
}

fn validate_department(department: &str) -> AppResult<()> {
    if !matches!(department, "CAFE" | "WASH") {
        return Err(AppError::validation("catalog.invalid_department"));
    }
    Ok(())
}

fn material_name(name: &str) -> AppResult<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::validation("rawmaterials.name_required"));
    }
    Ok(trimmed)
}

// ---- reads -----------------------------------------------------------------

pub fn list_materials(conn: &Db, active_only: bool) -> AppResult<Vec<RawMaterial>> {
    recipes::list_materials(conn, active_only)
}

pub fn get_material(conn: &Db, id: i64) -> AppResult<RawMaterial> {
    recipes::get_material(conn, id)?.ok_or_else(|| AppError::not_found("rawmaterials.not_found"))
}

pub fn list_movements(
    conn: &Db,
    material_id: Option<i64>,
    limit: i64,
) -> AppResult<Vec<RawMaterialMovement>> {
    recipes::list_movements(conn, material_id, limit.clamp(1, 500))
}

// ---- material lifecycle (MANAGER) -----------------------------------------

/// MANAGER+ create of a raw material. It starts with ZERO stock; stock arrives
/// only through an explicit purchase. Returns the new id.
pub fn create_material(conn: &Db, actor: &User, input: &NewMaterial) -> AppResult<i64> {
    require_role(actor, "MANAGER")?;
    let name = material_name(&input.name)?;
    validate_department(&input.department)?;
    validate_base_unit(&input.base_unit)?;

    let tx = conn.unchecked_transaction()?;
    let id = recipes::insert_material(
        &tx,
        &NewMaterial {
            name: name.to_string(),
            department: input.department.clone(),
            base_unit: input.base_unit.clone(),
        },
    )?;
    audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "rawmaterials.created",
        "raw_material",
        Some(&id.to_string()),
        None,
        Some(&serde_json::json!({
            "name": name, "department": input.department, "base_unit": input.base_unit
        })),
    )?;
    tx.commit()?;
    Ok(id)
}

/// MANAGER+ rename / re-department / conditionally re-unit.
/// Quantity is untouched (it changes only through a movement).
/// A base-unit change on a stocked or recipe-referenced material is refused
/// with `rawmaterials.unit_locked` so quantities are never reinterpreted.
pub fn update_material(conn: &Db, actor: &User, id: i64, input: &NewMaterial) -> AppResult<()> {
    require_role(actor, "MANAGER")?;
    let name = material_name(&input.name)?;
    validate_department(&input.department)?;
    validate_base_unit(&input.base_unit)?;

    let before = get_material(conn, id)?;
    if !recipes::update_material(conn, id, name, &input.department, &input.base_unit)? {
        if recipes::base_unit_locked(conn, id, &input.base_unit)? {
            return Err(AppError::business("rawmaterials.unit_locked"));
        }
        return Err(AppError::not_found("rawmaterials.not_found"));
    }
    audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "rawmaterials.updated",
        "raw_material",
        Some(&id.to_string()),
        Some(&serde_json::json!({
            "name": before.name, "department": before.department, "base_unit": before.base_unit
        })),
        Some(&serde_json::json!({
            "name": name, "department": input.department, "base_unit": input.base_unit
        })),
    )?;
    Ok(())
}

/// MANAGER+ archive. A material still used by a recipe is refused so the manager
/// clears the recipe first, instead of silently leaving a dangling reference.
pub fn archive_material(conn: &Db, actor: &User, id: i64) -> AppResult<()> {
    require_role(actor, "MANAGER")?;
    let before = get_material(conn, id)?;
    if recipes::material_in_use(conn, id)? {
        return Err(AppError::business("rawmaterials.in_use"));
    }
    if !recipes::archive_material(conn, id)? {
        return Err(AppError::not_found("rawmaterials.not_found"));
    }
    audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "rawmaterials.archived",
        "raw_material",
        Some(&id.to_string()),
        Some(&serde_json::json!({ "name": before.name, "is_active": before.is_active })),
        Some(&serde_json::json!({ "is_active": false })),
    )?;
    Ok(())
}

// ---- purchase (atomic: stock + movement + expense) ------------------------
// The purchase expense reuses the SHARED `ops::create_expense` placement
// rules (same business-date, shift and day linkage as every other expense).
// It runs on THIS transaction so purchase/stock/expense/movement/audit
// commit or roll back together; the shared service owns its own boundary,
// so the repository insert is called directly with the resolved placement.

/// The expense placement of a raw-material purchase: the business date, the day
/// and the shift it belongs to. Mirrors the existing expense rules — a cash
/// expense attaches to the actor's open shift, and a manager with no open shift
/// records a day-level expense instead.
struct PurchasePlacement {
    expense_date: String,
    shift_id: Option<i64>,
    business_day_id: Option<i64>,
}

fn resolve_purchase_placement(conn: &Db, actor: &User) -> AppResult<PurchasePlacement> {
    let day = crate::repositories::shifts::current_day(conn)?;
    let open_shift = crate::repositories::shifts::active_shift_for(conn, actor.id)?;
    let date = crate::services::auth::sqlite_today();
    crate::services::attendance::validate_business_date(&date)?;
    Ok(PurchasePlacement {
        expense_date: date,
        shift_id: open_shift.map(|s| s.id),
        business_day_id: day.map(|d| d.id),
    })
}

/// The latest PER-BASE-UNIT cost (minor per gram/ml) implied by a purchase.
///
/// Informational only. Integer division with half-up rounding so a displayed
/// recipe cost never drifts from the sum of its parts by a rounding direction.
fn per_unit_cost(total_cost_minor: i64, normalized_qty: i64) -> AppResult<i64> {
    if normalized_qty <= 0 {
        return Err(AppError::validation("rawmaterials.invalid_quantity"));
    }
    Ok(crate::money::div_round(total_cost_minor, normalized_qty))
}

/// A raw-material purchase input. `quantity` is in `purchase_unit`; the total
/// cost is entered explicitly so it can never be double-scaled by the
/// normalized base quantity.
#[derive(Debug, serde::Deserialize)]
pub struct PurchaseInput {
    pub raw_material_id: i64,
    pub quantity: i64,
    pub purchase_unit: String,
    /// The TOTAL amount paid for this purchase, in minor units (piasters).
    pub total_cost_minor: i64,
    pub note: Option<String>,
}

/// MANAGER+ purchase of a raw material. ONE transaction does all three, or none:
///
///   1. increase raw-material stock (a PURCHASE movement),
///   2. record the purchase cost (updates the informational per-unit cost),
///   3. create the corresponding SUPPLIES Expense.
///
/// The movement row carries the created `expense_id`, so the purchase ↔ expense
/// link lives on the movement side. The expense is a normal existing Expense —
/// no generic metadata column.
pub fn purchase_material(conn: &Db, actor: &User, input: &PurchaseInput) -> AppResult<()> {
    require_role(actor, "MANAGER")?;
    if input.quantity <= 0 {
        return Err(AppError::validation("rawmaterials.invalid_quantity"));
    }
    if input.total_cost_minor <= 0 {
        return Err(AppError::validation("expenses.invalid_amount"));
    }

    let material = get_material(conn, input.raw_material_id)?;
    // The purchase unit must belong to the same family as the material's base
    // unit: you buy mass for a gram material, volume for a milliliter one.
    if unit_family(&input.purchase_unit)? != material.base_unit {
        return Err(AppError::validation("rawmaterials.unit_mismatch"));
    }
    let factor = unit_factor(&input.purchase_unit)?;
    let normalized = input
        .quantity
        .checked_mul(factor)
        .ok_or_else(|| AppError::internal("rawmaterials.quantity_overflow"))?;
    let unit_cost = per_unit_cost(input.total_cost_minor, normalized)?;

    let tx = conn.unchecked_transaction()?;
    let placement = resolve_purchase_placement(&tx, actor)?;

    // The SUPPLIES category is the existing expense category for purchases. It
    // is validated as active so a disabled category can never absorb a purchase.
    if !expenses::category_is_active(&tx, "SUPPLIES")? {
        return Err(AppError::validation("expenses.invalid_category"));
    }
    let description = format!(
        "شراء {}: {} {}",
        material.name, input.quantity, input.purchase_unit
    );
    let expense_id = expenses::insert(
        &tx,
        "SUPPLIES",
        input.total_cost_minor,
        Some(&description),
        &placement.expense_date,
        false,
        None,
        placement.business_day_id,
        placement.shift_id,
        true, // money physically leaves the drawer
        actor.id,
        None,
    )?;

    // Increase stock + write the PURCHASE movement referencing the expense.
    recipes::apply_movement(
        &tx,
        input.raw_material_id,
        normalized,
        "PURCHASE",
        input.note.as_deref().or(Some(&description)),
        None,
        Some(expense_id),
        actor.id,
    )?;

    // Record the informational latest per-base-unit cost.
    tx.execute(
        "UPDATE raw_materials
         SET last_purchase_unit_cost_minor = ?2, updated_at = station_now()
         WHERE id = ?1",
        rusqlite::params![input.raw_material_id, unit_cost],
    )?;

    audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "rawmaterials.purchased",
        "raw_material",
        Some(&input.raw_material_id.to_string()),
        None,
        Some(&serde_json::json!({
            "name": material.name,
            "quantity": input.quantity,
            "purchase_unit": input.purchase_unit,
            "normalized": normalized,
            "base_unit": material.base_unit,
            "total_cost_minor": input.total_cost_minor,
            "expense_id": expense_id
        })),
    )?;
    tx.commit()?;
    Ok(())
}

// ---- manual adjustments & waste (MANAGER) --------------------------------

/// MANAGER+ manual ADJUSTMENT. Positive or negative; a negative that would go
/// below zero is refused by the movement guard, so final stock is never negative.
pub fn adjust_material(
    conn: &Db,
    actor: &User,
    material_id: i64,
    change: i64,
    note: Option<&str>,
) -> AppResult<()> {
    require_role(actor, "MANAGER")?;
    if change == 0 {
        return Err(AppError::validation("rawmaterials.zero_change"));
    }
    let material = get_material(conn, material_id)?;
    let tx = conn.unchecked_transaction()?;
    recipes::apply_movement(&tx, material_id, change, "ADJUSTMENT", note, None, None, actor.id)?;
    audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "rawmaterials.adjusted",
        "raw_material",
        Some(&material_id.to_string()),
        None,
        Some(&serde_json::json!({ "name": material.name, "change": change, "note": note })),
    )?;
    tx.commit()?;
    Ok(())
}

/// MANAGER+ WASTE: always a decrease, always with a reason recorded.
pub fn waste_material(
    conn: &Db,
    actor: &User,
    material_id: i64,
    quantity: i64,
    note: Option<&str>,
) -> AppResult<()> {
    require_role(actor, "MANAGER")?;
    if quantity <= 0 {
        return Err(AppError::validation("rawmaterials.invalid_quantity"));
    }
    let material = get_material(conn, material_id)?;
    let tx = conn.unchecked_transaction()?;
    recipes::apply_movement(
        &tx,
        material_id,
        -quantity,
        "WASTE",
        note,
        None,
        None,
        actor.id,
    )?;
    audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "rawmaterials.wasted",
        "raw_material",
        Some(&material_id.to_string()),
        None,
        Some(&serde_json::json!({ "name": material.name, "quantity": quantity, "note": note })),
    )?;
    tx.commit()?;
    Ok(())
}

// ---- recipes (MANAGER) -----------------------------------------------------

pub fn get_recipe(conn: &Db, product_id: i64) -> AppResult<Vec<RecipeItem>> {
    recipes::get_recipe(conn, product_id)
}

/// The recipe lines with the INFORMATIONAL cost of each and the total.
///
/// Recipe Cost = Σ(quantity_base × latest per-base-unit cost). It is a display
/// estimate from the LATEST known unit cost — not accounting truth, not a
/// valuation, and it never touches historical expenses.
#[derive(Debug, serde::Serialize)]
pub struct RecipeCostLine {
    pub raw_material_id: i64,
    pub raw_material_name: String,
    pub base_unit: String,
    pub quantity_base: i64,
    pub unit_cost_minor: Option<i64>,
    pub cost_minor: Option<i64>,
}

#[derive(Debug, serde::Serialize)]
pub struct RecipeCostView {
    pub product_id: i64,
    pub lines: Vec<RecipeCostLine>,
    /// Total informational cost, `None` when any line lacks a known unit cost.
    pub total_cost_minor: Option<i64>,
}

pub fn recipe_cost(conn: &Db, product_id: i64) -> AppResult<RecipeCostView> {
    let items = recipes::get_recipe(conn, product_id)?;
    let mut lines = Vec::new();
    let mut total: Option<i64> = Some(0);
    for item in items {
        // Informational display only: saturating math keeps an extreme stored
        // quantity from panicking the catalog dialog; checkout uses the
        // checked engine, never this estimate.
        let line_cost = item
            .last_purchase_unit_cost_minor
            .map(|unit| unit.saturating_mul(item.quantity_base));
        total = match (total, line_cost) {
            (Some(acc), Some(c)) => Some(acc.saturating_add(c)),
            _ => None,
        };
        lines.push(RecipeCostLine {
            raw_material_id: item.raw_material_id,
            raw_material_name: item.raw_material_name,
            base_unit: item.base_unit,
            quantity_base: item.quantity_base,
            unit_cost_minor: item.last_purchase_unit_cost_minor,
            cost_minor: line_cost,
        });
    }
    Ok(RecipeCostView {
        product_id,
        lines,
        total_cost_minor: total,
    })
}

/// Read-only availability of a set of products' recipes for the POS pad.
/// Returns one row per product that HAS a recipe: the aggregated base-unit
/// requirements for ONE unit plus whether current balances cover them.
/// Products without a recipe (tracked or not) are simply absent — they sell
/// on the product-stock model alone. Batched in two queries (items + balances),
/// never one per product. Advisory only: checkout revalidates in its own
/// transaction, so a green tile never guarantees the sale.
pub fn recipe_availability(
    conn: &Db,
    product_ids: &[i64],
) -> AppResult<Vec<RecipeAvailability>> {
    let mut out = Vec::new();
    if product_ids.is_empty() {
        return Ok(out);
    }
    // One query for every recipe row of every requested product.
    let placeholders = product_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT product_id, raw_material_id, quantity_base
         FROM product_recipe_items WHERE product_id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> = product_ids
        .iter()
        .map(|id| id as &dyn rusqlite::ToSql)
        .collect();
    let rows = stmt.query_map(params.as_slice(), |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })?;
    let mut per_product: std::collections::HashMap<i64, Vec<(i64, i64)>> =
        std::collections::HashMap::new();
    let mut material_ids: Vec<i64> = Vec::new();
    for row in rows {
        let (pid, mid, qty) = row?;
        if !material_ids.contains(&mid) {
            material_ids.push(mid);
        }
        per_product.entry(pid).or_default().push((mid, qty));
    }
    if per_product.is_empty() {
        return Ok(out);
    }
    let balances = recipes::current_quantities(conn, &material_ids)?;
    let mut pids: Vec<i64> = per_product.keys().copied().collect();
    pids.sort_unstable();
    for pid in pids {
        let items = per_product.remove(&pid).unwrap_or_default();
        let mut requirements: Vec<RecipeRequirement> = Vec::new();
        let mut available = true;
        for (material_id, per_unit) in items {
            let have = balances.get(&material_id).copied().unwrap_or(0);
            if have < per_unit {
                available = false;
            }
            requirements.push(RecipeRequirement {
                raw_material_id: material_id,
                required_base: per_unit,
                available_base: have,
            });
        }
        requirements.sort_by_key(|r| r.raw_material_id);
        out.push(RecipeAvailability {
            product_id: pid,
            available,
            requirements,
        });
    }
    Ok(out)
}

/// One aggregated requirement for ONE unit of a product, with live balance.
#[derive(Debug, serde::Serialize)]
pub struct RecipeRequirement {
    pub raw_material_id: i64,
    pub required_base: i64,
    pub available_base: i64,
}

/// Advisory availability of one product's recipe for the POS pad.
#[derive(Debug, serde::Serialize)]
pub struct RecipeAvailability {
    pub product_id: i64,
    /// True when every material covers ONE unit right now. Advisory only.
    pub available: bool,
    pub requirements: Vec<RecipeRequirement>,
}

/// One editable recipe line sent by the UI.
#[derive(Debug, serde::Deserialize)]
pub struct RecipeLineInput {
    pub raw_material_id: i64,
    pub quantity_base: i64,
}

/// MANAGER+ set (replace) a product's recipe.
///
/// The product MUST have inventory tracking enabled — recipes exist ONLY for
/// tracked products. An empty list clears the recipe (a tracked product may
/// have none). Every material must exist and be active.
pub fn set_recipe(
    conn: &Db,
    actor: &User,
    product_id: i64,
    lines: &[RecipeLineInput],
) -> AppResult<()> {
    require_role(actor, "MANAGER")?;
    let product = catalog::get(conn, product_id)?
        .ok_or_else(|| AppError::not_found("catalog.item_not_found"))?;
    if !product.track_inventory {
        return Err(AppError::business("rawmaterials.product_not_tracked"));
    }

    // Deduplicate by material, summing quantities, so a repeated material in the
    // payload collapses to one row (the DB UNIQUE would otherwise reject it).
    let mut merged: HashMap<i64, i64> = HashMap::new();
    for line in lines {
        if line.quantity_base <= 0 {
            return Err(AppError::validation("rawmaterials.invalid_quantity"));
        }
        let material = recipes::get_material(conn, line.raw_material_id)?
            .ok_or_else(|| AppError::not_found("rawmaterials.not_found"))?;
        if !material.is_active {
            return Err(AppError::business("rawmaterials.inactive_material"));
        }
        // Deterministic merge: repeated lines for one material are summed with
        // checked arithmetic so a hostile payload cannot wrap the quantity.
        let entry = merged.entry(line.raw_material_id).or_insert(0);
        *entry = entry
            .checked_add(line.quantity_base)
            .ok_or_else(|| AppError::internal("rawmaterials.quantity_overflow"))?;
    }
    let items: Vec<RecipeInput> = merged
        .into_iter()
        .map(|(raw_material_id, quantity_base)| RecipeInput {
            raw_material_id,
            quantity_base,
        })
        .collect();

    let tx = conn.unchecked_transaction()?;
    recipes::set_recipe(&tx, product_id, &items)?;
    audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "rawmaterials.recipe_set",
        "product",
        Some(&product_id.to_string()),
        None,
        Some(&serde_json::json!({
            "product": product.name,
            "items": items.iter().map(|i| serde_json::json!({
                "raw_material_id": i.raw_material_id, "quantity_base": i.quantity_base
            })).collect::<Vec<_>>()
        })),
    )?;
    tx.commit()?;
    Ok(())
}

// ---- checkout consumption engine ------------------------------------------

/// Validate AND consume raw materials for a completed sale, inside the CALLER's
/// checkout transaction. This is the single point where a sale mutates
/// raw-material stock.
///
/// It resolves recipes by STABLE `product_id` (never a name), AGGREGATES shared
/// materials across all lines, validates EVERY requirement has enough stock, and
/// only then applies the `SALE_CONSUMPTION` movements linked to the invoice.
/// Because it runs inside the checkout transaction, any failure rolls the whole
/// sale back — there is never a partial consumption or a successful invoice with
/// failed raw-material consumption.
///
/// Lines whose product has no recipe contribute nothing: a tracked product
/// without a recipe, and any untracked product, is simply unaffected.
pub fn consume_for_sale(
    conn: &Db,
    lines: &[(i64, i64)], // (product_id, quantity) from order.lines — stable ids
    invoice_id: i64,
    user_id: i64,
) -> AppResult<()> {
    let requirements = recipes::collect_requirements(conn, lines)?;
    if requirements.is_empty() {
        return Ok(());
    }

    // Validate EVERY material's availability BEFORE applying any mutation, so a
    // shortage anywhere blocks the whole sale rather than consuming part of it.
    let material_ids: Vec<i64> = requirements.keys().copied().collect();
    let balances = recipes::current_quantities(conn, &material_ids)?;
    for (material_id, needed) in &requirements {
        let available = balances.get(material_id).copied().unwrap_or(0);
        if available < *needed {
            return Err(AppError::business("rawmaterials.insufficient_material"));
        }
    }

    // All validated — apply the consumption. Deterministic order (by id) so the
    // movement rows are written in a stable sequence.
    let mut ordered: Vec<(i64, i64)> = requirements.into_iter().collect();
    ordered.sort_by_key(|(id, _)| *id);
    for (material_id, needed) in ordered {
        recipes::apply_movement(
            conn,
            material_id,
            -needed,
            "SALE_CONSUMPTION",
            None,
            Some(invoice_id),
            None,
            user_id,
        )?;
    }
    Ok(())
}
