// Tauri commands — tables, orders, checkout, invoices, credits, wash tickets.

use super::common::authorized;
use crate::error::{AppError, AppResult};
use crate::repositories::invoices::{self, CreditAccount, InvoiceRow};
use crate::repositories::pos::{self, Order, TableView};
use crate::services::checkout::{self, CheckoutInput, CheckoutResult};
use crate::services::pos as pos_svc;
use crate::AppState;
use serde::Deserialize;
use tauri::State;

#[tauri::command(rename_all = "snake_case")]
pub fn list_tables(state: State<'_, AppState>, token: String) -> AppResult<Vec<TableView>> {
    authorized(&state, &token, "STAFF", |conn, _| pos_svc::list_tables(conn))
}

/// Opening a table requires an OPEN business day + the caller's ACTIVE shift.
#[tauri::command(rename_all = "snake_case")]
pub fn open_table(state: State<'_, AppState>, token: String, table_id: i64) -> AppResult<i64> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        pos_svc::open_table(conn, actor, table_id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_order(state: State<'_, AppState>, token: String, order_id: i64) -> AppResult<Order> {
    authorized(&state, &token, "STAFF", move |conn, _| pos_svc::get_order(conn, order_id))
}

#[tauri::command(rename_all = "snake_case")]
pub fn add_order_line(
    state: State<'_, AppState>,
    token: String,
    order_id: i64,
    product_id: i64,
    quantity: i64,
) -> AppResult<Order> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        pos_svc::add_line(conn, actor, order_id, product_id, quantity)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_line_quantity(
    state: State<'_, AppState>,
    token: String,
    line_id: i64,
    quantity: i64,
) -> AppResult<Order> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        pos_svc::update_line_quantity(conn, actor, line_id, quantity)?;
        // Return the refreshed order so the UI never re-derives totals itself.
        let line = pos::line_of(conn, line_id)?
            .ok_or_else(|| AppError::not_found("pos.line_not_found"))?;
        pos_svc::get_order(conn, line.order_id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn remove_order_line(
    state: State<'_, AppState>,
    token: String,
    order_id: i64,
    line_id: i64,
) -> AppResult<Order> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        pos_svc::remove_line(conn, actor, line_id)?;
        pos_svc::get_order(conn, order_id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn mark_ready_to_pay(
    state: State<'_, AppState>,
    token: String,
    order_id: i64,
) -> AppResult<()> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        pos_svc::mark_ready_to_pay(conn, actor, order_id)
    })
}

#[derive(Deserialize)]
pub struct AttachCustomerInput {
    pub order_id: i64,
    pub customer_id: i64,
    pub car_plate: Option<String>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn attach_customer(
    state: State<'_, AppState>,
    token: String,
    input: AttachCustomerInput,
) -> AppResult<()> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        pos_svc::attach_customer(conn, input.order_id, input.customer_id, input.car_plate.as_deref())
    })
}

/// Authoritative pricing preview (subtotal / discount / service charge / total).
#[tauri::command(rename_all = "snake_case")]
pub fn preview_order(
    state: State<'_, AppState>,
    token: String,
    order_id: i64,
    discount_mode: Option<String>,
    discount_value: Option<i64>,
) -> AppResult<pos_svc::OrderPreview> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        pos_svc::preview(conn, order_id, discount_mode.as_deref(), discount_value)
    })
}

/// Issue + print the wash job ticket (requires wash items, customer and car).
#[tauri::command(rename_all = "snake_case")]
pub fn issue_wash_ticket(
    state: State<'_, AppState>,
    token: String,
    order_id: i64,
) -> AppResult<pos_svc::WashTicketData> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        pos_svc::issue_wash_ticket(conn, order_id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn checkout_order(
    state: State<'_, AppState>,
    token: String,
    input: CheckoutInput,
) -> AppResult<CheckoutResult> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        checkout::checkout(conn, actor, &input)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_invoice(
    state: State<'_, AppState>,
    token: String,
    invoice_id: i64,
) -> AppResult<(InvoiceRow, Vec<invoices::InvoiceLine>)> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        invoices::get_invoice_full(conn, invoice_id)?
            .ok_or_else(|| AppError::not_found("invoice.not_found"))
    })
}

/// Today's invoices with fast lookup filters.
#[tauri::command(rename_all = "snake_case")]
pub fn search_invoices(
    state: State<'_, AppState>,
    token: String,
    business_day_id: Option<i64>,
    query: Option<String>,
    status: Option<String>,
    method: Option<String>,
) -> AppResult<Vec<InvoiceRow>> {
    authorized(&state, &token, "STAFF", move |conn, _| {
        invoices::search_invoices(
            conn,
            business_day_id,
            query.as_deref().filter(|q| !q.trim().is_empty()),
            status.as_deref(),
            method.as_deref(),
        )
    })
}

/// Cancellation is MANAGER+, same business day only, always audited.
#[tauri::command(rename_all = "snake_case")]
pub fn cancel_invoice(
    state: State<'_, AppState>,
    token: String,
    invoice_id: i64,
    reason: String,
) -> AppResult<()> {
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        checkout::cancel_invoice(conn, actor, invoice_id, &reason)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_credit_accounts(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<Vec<CreditAccount>> {
    authorized(&state, &token, "STAFF", |conn, _| invoices::list_credit_accounts(conn))
}

#[tauri::command(rename_all = "snake_case")]
pub fn settle_credit(
    state: State<'_, AppState>,
    token: String,
    customer_id: i64,
    amount: i64,
) -> AppResult<String> {
    authorized(&state, &token, "STAFF", move |conn, actor| {
        checkout::settle_credit(conn, actor, customer_id, amount)
    })
}