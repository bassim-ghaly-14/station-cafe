//! Checkout service — the financial heart of the POS.
//!
//! Close-table-with-payment runs in ONE SQLite transaction:
//! validate → calculate → persist invoice (+lines snapshot) → persist payment
//! → credit account (when CREDIT) → close order + free table → audit.
//! Any failure rolls the whole thing back; no partial financial state.

use crate::error::{AppError, AppResult};
use crate::money::Money;
use crate::repositories::invoices;
use crate::repositories::pos;
use crate::repositories::Db;
use crate::services::auth::User;
use crate::services::pos as pos_svc;
use crate::services::settings;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct CheckoutInput {
    pub order_id: i64,
    pub method: String, // CASH | CARD | CREDIT
    pub discount_mode: Option<String>,
    pub discount_value: Option<i64>,
    pub discount_password: Option<String>,
    pub service_charge_minor: Option<i64>,
    /// CASH only: what the customer handed over (≥ total).
    pub received: Option<i64>,
}

/// Canonical Arabic identity for an invoice raised without a customer. It is a
/// stored value (not a display fallback) so history, reports and printed
/// documents all say exactly the same thing.
pub const NO_CUSTOMER_LABEL: &str = "بدون عميل";

#[derive(Debug, Serialize)]
pub struct CheckoutResult {
    pub invoice_id: i64,
    pub invoice_no: i64,
    pub total: i64,
    pub change_given: Option<i64>,
    pub status: String,
}

pub fn checkout(conn: &Db, actor: &User, input: &CheckoutInput) -> AppResult<CheckoutResult> {
    if !["CASH", "CARD", "CREDIT"].contains(&input.method.as_str()) {
        return Err(AppError::validation("payment.invalid_method"));
    }
    let tx = conn.unchecked_transaction()?;

    // ---- validate -----------------------------------------------------------
    let order = pos::get_order(&tx, input.order_id)?
        .ok_or_else(|| AppError::not_found("pos.order_not_found"))?;
    // Direct payment: an OPEN order goes straight to checkout — there is NO
    // "payment request" prerequisite in the Station workflow. READY_TO_PAY
    // stays accepted (legacy lifecycle state set by `mark_ready_to_pay`).
    // Settled (CLOSED) or CANCELLED orders can never be paid twice; every
    // other validation below (emptiness, totals, method, cash, credit) is
    // unchanged and stays authoritative.
    if order.status != "OPEN" && order.status != "READY_TO_PAY" {
        return Err(AppError::business("pos.order_not_payable"));
    }
    if order.lines.is_empty() {
        return Err(AppError::business("pos.empty_order"));
    }
    let subtotal: Money = order.lines.iter().map(|line| line.line_total).sum();
    let discount_minor = pos_svc::validate_discount(
        &tx,
        subtotal,
        input.discount_mode.as_deref(),
        input.discount_value,
    )
    .map_err(|e| match e {
        AppError::Validation(m) => AppError::business(m),
        other => other,
    })?;
    let persisted_discount = matches!(
        (order.discount_mode.as_deref(), order.discount_value),
        (Some(stored_mode), Some(stored_value))
            if input.discount_mode.as_deref() == Some(stored_mode)
                && input.discount_value == Some(stored_value)
    );
    if discount_minor > 0 && !persisted_discount {
        settings::authorize_discount(&tx, input.discount_password.as_deref())?;
    }
    let service_charge_minor = match input.service_charge_minor {
        Some(0) => 0,
        Some(amount) if settings::get_service_charge(&tx)?.amounts.contains(&amount) => amount,
        Some(_) => return Err(AppError::business("settings.invalid_service_charge")),
        None => 0,
    };
    let total: Money = subtotal - discount_minor + service_charge_minor;
    let preview = pos_svc::OrderPreview {
        subtotal,
        discount_mode: input.discount_mode.clone(),
        discount_value: input.discount_value,
        discount_minor,
        service_charge_minor,
        total,
        has_wash: order.lines.iter().any(|line| line.department == "WASH"),
    };
    if total <= 0 {
        return Err(AppError::business("payment.zero_total"));
    }

    let (received, change) = match input.method.as_str() {
        "CASH" => {
            let r = input
                .received
                .ok_or_else(|| AppError::validation("payment.received_required"))?;
            if r < total {
                return Err(AppError::business("payment.insufficient_cash"));
            }
            (Some(r), Some(r - total))
        }
        "CREDIT" => {
            // Authorization is configuration (DECISIONS.md #3), never assumed.
            let cid = order
                .customer_id
                .ok_or_else(|| AppError::business("credit.customer_required"))?;
            if !settings::get_credit_config(&tx)?.enabled {
                return Err(AppError::business("credit.disabled"));
            }
            if !crate::services::settings::customer_allowed_credit(&tx, cid)? {
                return Err(AppError::business("credit.not_allowed"));
            }
            (None, None)
        }
        _ => (None, None),
    };

    let invoice_no = invoices::next_invoice_no(&tx)?;
    let table_label: Option<String> = match order.table_id {
        Some(id) => Some(
            tx.query_row("SELECT label FROM cafe_tables WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap_or_default(),
        ),
        None => None,
    };
    let day_id: i64 = tx
        .query_row(
            "SELECT business_day_id FROM orders WHERE id = ?1",
            [input.order_id],
            |r| r.get::<_, Option<i64>>(0),
        )?
        .ok_or_else(|| AppError::business("pos.no_business_day"))?;
    // A takeaway order takes its human number at finalization, inside this
    // transaction: an unfinished or failed payment consumes no number, and the
    // number is snapshotted on the invoice so it stays stable in print records.
    let takeaway_no = if order.order_type == "TAKEAWAY" {
        let no = pos::next_takeaway_no(&tx, day_id)?;
        pos::set_takeaway_no(&tx, order.id, no)?;
        Some(no)
    } else {
        None
    };
    let cafe_total: Money = order
        .lines
        .iter()
        .filter(|l| l.department == "CAFE")
        .map(|l| l.line_total)
        .sum();
    let wash_total: Money = order
        .lines
        .iter()
        .filter(|l| l.department == "WASH")
        .map(|l| l.line_total)
        .sum();
    let lines: Vec<invoices::InvoiceLine> = order
        .lines
        .iter()
        .map(|l| invoices::InvoiceLine {
            department: l.department.clone(),
            product_name: l.product_name.clone(),
            unit_price: l.unit_price,
            quantity: l.quantity,
            discount_minor: l.discount_minor,
            line_total: l.line_total,
        })
        .collect();

    checkout_invoice(
        &tx,
        actor,
        input,
        &order,
        &preview,
        invoice_no,
        table_label.as_deref(),
        day_id,
        takeaway_no,
        cafe_total,
        wash_total,
        &lines,
        total,
        received,
        change,
    )
    .and_then(|result| {
        tx.commit()?;
        Ok(result)
    })
}

/// Persist invoice + snapshot + payment + credit + close order/session + audit.
#[allow(clippy::too_many_arguments)]
fn checkout_invoice(
    tx: &rusqlite::Transaction<'_>,
    actor: &User,
    input: &CheckoutInput,
    order: &pos::Order,
    preview: &pos_svc::OrderPreview,
    invoice_no: i64,
    table_label: Option<&str>,
    day_id: i64,
    takeaway_no: Option<i64>,
    cafe_total: Money,
    wash_total: Money,
    lines: &[invoices::InvoiceLine],
    total: Money,
    received: Option<i64>,
    change: Option<i64>,
) -> AppResult<CheckoutResult> {
    let invoice_id = invoices::insert_invoice(
        tx,
        invoice_no,
        order.id,
        table_label,
        day_id,
        order.shift_id,
        actor.id,
        &order.order_type,
        takeaway_no,
        order.customer_id,
        preview.subtotal,
        preview.discount_minor,
        input.discount_mode.as_deref(),
        input.discount_value,
        preview.service_charge_minor,
        total,
        cafe_total,
        wash_total,
        lines,
    )?;

    // The customer identity snapshot is ALWAYS written, so an invoice raised
    // without a customer is an explicit, first-class record rather than a
    // blank: it carries the Arabic label "بدون عميل" instead of missing data.
    match order.customer_id {
        Some(cid) => {
            let (name, phone): (String, Option<String>) = tx.query_row(
                "SELECT name, phone FROM customers WHERE id = ?1",
                [cid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let (plate, model): (Option<String>, Option<String>) = match tx.query_row(
                "SELECT plate_no, car_model FROM cars WHERE customer_id = ?1 ORDER BY id DESC LIMIT 1",
                [cid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ) {
                Ok(v) => (Some(v.0), v.1),
                Err(_) => (None, None),
            };
            invoices::insert_invoice_customer(
                tx,
                invoice_id,
                &name,
                phone.as_deref(),
                plate.as_deref(),
                model.as_deref(),
            )?;
        }
        None => {
            invoices::insert_invoice_customer(tx, invoice_id, NO_CUSTOMER_LABEL, None, None, None)?;
        }
    }

    let status = match input.method.as_str() {
        "CASH" | "CARD" => {
            invoices::insert_payment(
                tx,
                invoice_id,
                &input.method,
                total,
                received,
                change,
                actor.id,
            )?;
            invoices::apply_payment_to_invoice(tx, invoice_id, total)?
        }
        "CREDIT" => {
            invoices::insert_payment(tx, invoice_id, "CREDIT", total, None, None, actor.id)?;
            invoices::mark_invoice_credit(tx, invoice_id)?;
            invoices::open_or_extend_credit(tx, order.customer_id.unwrap(), total)?;
            "CREDIT".to_string()
        }
        _ => unreachable!(),
    };

    pos::set_order_status(tx, order.id, "CLOSED")?;
    // A settled table order ends its lifecycle session: the table returns to
    // EMPTY and the session stays recorded as "closed with an order".
    if let Some(table_id) = order.table_id {
        pos::close_open_session_of_table(tx, table_id, actor.id)?;
    }

    // Inventory: decrement tracked products (same transaction, auditable).
    crate::services::ops::apply_sale_to_inventory(tx, invoice_id, actor.id)?;

    crate::services::audit::record(
        tx,
        Some(actor.id),
        Some(&actor.role),
        "invoice.created",
        "invoice",
        Some(&invoice_id.to_string()),
        None,
        Some(&serde_json::json!({
            "invoice_no": invoice_no, "method": input.method, "total": total,
            "discount": preview.discount_minor, "service_charge": preview.service_charge_minor,
            "order_type": order.order_type, "takeaway_no": takeaway_no
        })),
    )?;

    Ok(CheckoutResult {
        invoice_id,
        invoice_no,
        total,
        change_given: change,
        status,
    })
}

/// Manager-level invoice cancellation — only while the day is still open.
pub fn cancel_invoice(conn: &Db, actor: &User, invoice_id: i64, reason: &str) -> AppResult<()> {
    if reason.trim().is_empty() {
        return Err(AppError::validation("invoice.cancel_reason_required"));
    }
    let tx = conn.unchecked_transaction()?;
    let day = crate::repositories::shifts::current_day(&tx)?
        .ok_or_else(|| AppError::business("pos.no_business_day"))?;
    let inv: (Option<i64>, String) = tx
        .query_row(
            "SELECT business_day_id, status FROM invoices WHERE id = ?1",
            [invoice_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| AppError::not_found("invoice.not_found"))?;
    if inv.1 == "CANCELLED" {
        return Err(AppError::business("invoice.already_cancelled"));
    }
    if inv.0 != Some(day.id) {
        return Err(AppError::business("invoice.cancel_day_closed"));
    }
    invoices::cancel_invoice(&tx, invoice_id)?;
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "invoice.cancelled",
        "invoice",
        Some(&invoice_id.to_string()),
        Some(&serde_json::json!({ "status": inv.1 })),
        Some(&serde_json::json!({ "status": "CANCELLED", "reason": reason })),
    )?;
    tx.commit()?;
    Ok(())
}

/// Credit settlement (partial or full) with explicit transaction + audit.
pub fn settle_credit(conn: &Db, actor: &User, customer_id: i64, amount: i64) -> AppResult<String> {
    if amount <= 0 {
        return Err(AppError::validation("payment.invalid_amount"));
    }
    let tx = conn.unchecked_transaction()?;
    let (acct, _, _): (i64, i64, i64) = invoices::credit_account_for(&tx, customer_id)?
        .ok_or_else(|| AppError::not_found("credit.not_found"))?;
    let status = invoices::pay_credit(&tx, acct, amount, actor.id)?;
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "credit.settled",
        "credit_account",
        Some(&acct.to_string()),
        None,
        Some(&serde_json::json!({ "amount": amount, "status": status })),
    )?;
    tx.commit()?;
    Ok(status)
}
