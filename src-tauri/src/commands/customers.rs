// Tauri commands — customers & cars.

use super::common::authorized;
use crate::error::{AppError, AppResult};
use crate::repositories::customers::{self, Car, Customer, CustomerWithCars};
use crate::AppState;
use serde::Deserialize;
use tauri::State;

#[derive(Deserialize)]
pub struct CustomerInput {
    pub name: String,
    pub phone: Option<String>,
    pub notes: Option<String>,
}

/// Unified lookup used by the POS search box (name / phone / plate).
#[tauri::command(rename_all = "snake_case")]
pub fn search_customers(
    state: State<'_, AppState>,
    token: String,
    query: String,
) -> AppResult<Vec<CustomerWithCars>> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        customers::search(conn, query.trim())
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_cars_of(
    state: State<'_, AppState>,
    token: String,
    customer_id: i64,
) -> AppResult<Vec<Car>> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        customers::cars_of(conn, customer_id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn find_cars_by_plate(
    state: State<'_, AppState>,
    token: String,
    plate: String,
) -> AppResult<Vec<(Car, Customer)>> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        customers::find_cars_by_plate(conn, plate.trim())
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn create_customer(
    state: State<'_, AppState>,
    token: String,
    input: CustomerInput,
) -> AppResult<i64> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::validation("customers.name_required"));
    }
    authorized(&state, &token, "STAFF", move |conn, actor| {
        let id = customers::insert(conn, &name, input.phone.as_deref(), input.notes.as_deref())?;
        crate::services::audit::record(
            conn,
            Some(actor.id),
            Some(&actor.role),
            "customer.created",
            "customer",
            Some(&id.to_string()),
            None,
            Some(&serde_json::json!({ "name": name, "phone": input.phone })),
        )?;
        Ok(id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn update_customer(
    state: State<'_, AppState>,
    token: String,
    customer_id: i64,
    input: CustomerInput,
) -> AppResult<()> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::validation("customers.name_required"));
    }
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        customers::update(conn, customer_id, &name, input.phone.as_deref(), input.notes.as_deref())?;
        crate::services::audit::record(
            conn,
            Some(actor.id),
            Some(&actor.role),
            "customer.updated",
            "customer",
            Some(&customer_id.to_string()),
            None,
            Some(&serde_json::json!({ "name": name, "phone": input.phone })),
        )
    })
}

#[derive(Deserialize)]
pub struct CarInput {
    pub customer_id: i64,
    pub plate_no: String,
    pub car_model: Option<String>,
    pub notes: Option<String>,
}

/// Plates are unique — a duplicate plate returns a clear conflict error.
#[tauri::command(rename_all = "snake_case")]
pub fn create_car(state: State<'_, AppState>, token: String, input: CarInput) -> AppResult<i64> {
    let plate = input.plate_no.trim().to_uppercase();
    if plate.is_empty() {
        return Err(AppError::validation("customers.plate_required"));
    }
    authorized(&state, &token, "STAFF", move |conn, actor| {
        let id = customers::insert_car(
            conn,
            input.customer_id,
            &plate,
            input.car_model.as_deref(),
            input.notes.as_deref(),
        )?
        .ok_or_else(|| AppError::conflict("customers.plate_taken"))?;
        crate::services::audit::record(
            conn,
            Some(actor.id),
            Some(&actor.role),
            "car.created",
            "car",
            Some(&id.to_string()),
            None,
            Some(&serde_json::json!({ "plate": plate, "customer_id": input.customer_id })),
        )?;
        Ok(id)
    })
}