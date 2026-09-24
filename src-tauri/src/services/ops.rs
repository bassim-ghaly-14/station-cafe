//! Inventory & expense services (business rules + audit + transactions).

use crate::error::{AppError, AppResult};
use crate::repositories::ops::{self, Expense, MovementRow, StockRow};
use crate::repositories::{catalog, Db};
use crate::services::auth::User;
use serde::Deserialize;

/// Manager adjusts stock with an explicit reason; the movement is auditable.
pub fn adjust_stock(
    conn: &Db,
    actor: &User,
    product_id: i64,
    change: i64,
    reason: &str,
    note: Option<&str>,
) -> AppResult<()> {
    if !["PURCHASE", "ADJUSTMENT", "WASTE"].contains(&reason) {
        return Err(AppError::validation("inventory.invalid_reason"));
    }
    let tx = conn.unchecked_transaction()?;
    let p = catalog::get(&tx, product_id)?
        .ok_or_else(|| AppError::not_found("catalog.item_not_found"))?;
    if !p.track_inventory {
        return Err(AppError::business("inventory.not_tracked"));
    }
    ops::adjust(&tx, product_id, change, reason, note, None, actor.id)?;
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "inventory.adjusted",
        "product",
        Some(&product_id.to_string()),
        None,
        Some(&serde_json::json!({ "change": change, "reason": reason, "note": note })),
    )?;
    tx.commit()?;
    Ok(())
}

pub fn list_stock(conn: &Db) -> AppResult<Vec<StockRow>> {
    ops::list_stock(conn)
}

pub fn list_movements(conn: &Db, limit: i64) -> AppResult<Vec<MovementRow>> {
    ops::list_movements(conn, limit.clamp(1, 500))
}

/// Decrement stock for tracked items sold in an invoice (inside checkout tx).
pub fn apply_sale_to_inventory(conn: &Db, invoice_id: i64, user_id: i64) -> AppResult<()> {
    for (product_id, qty) in ops::tracked_lines_of_invoice(conn, invoice_id)? {
        ops::adjust(
            conn,
            product_id,
            -qty,
            "SALE",
            None,
            Some(invoice_id),
            user_id,
        )?;
    }
    Ok(())
}

pub fn set_min_quantity(
    conn: &Db,
    actor: &User,
    product_id: i64,
    min_quantity: i64,
) -> AppResult<()> {
    let p = catalog::get(conn, product_id)?
        .ok_or_else(|| AppError::not_found("catalog.item_not_found"))?;
    if !p.track_inventory {
        return Err(AppError::business("inventory.not_tracked"));
    }
    ops::set_min_quantity(conn, product_id, min_quantity)?;
    crate::services::audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "inventory.min_changed",
        "product",
        Some(&product_id.to_string()),
        None,
        Some(&serde_json::json!({ "min_quantity": min_quantity })),
    )
}

#[derive(Debug, Deserialize)]
pub struct NewExpense {
    pub category: String,
    pub amount: i64,
    pub description: Option<String>,
    pub expense_date: Option<String>,
    pub is_recurring: bool,
    pub recurrence: Option<String>,
}

pub fn create_expense(conn: &Db, actor: &User, input: &NewExpense) -> AppResult<i64> {
    const CATEGORIES: [&str; 6] = [
        "MAINTENANCE",
        "SUPPLIES",
        "UTILITY",
        "SALARY",
        "EMERGENCY",
        "OTHER",
    ];
    if !CATEGORIES.contains(&input.category.as_str()) {
        return Err(AppError::validation("expenses.invalid_category"));
    }
    if input.amount <= 0 {
        return Err(AppError::validation("expenses.invalid_amount"));
    }
    if input.is_recurring
        && !matches!(
            input.recurrence.as_deref(),
            Some("WEEKLY") | Some("MONTHLY")
        )
    {
        return Err(AppError::validation("expenses.invalid_recurrence"));
    }
    let tx = conn.unchecked_transaction()?;
    let day_id = crate::repositories::shifts::current_day(&tx)?.map(|d| d.id);
    let date = input
        .expense_date
        .clone()
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(crate::services::auth::sqlite_today);
    let recurrence = if input.is_recurring {
        input.recurrence.as_deref()
    } else {
        None
    };
    let id = ops::insert_expense(
        &tx,
        &input.category,
        input.amount,
        input.description.as_deref(),
        &date,
        input.is_recurring,
        recurrence,
        day_id,
        actor.id,
    )?;
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "expense.created",
        "expense",
        Some(&id.to_string()),
        None,
        Some(&serde_json::json!({
            "category": input.category, "amount": input.amount, "date": date,
            "recurring": input.is_recurring
        })),
    )?;
    tx.commit()?;
    Ok(id)
}

pub fn list_expenses(
    conn: &Db,
    from: Option<String>,
    to: Option<String>,
    recurring_only: bool,
) -> AppResult<Vec<Expense>> {
    ops::list_expenses(conn, from.as_deref(), to.as_deref(), recurring_only)
}
