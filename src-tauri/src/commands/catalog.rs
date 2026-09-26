// Tauri commands — product & service catalog.

use super::common::authorized;
use crate::error::{AppError, AppResult};
use crate::repositories::catalog::{self, Category, Product};
use crate::services::settings::{DiscountOptionsConfig, ServiceChargeConfig};
use crate::AppState;
use serde::Deserialize;
use tauri::State;

#[derive(Deserialize)]
pub struct ProductInput {
    pub name: String,
    pub item_type: String,
    pub department: String,
    pub category_id: i64,
    pub price_minor: i64,
    pub track_inventory: bool,
    /// Opening/current stock quantity. Ignored when `track_inventory` is false.
    pub stock_quantity: Option<i64>,
}

/// POS reads the sellable catalog (active items only).
#[tauri::command(rename_all = "snake_case")]
pub fn list_products(
    state: State<'_, AppState>,
    token: String,
    department: Option<String>,
    active_only: bool,
) -> AppResult<Vec<Product>> {
    authorized(&state, &token, "STAFF", |conn, _| {
        catalog::list(conn, department.as_deref(), active_only)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn create_product(
    state: State<'_, AppState>,
    token: String,
    input: ProductInput,
) -> AppResult<i64> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::validation("catalog.name_required"));
    }
    if !["PRODUCT", "SERVICE"].contains(&input.item_type.as_str()) {
        return Err(AppError::validation("catalog.invalid_type"));
    }
    if !["CAFE", "WASH"].contains(&input.department.as_str()) {
        return Err(AppError::validation("catalog.invalid_department"));
    }
    if input.price_minor < 0 {
        return Err(AppError::validation("catalog.invalid_price"));
    }
    if input.category_id <= 0 {
        return Err(AppError::validation("catalog.category_required"));
    }
    if input.stock_quantity.is_some_and(|quantity| quantity < 0) {
        return Err(AppError::validation("catalog.invalid_stock"));
    }
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        if !catalog::category_exists(conn, input.category_id)? {
            return Err(AppError::validation("catalog.category_not_found"));
        }
        let id = catalog::insert(
            conn,
            &catalog::NewProduct {
                name: &name,
                item_type: &input.item_type,
                department: &input.department,
                category_id: input.category_id,
                price_minor: input.price_minor,
                track_inventory: input.track_inventory,
                stock_quantity: input.stock_quantity.unwrap_or(0),
                user_id: actor.id,
            },
        )?;
        crate::services::audit::record(
            conn,
            Some(actor.id),
            Some(&actor.role),
            "catalog.product_created",
            "product",
            Some(&id.to_string()),
            None,
            Some(&serde_json::json!({
                "name": name, "price_minor": input.price_minor,
                "department": input.department, "type": input.item_type,
                "category_id": input.category_id, "track_inventory": input.track_inventory,
                "stock_quantity": input.stock_quantity
            })),
        )?;
        Ok(id)
    })
}

/// Create a category available to mandatory product/service assignment.
#[tauri::command(rename_all = "snake_case")]
pub fn create_category(state: State<'_, AppState>, token: String, name: String) -> AppResult<i64> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::validation("catalog.category_name_required"));
    }
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        if catalog::category_name_exists(conn, &name)? {
            return Err(AppError::validation("catalog.category_name_taken"));
        }
        let id = catalog::insert_category(conn, &name)?;
        crate::services::audit::record(
            conn,
            Some(actor.id),
            Some(&actor.role),
            "catalog.category_created",
            "category",
            Some(&id.to_string()),
            None,
            Some(&serde_json::json!({ "name": name })),
        )?;
        Ok(id)
    })
}

/// Categories available for mandatory product/service assignment.
#[tauri::command(rename_all = "snake_case")]
pub fn list_categories(state: State<'_, AppState>, token: String) -> AppResult<Vec<Category>> {
    authorized(&state, &token, "STAFF", |conn, _| {
        catalog::list_categories(conn)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn update_product(
    state: State<'_, AppState>,
    token: String,
    product_id: i64,
    input: ProductInput,
) -> AppResult<()> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::validation("catalog.name_required"));
    }
    if input.category_id <= 0 {
        return Err(AppError::validation("catalog.category_required"));
    }
    if input.price_minor < 0 {
        return Err(AppError::validation("catalog.invalid_price"));
    }
    if input.stock_quantity.is_some_and(|quantity| quantity < 0) {
        return Err(AppError::validation("catalog.invalid_stock"));
    }
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        if !catalog::category_exists(conn, input.category_id)? {
            return Err(AppError::validation("catalog.category_not_found"));
        }
        if !catalog::update(
            conn,
            product_id,
            &name,
            input.category_id,
            input.price_minor,
            input.track_inventory,
            input.stock_quantity,
            actor.id,
        )? {
            return Err(AppError::not_found("catalog.item_not_found"));
        }
        crate::services::audit::record(
            conn,
            Some(actor.id),
            Some(&actor.role),
            "catalog.product_updated",
            "product",
            Some(&product_id.to_string()),
            None,
            Some(
                &serde_json::json!({ "name": name, "category_id": input.category_id, "price_minor": input.price_minor, "track_inventory": input.track_inventory, "stock_quantity": input.stock_quantity }),
            ),
        )
    })
}

/// Price change: audited, and historical invoices stay untouched (snapshots).
#[tauri::command(rename_all = "snake_case")]
pub fn set_product_price(
    state: State<'_, AppState>,
    token: String,
    product_id: i64,
    price_minor: i64,
) -> AppResult<()> {
    if price_minor < 0 {
        return Err(AppError::validation("catalog.invalid_price"));
    }
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        let old = catalog::update_price(conn, product_id, price_minor)?;
        crate::services::audit::record(
            conn,
            Some(actor.id),
            Some(&actor.role),
            "catalog.price_changed",
            "product",
            Some(&product_id.to_string()),
            Some(&serde_json::json!({ "price_minor": old })),
            Some(&serde_json::json!({ "price_minor": price_minor })),
        )
    })
}

/// Deactivation is preferred over deletion (history must stay intact).
#[tauri::command(rename_all = "snake_case")]
pub fn set_product_active(
    state: State<'_, AppState>,
    token: String,
    product_id: i64,
    active: bool,
) -> AppResult<()> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        catalog::set_active(conn, product_id, active)?;
        crate::services::audit::record(
            conn,
            Some(actor.id),
            Some(&actor.role),
            "catalog.product_activation_changed",
            "product",
            Some(&product_id.to_string()),
            None,
            Some(&serde_json::json!({ "is_active": active })),
        )
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn rename_product(
    state: State<'_, AppState>,
    token: String,
    product_id: i64,
    name: String,
) -> AppResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::validation("catalog.name_required"));
    }
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        catalog::rename(conn, product_id, &name)?;
        crate::services::audit::record(
            conn,
            Some(actor.id),
            Some(&actor.role),
            "catalog.product_renamed",
            "product",
            Some(&product_id.to_string()),
            None,
            Some(&serde_json::json!({ "name": name })),
        )
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_discount_options(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<DiscountOptionsConfig> {
    authorized(&state, &token, "STAFF", |conn, _| {
        crate::services::settings::get_discount_options(conn)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_discount_options(
    state: State<'_, AppState>,
    token: String,
    config: DiscountOptionsConfig,
) -> AppResult<()> {
    authorized(&state, &token, "ADMIN", move |conn, actor| {
        crate::services::settings::set_discount_options(conn, actor, &config)
    })
}

/// Administrator-facing status of the ONE shared discount-authorization PIN.
/// MANAGER+ only; it exposes a boolean, never the PIN.
#[tauri::command(rename_all = "snake_case")]
pub fn get_discount_authorization(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<crate::services::settings::DiscountAuthorizationConfig> {
    authorized(&state, &token, "MANAGER", |conn, _| {
        crate::services::settings::get_discount_authorization(conn)
    })
}

/// MANAGER+ sets or changes THE shared 4-digit discount-authorization PIN.
/// One credential for the whole cafe — never a per-user one.
#[tauri::command(rename_all = "snake_case")]
pub fn set_discount_authorization_pin(
    state: State<'_, AppState>,
    token: String,
    pin: String,
) -> AppResult<()> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        crate::services::settings::set_discount_authorization_pin(conn, actor, &pin)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_service_charge(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<ServiceChargeConfig> {
    authorized(&state, &token, "STAFF", |conn, _| {
        crate::services::settings::get_service_charge(conn)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_service_charge(
    state: State<'_, AppState>,
    token: String,
    config: ServiceChargeConfig,
) -> AppResult<()> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        crate::services::settings::set_service_charge(conn, actor, &config)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_credit_config(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<crate::services::settings::CreditConfig> {
    authorized(&state, &token, "MANAGER", |conn, _| {
        crate::services::settings::get_credit_config(conn)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_credit_config(
    state: State<'_, AppState>,
    token: String,
    config: crate::services::settings::CreditConfig,
) -> AppResult<()> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        crate::services::settings::set_credit_config(conn, actor, &config)
    })
}

// ---- settings (service charge / discount authorization / credit rules) ------
