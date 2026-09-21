//! POS workflow service — tables, orders, order lines, pricing preview.
//! All order mutations run inside transactions; shift gating is enforced
//! HERE (not in the UI): no open business day + active shift → no tables.

use crate::error::{AppError, AppResult};
use crate::money::{self, Money, Rate};
use crate::repositories::catalog;
use crate::repositories::customers;
use crate::repositories::pos::{self, Order, OrderLine, TableView};
use crate::repositories::shifts;
use crate::repositories::Db;
use crate::services::auth::User;
use crate::services::settings;
use rusqlite::params;
use serde::{Deserialize, Serialize};

pub fn list_tables(conn: &Db) -> AppResult<Vec<TableView>> {
    pos::list_tables(conn)
}

pub fn open_table(conn: &Db, actor: &User, table_id: i64) -> AppResult<i64> {
    // Gate 1: an explicit OPEN business day must exist.
    let day = shifts::current_day(conn)?.ok_or_else(|| AppError::business("pos.no_business_day"))?;
    // Gate 2: the staff member must have their own ACTIVE shift.
    let shift =
        shifts::active_shift_for(conn, actor.id)?.ok_or_else(|| AppError::business("pos.no_active_shift"))?;
    // Gate 3: table exists.
    pos::get_table(conn, table_id)?.ok_or_else(|| AppError::not_found("pos.table_not_found"))?;
    // Gate 4: no live order already on the table (DB constraint backs this).
    pos::open_order(conn, table_id, actor.id, day.id, shift.id)?
        .ok_or_else(|| AppError::conflict("pos.table_busy"))
}

pub fn get_order(conn: &Db, order_id: i64) -> AppResult<Order> {
    pos::get_order(conn, order_id)?.ok_or_else(|| AppError::not_found("pos.order_not_found"))
}

fn require_editable(order: &Order, actor: &User) -> AppResult<()> {
    if order.status != "OPEN" {
        return Err(AppError::business("pos.order_not_editable"));
    }
    if order.user_id != actor.id {
        return Err(AppError::unauthorized("auth.forbidden"));
    }
    Ok(())
}

/// Add a catalog item to an open order as an immutable snapshot line.
pub fn add_line(
    conn: &Db,
    actor: &User,
    order_id: i64,
    product_id: i64,
    quantity: i64,
) -> AppResult<Order> {
    if quantity <= 0 {
        return Err(AppError::validation("pos.invalid_quantity"));
    }
    let mut tx = conn.unchecked_transaction()?;
    let order = get_order(&tx, order_id)?;
    require_editable(&order, actor)?;
    let p = catalog::get(&tx, product_id)?
        .ok_or_else(|| AppError::not_found("catalog.item_not_found"))?;
    if !p.is_active {
        return Err(AppError::business("catalog.item_inactive"));
    }
    // Snapshot: name + unit price + department are frozen at this moment.
    pos::add_line(&tx, order_id, p.id, &p.department, &p.name, p.price_minor, quantity)?;
    let lines = pos::lines_of(&tx, order_id)?;
    tx.commit()?;
    Ok(Order { lines, ..order })
}

pub fn update_line_quantity(conn: &Db, actor: &User, line_id: i64, quantity: i64) -> AppResult<()> {
    if quantity <= 0 {
        return Err(AppError::validation("pos.invalid_quantity"));
    }
    let mut tx = conn.unchecked_transaction()?;
    let line = pos::line_of(&tx, line_id)?.ok_or_else(|| AppError::not_found("pos.line_not_found"))?;
    let order = get_order(&tx, line.order_id)?;
    require_editable(&order, actor)?;
    pos::update_line_quantity(&tx, line_id, quantity)?;
    tx.commit()?;
    Ok(())
}

pub fn remove_line(conn: &Db, actor: &User, line_id: i64) -> AppResult<()> {
    let mut tx = conn.unchecked_transaction()?;
    let line = pos::line_of(&tx, line_id)?.ok_or_else(|| AppError::not_found("pos.line_not_found"))?;
    let order = get_order(&tx, line.order_id)?;
    require_editable(&order, actor)?;
    pos::remove_line(&tx, line_id)?;
    tx.commit()?;
    Ok(())
}

pub fn mark_ready_to_pay(conn: &Db, actor: &User, order_id: i64) -> AppResult<()> {
    let mut tx = conn.unchecked_transaction()?;
    let order = get_order(&tx, order_id)?;
    require_editable(&order, actor)?;
    if order.lines.is_empty() {
        return Err(AppError::business("pos.empty_order"));
    }
    pos::set_order_status(&tx, order_id, "READY_TO_PAY")?;
    tx.commit()?;
    Ok(())
}

/// Attach a customer (and optional car) to an order.
pub fn attach_customer(
    conn: &Db,
    order_id: i64,
    customer_id: i64,
    car_plate: Option<&str>,
) -> AppResult<()> {
    let mut tx = conn.unchecked_transaction()?;
    let order = get_order(&tx, order_id)?;
    if order.status == "CLOSED" || order.status == "CANCELLED" {
        return Err(AppError::business("pos.order_not_editable"));
    }
    // Validate car ownership when a plate is provided.
    if let Some(plate) = car_plate {
        let car = customers::find_car(&tx, plate)?
            .ok_or_else(|| AppError::not_found("customers.car_not_found"))?;
        if car.customer_id != customer_id {
            return Err(AppError::business("customers.car_other_owner"));
        }
    }
    pos::set_order_customer(&tx, order_id, customer_id)?;
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderPreview {
    pub subtotal: i64,
    pub discount_mode: Option<String>,
    pub discount_value: Option<i64>,
    pub discount_minor: i64,
    pub service_charge_mode: String,
    pub service_charge_minor: i64,
    pub total: i64,
    pub has_wash: bool,
}

/// Compute the authoritative pricing preview — the SAME function used at
/// checkout time so POS, invoice and reports always agree.
pub fn preview(
    conn: &Db,
    order_id: i64,
    discount_mode: Option<&str>,
    discount_value: Option<i64>,
) -> AppResult<OrderPreview> {
    let order = get_order(conn, order_id)?;
    let subtotal: Money = order.lines.iter().map(|l: &OrderLine| l.line_total).sum();
    let discount_minor = match (discount_mode, discount_value) {
        (Some("FIXED"), Some(v)) => {
            if v < 0 || v > subtotal {
                return Err(AppError::business("discount.invalid"));
            }
            v
        }
        (Some("PERCENT"), Some(v)) => {
            let r = v as Rate;
            if !(0..=money::RATE_SCALE).contains(&r) {
                return Err(AppError::business("discount.invalid"));
            }
            subtotal - money::apply_percent_discount(subtotal, r)
        }
        _ => 0,
    };
    let base = subtotal - discount_minor;
    let sc = settings::get_service_charge(conn)?;
    let service_charge_minor = match sc.mode {
        settings::ServiceChargeMode::None => 0,
        settings::ServiceChargeMode::Fixed => sc.value.max(0),
        settings::ServiceChargeMode::Percent => money::percent_of(base, sc.value),
    };
    let mode_str = match sc.mode {
        settings::ServiceChargeMode::None => "NONE",
        settings::ServiceChargeMode::Fixed => "FIXED",
        settings::ServiceChargeMode::Percent => "PERCENT",
    };
    Ok(OrderPreview {
        subtotal,
        discount_mode: discount_mode.map(String::from),
        discount_value,
        discount_minor,
        service_charge_mode: mode_str.to_string(),
        service_charge_minor,
        total: base + service_charge_minor,
        has_wash: order.lines.iter().any(|l| l.department == "WASH"),
    })
}

/// Issue the wash job ticket: validates customer + car presence, assigns the
/// per-day waiting number, and returns the ticket data for printing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WashTicketData {
    pub waiting_no: i64,
    pub customer_name: String,
    pub customer_phone: Option<String>,
    pub car_plate: String,
    pub car_model: Option<String>,
    pub services: Vec<String>,
    pub entry_time: String,
}

pub fn issue_wash_ticket(conn: &Db, order_id: i64) -> AppResult<WashTicketData> {
    let mut tx = conn.unchecked_transaction()?;
    let order = get_order(&tx, order_id)?;
    if !order.lines.iter().any(|l| l.department == "WASH") {
        return Err(AppError::business("wash.no_wash_items"));
    }
    let customer_id =
        order.customer_id.ok_or_else(|| AppError::business("wash.customer_required"))?;
    let (name, phone) = {
        let mut stmt = tx.prepare("SELECT name, phone FROM customers WHERE id = ?1")?;
        stmt.query_row([customer_id], |r| Ok((r.get(0)?, r.get(1)?)))?
    };
    // Car required for a wash: latest car of the customer on this order.
    let (plate, car_model): (String, Option<String>) = tx
        .query_row(
            "SELECT plate_no, car_model FROM cars WHERE customer_id = ?1 ORDER BY id DESC LIMIT 1",
            [customer_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| AppError::business("wash.car_required"))?;

    let day = shifts::current_day(&tx)?.ok_or_else(|| AppError::business("pos.no_business_day"))?;
    if order.waiting_no.is_none() {
        // Per-day waiting number sequence (unique per day).
        let waiting_no: i64 = tx.query_row(
            "SELECT COALESCE(MAX(waiting_no), 0) + 1 FROM wash_tickets WHERE day_date = ?1",
            [&day.day_date],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO wash_tickets (order_id, waiting_no, day_date) VALUES (?1, ?2, ?3)",
            params![order_id, waiting_no, day.day_date],
        )?;
        pos::set_waiting_no(&tx, order_id, waiting_no)?;
    }
    let services: Vec<String> = order
        .lines
        .iter()
        .filter(|l| l.department == "WASH")
        .map(|l| l.product_name.clone())
        .collect();
    tx.commit()?;

    Ok(WashTicketData {
        waiting_no: order.waiting_no.unwrap_or(0),
        customer_name: name,
        customer_phone: phone,
        car_plate: plate,
        car_model,
        services,
        entry_time: crate::services::auth::sqlite_now(),
    })
}