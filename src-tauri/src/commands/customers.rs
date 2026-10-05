// Tauri commands — customers & cars.

use super::common::authorized;
use crate::error::{AppError, AppResult};
use crate::repositories::customer_analytics::{CustomerDetails, CustomerList, CustomerOverview};
use crate::repositories::customers::{self, Car, Customer, CustomerPhoneEntry, CustomerWithCars};
use crate::services::customers::{self as customer_svc, CustomerPeriod};
use crate::AppState;
use serde::Deserialize;
use tauri::State;

#[derive(Deserialize)]
pub struct CustomerInput {
    pub name: String,
    pub phone: Option<String>,
    pub notes: Option<String>,
}

/// Unified lookup used by the POS customer picker (name / phone / plate).
/// An empty query is NOT an error: it returns the registered customers so the
/// picker can show them immediately, without forcing a search first.
#[tauri::command(rename_all = "snake_case")]
pub fn search_customers(
    state: State<'_, AppState>,
    token: String,
    query: String,
) -> AppResult<Vec<CustomerWithCars>> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        customers::search(conn, query.trim())
    })
}

/// The customers page list. Open to every authenticated role; the service
/// decides whether the caller's role may also receive the period aggregate, and
/// a cashier's payload simply has no financial field in it.
#[tauri::command(rename_all = "snake_case")]
pub fn list_customers(
    state: State<'_, AppState>,
    token: String,
    query: Option<String>,
    period: Option<CustomerPeriod>,
) -> AppResult<CustomerList> {
    let period = period.unwrap_or_default();
    customer_svc::validate_period(&period)?;
    let (from, to) = period.bounds();
    let query = query.unwrap_or_default();
    authorized(&state, &token, "STAFF", move |conn, actor| {
        customer_svc::list(conn, actor, query.trim(), from, to)
    })
}

/// Phone export for customer communication workflows.
///
/// MANAGER-gated in the service: the page list itself is open to every role,
/// so the boundary lives here rather than in what the UI renders.
/// `customer_ids = None` exports every eligible customer (no 200-row page
/// cap); `Some(ids)` exports exactly the selected rows.
#[tauri::command(rename_all = "snake_case")]
pub fn export_customer_phones(
    state: State<'_, AppState>,
    token: String,
    customer_ids: Option<Vec<i64>>,
) -> AppResult<Vec<CustomerPhoneEntry>> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        customer_svc::export_phones(conn, actor, customer_ids)
    })
}

/// Page-level customer KPIs. The service enforces the MANAGER gate itself, so
/// the refusal is a real refusal, not a hidden section.
#[tauri::command(rename_all = "snake_case")]
pub fn customer_overview(
    state: State<'_, AppState>,
    token: String,
    period: Option<CustomerPeriod>,
) -> AppResult<CustomerOverview> {
    let period = period.unwrap_or_default();
    customer_svc::validate_period(&period)?;
    let (from, to) = period.bounds();
    authorized(&state, &token, "STAFF", move |conn, actor| {
        customer_svc::overview(conn, actor, from, to)
    })
}

/// One customer's details drawer payload. Manager-level, for the same reason.
#[tauri::command(rename_all = "snake_case")]
pub fn customer_details(
    state: State<'_, AppState>,
    token: String,
    customer_id: i64,
    period: Option<CustomerPeriod>,
) -> AppResult<CustomerDetails> {
    let period = period.unwrap_or_default();
    customer_svc::validate_period(&period)?;
    let (from, to) = period.bounds();
    authorized(&state, &token, "STAFF", move |conn, actor| {
        customer_svc::details(conn, actor, customer_id, from, to)
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
        customers::update(
            conn,
            customer_id,
            &name,
            input.phone.as_deref(),
            input.notes.as_deref(),
        )?;
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

/// ADMIN-only permanent delete of a customer.
///
/// Narrower than `update_customer` above, which is MANAGER-level: editing who
/// somebody is is routine, removing them from the registry is not. Only an ADMIN
/// may do it, and the service re-checks the role so a direct invocation from a
/// MANAGER or CASHIER session is refused as well.
///
/// The customer's cars go with them — a plate is an owned registration with no
/// history of its own. A customer with orders, invoices or a credit account is
/// REFUSED with a domain error instead, because their financial history must
/// outlive the ability to remove them from the list.
#[tauri::command(rename_all = "snake_case")]
pub fn delete_customer(
    state: State<'_, AppState>,
    token: String,
    customer_id: i64,
) -> AppResult<()> {
    authorized(&state, &token, "ADMIN", move |conn, actor| {
        customer_svc::delete(conn, actor, customer_id)
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
