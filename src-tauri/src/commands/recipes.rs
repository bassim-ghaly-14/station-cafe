// Tauri commands — raw materials, movements and product recipes.
//
// Every command here is MANAGER-gated: the Raw Materials workspace lives on the
// manager-only Inventory page, and the service re-checks the role so a direct
// command invocation can never bypass it.

use super::common::authorized;
use crate::error::AppResult;
use crate::repositories::recipes::{NewMaterial, RawMaterial, RawMaterialMovement, RecipeItem};
use crate::services::recipes::{
    self as recipes_svc, PurchaseInput, RecipeAvailability, RecipeCostView, RecipeLineInput,
};
use crate::AppState;
use tauri::State;

#[tauri::command(rename_all = "snake_case")]
pub fn list_raw_materials(
    state: State<'_, AppState>,
    token: String,
    active_only: bool,
) -> AppResult<Vec<RawMaterial>> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        recipes_svc::list_materials(conn, active_only)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn create_raw_material(
    state: State<'_, AppState>,
    token: String,
    input: NewMaterial,
) -> AppResult<i64> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        recipes_svc::create_material(conn, actor, &input)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn update_raw_material(
    state: State<'_, AppState>,
    token: String,
    material_id: i64,
    input: NewMaterial,
) -> AppResult<()> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        recipes_svc::update_material(conn, actor, material_id, &input)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn archive_raw_material(
    state: State<'_, AppState>,
    token: String,
    material_id: i64,
) -> AppResult<()> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        recipes_svc::archive_material(conn, actor, material_id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn purchase_raw_material(
    state: State<'_, AppState>,
    token: String,
    input: PurchaseInput,
) -> AppResult<()> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        recipes_svc::purchase_material(conn, actor, &input)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn adjust_raw_material(
    state: State<'_, AppState>,
    token: String,
    material_id: i64,
    change: i64,
    note: Option<String>,
) -> AppResult<()> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        recipes_svc::adjust_material(conn, actor, material_id, change, note.as_deref())
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn waste_raw_material(
    state: State<'_, AppState>,
    token: String,
    material_id: i64,
    quantity: i64,
    note: Option<String>,
) -> AppResult<()> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        recipes_svc::waste_material(conn, actor, material_id, quantity, note.as_deref())
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_raw_material_movements(
    state: State<'_, AppState>,
    token: String,
    material_id: Option<i64>,
    limit: i64,
) -> AppResult<Vec<RawMaterialMovement>> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        recipes_svc::list_movements(conn, material_id, limit)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_product_recipe(
    state: State<'_, AppState>,
    token: String,
    product_id: i64,
) -> AppResult<Vec<RecipeItem>> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        recipes_svc::get_recipe(conn, product_id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_recipe_cost(
    state: State<'_, AppState>,
    token: String,
    product_id: i64,
) -> AppResult<RecipeCostView> {
    authorized(&state, &token, "MANAGER", move |conn, _| {
        recipes_svc::recipe_cost(conn, product_id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_product_recipe(
    state: State<'_, AppState>,
    token: String,
    product_id: i64,
    lines: Vec<RecipeLineInput>,
) -> AppResult<()> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        recipes_svc::set_recipe(conn, actor, product_id, &lines)
    })
}

/// Batched advisory recipe availability for the POS pad. Any authenticated
/// role may read it (cashiers need it); checkout still revalidates.
#[tauri::command(rename_all = "snake_case")]
pub fn recipe_availability(
    state: State<'_, AppState>,
    token: String,
    product_ids: Vec<i64>,
) -> AppResult<Vec<RecipeAvailability>> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        recipes_svc::recipe_availability(conn, &product_ids)
    })
}
