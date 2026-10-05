//! Inventory & expense services (business rules + audit + transactions).

use crate::error::{AppError, AppResult};
use crate::repositories::expenses::{
    self, Expense, ExpenseCategory, ExpenseMonthlyWindow, ExpenseOverview,
};
use crate::repositories::ops::{self, MovementRow, StockRow};
use crate::repositories::{catalog, Db};
use crate::services::auth::{require_role, User};
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
    /// Whether the money physically left the drawer. Only a cash expense may
    /// reduce expected cash; the default is the cash case.
    #[serde(default = "default_true")]
    pub paid_from_cash: bool,
    /// The employee this spend is FOR, required by any category whose
    /// `requires_employee` flag is set and ignored by every other one.
    ///
    /// It is the STABLE id, never a name typed into a text box, so the employee
    /// behind a salary figure can always be resolved.
    #[serde(default)]
    pub employee_id: Option<i64>,
}

fn default_true() -> bool {
    true
}

pub fn list_categories(conn: &Db) -> AppResult<Vec<ExpenseCategory>> {
    expenses::list_categories(conn, true)
}

// ---- expense categories ----------------------------------------------------
//
// WHO may change an expense category's NAME is stated here, once, and is not
// re-decided by any caller:
//
//   * CREATE and RENAME are MANAGER actions. A manager runs the café's expense
//     list day to day, and the categories are the vocabulary of that list.
//   * DELETE is ADMIN only. It is the one operation that can make an expense
//     unreportable, so it is narrower than renaming — exactly as deleting a
//     product or a customer is narrower than editing one.
//
// It is the EXISTING role ladder (`auth::require_role`), the same one every
// other command uses. No permission table, no second system. The role check runs
// before any other work, so a MANAGER that invokes the delete command directly
// — bypassing the React page entirely — is refused here and nothing is written.

/// The ONE canonical name rule for an expense category.
///
/// Creation and renaming share it deliberately: the rule must not depend on who
/// is typing or which entry point was used. The database's own CHECK
/// (`name_ar = trim(name_ar) AND length(name_ar) > 0`) is the guarantee behind
/// it; this is the readable form of it, and it is what produces the Arabic
/// message the user actually reads.
fn category_name(name: &str) -> AppResult<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::validation("expenses.category_name_required"));
    }
    Ok(trimmed)
}

/// MANAGER+ creation of an expense category. Returns the new category's code.
///
/// The `code` is generated by the repository, never typed by the user: expenses
/// reference the code, so a stable key is what lets a category be renamed later
/// without touching a single historical record.
pub fn create_category(conn: &Db, actor: &User, name: &str) -> AppResult<String> {
    require_role(actor, "MANAGER")?;

    let name = category_name(name)?;
    if expenses::category_name_exists(conn, name, None)? {
        return Err(AppError::validation("expenses.category_name_taken"));
    }

    let code = expenses::insert_category(conn, name)?;

    crate::services::audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "expenses.category_created",
        "expense_category",
        Some(&code),
        None,
        Some(&serde_json::json!({ "name": name })),
    )?;

    Ok(code)
}

/// MANAGER+ rename of an expense category.
///
/// A rename relabels the category from today onwards: expenses store the CODE,
/// and a closing snapshot froze its resolved Arabic label when the document was
/// issued, so nothing already recorded or already printed can change. The rule
/// set is the same [`category_name`] creation applies, restated through the same
/// helper so the two can never drift apart.
pub fn rename_category(conn: &Db, actor: &User, code: &str, name: &str) -> AppResult<()> {
    require_role(actor, "MANAGER")?;

    let name = category_name(name)?;

    let Some(category) = expenses::get_category(conn, code)? else {
        return Err(AppError::not_found("expenses.category_not_found"));
    };

    if expenses::category_name_exists(conn, name, Some(code))? {
        return Err(AppError::validation("expenses.category_name_taken"));
    }

    if !expenses::update_category_name(conn, code, name)? {
        return Err(AppError::not_found("expenses.category_not_found"));
    }

    crate::services::audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "expenses.category_updated",
        "expense_category",
        Some(code),
        Some(&serde_json::json!({ "name": category.name_ar })),
        Some(&serde_json::json!({ "name": name })),
    )
}

/// ADMIN-only delete of an expense category — narrower than renaming it.
///
/// Ordering is the contract:
///   1. authorization (ADMIN) — a MANAGER/STAFF caller is refused here, whatever
///      the frontend did or did not render;
///   2. the category must exist (an unknown code is a not-found, never a silent
///      success);
///   3. a SYSTEM category is refused: the seeded six are the fallback vocabulary
///      the rest of the app was migrated onto, and removing one would take a
///      standard category off every list for good;
///   4. a category that still HOLDS expenses is refused with a business-rule
///      error. `expenses.category REFERENCES expense_categories(code)` runs with
///      foreign keys ON, so this pre-check is the readable form of what the
///      database would otherwise enforce — the ADMIN is told to move the expenses
///      instead of losing them or losing the category. Nothing is cascaded and no
///      expense is ever removed;
///   5. the removal is written to the audit log like every other write.
pub fn delete_category(conn: &Db, actor: &User, code: &str) -> AppResult<()> {
    require_role(actor, "ADMIN")?;

    let Some(category) = expenses::get_category(conn, code)? else {
        return Err(AppError::not_found("expenses.category_not_found"));
    };

    if category.is_system {
        return Err(AppError::business("expenses.category_is_system"));
    }

    if expenses::category_expense_count(conn, code)? > 0 {
        return Err(AppError::business("expenses.category_in_use"));
    }

    if !expenses::delete_category(conn, code)? {
        return Err(AppError::not_found("expenses.category_not_found"));
    }

    crate::services::audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "expenses.category_deleted",
        "expense_category",
        Some(code),
        Some(&serde_json::json!({ "name": category.name_ar })),
        None,
    )
}

/// Record an expense.
///
/// AUTHORIZATION: any authenticated user who is a cashier (STAFF) may record an
/// expense for their OWN open shift, and a MANAGER/ADMIN may record one at any
/// time. This is the existing role ladder in `commands` — there is no bespoke
/// permission table in Station, and inventing one here would be a parallel
/// authorization system. A STAFF user with no open shift is refused, because an
/// expense with no shift could never appear in a drawer reconciliation.
///
/// An expense booked by a cashier is ALWAYS attached to their active shift, so
/// it reduces that drawer's expected cash. A manager's expense may be attached
/// to the currently open shift too (it is usually petty cash taken from it), or
/// left as a general day-level expense belonging to no till.
pub fn create_expense(conn: &Db, actor: &User, input: &NewExpense) -> AppResult<i64> {
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
    let is_manager = matches!(actor.role.as_str(), "MANAGER" | "ADMIN");
    let tx = conn.unchecked_transaction()?;
    // The category must exist and be active. There is no hardcoded enum in the
    // service, the repository or the UI — only the table decides.
    if !expenses::category_is_active(&tx, &input.category)? {
        return Err(AppError::validation("expenses.invalid_category"));
    }
    // An employee-linked category (the advance) additionally demands WHO. The rule
    // is read from the category row rather than recognised by its code, so Manager
    // and Cashier obey exactly the same data-driven requirement and a future
    // employee-linked category needs no change here.
    let requires_employee =
        expenses::category_requires_employee(&tx, &input.category)?.unwrap_or(false);
    let employee_id = if requires_employee {
        Some(require_employee(&tx, input.employee_id)?)
    } else {
        None
    };
    // Being employee-linked and BEING AN ADVANCE are separate facts, read
    // separately from the same category row. A salary payment names its employee
    // but records no advance: an advance is money that comes back OUT of a
    // month's pay, and a salary is what is paid. Reading the second flag from the
    // first would fabricate a ledger row per salary and subtract every payroll
    // twice — so neither flag is ever inferred from the other.
    let records_advance = expenses::category_records_advance(&tx, &input.category)?;
    let date = resolve_expense_date(&tx, actor, input, is_manager)?;
    let recurrence = if input.is_recurring {
        input.recurrence.as_deref()
    } else {
        None
    };
    let id = expenses::insert(
        &tx,
        &input.category,
        input.amount,
        input.description.as_deref(),
        &date.expense_date,
        input.is_recurring,
        recurrence,
        date.business_day_id,
        date.shift_id,
        input.paid_from_cash,
        actor.id,
        employee_id,
    )?;
    // The salary half of an advance, written in the SAME transaction as the expense
    // above. SQLite has no nested transaction, so the caller owns the boundary and
    // both rows commit or neither does: an advance can never exist without its
    // expense, and an advance expense can never exist without its ledger row.
    //
    // It is gated on `records_advance`, NOT on the presence of an employee, which
    // is what keeps an employee-linked SALARY from fabricating a ledger row.
    if records_advance {
        let Some(employee_id) = employee_id else {
            // Unreachable through the flags above: a category that records an
            // advance necessarily requires an employee. Asserted rather than
            // unwrapped so a future flag combination fails loudly here instead of
            // writing an advance with nobody attached to it.
            return Err(AppError::internal("expenses.advance_without_employee"));
        };
        let advance = crate::services::employees::AdvanceInput {
            amount: input.amount,
            advance_date: Some(date.expense_date.clone()),
            // The expense description IS the advance's reason: one piece of free
            // text, entered once, so the two records cannot disagree about it.
            reason: advance_reason(input.description.as_deref()),
        };
        crate::services::employees::link_advance_to_expense(&tx, actor, employee_id, &advance, id)?;
    }
    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "expense.created",
        "expense",
        Some(&id.to_string()),
        None,
        Some(&serde_json::json!({
            "category": input.category, "amount": input.amount, "date": date.expense_date,
            "recurring": input.is_recurring, "shift_id": date.shift_id,
            "paid_from_cash": input.paid_from_cash, "employee_id": employee_id
        })),
    )?;
    tx.commit()?;
    Ok(id)
}

/// The advance's reason, falling back to the category's own Arabic label.
///
/// A manager is not forced to type a second sentence about the same payment, and
/// the reason column is `NOT NULL`, so the label of the category they just chose is
/// the honest default for "why was this paid".
fn advance_reason(description: Option<&str>) -> String {
    description
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "سلفة موظف".to_string())
}

/// The employee an employee-linked expense names, or a validation error.
///
/// `None` is refused before the row is written, and an id that names nobody is
/// refused by NAME — which is what tells the caller to fix the selection rather
/// than to retry.
fn require_employee(conn: &Db, employee_id: Option<i64>) -> AppResult<i64> {
    let Some(id) = employee_id.filter(|id| *id > 0) else {
        return Err(AppError::validation("expenses.employee_required"));
    };
    crate::repositories::employees::require(conn, id)?;
    Ok(id)
}

/// The business date and the till an expense belongs to.
struct ExpensePlacement {
    expense_date: String,
    shift_id: Option<i64>,
    business_day_id: Option<i64>,
}

/// Resolve WHERE an expense lands: its business date, the day it belongs to, and
/// the shift whose drawer it reduces.
///
/// A cash expense is always attached to the caller's OWN open shift, and a
/// cashier with no open shift is refused, because an expense belonging to no shift
/// could never appear in a drawer reconciliation. A manager without an open shift
/// records a day-level expense belonging to no till instead. The date is validated
/// here so a malformed day can never be stored.
fn resolve_expense_date(
    conn: &Db,
    actor: &User,
    input: &NewExpense,
    is_manager: bool,
) -> AppResult<ExpensePlacement> {
    let day = crate::repositories::shifts::current_day(conn)?;
    let open_shift = crate::repositories::shifts::active_shift_for(conn, actor.id)?;
    if !is_manager && open_shift.is_none() {
        return Err(AppError::business("expenses.no_open_shift"));
    }
    let date = input
        .expense_date
        .clone()
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(crate::services::auth::sqlite_today);
    crate::services::attendance::validate_business_date(&date)?;
    Ok(ExpensePlacement {
        expense_date: date,
        shift_id: open_shift.map(|s| s.id),
        business_day_id: day.map(|d| d.id),
    })
}

pub fn list_expenses(
    conn: &Db,
    from: Option<String>,
    to: Option<String>,
    recurring_only: bool,
) -> AppResult<Vec<Expense>> {
    expenses::list(conn, from.as_deref(), to.as_deref(), recurring_only)
}

/// The expenses of the caller's own open shift, for the POS panel.
pub fn shift_expenses(conn: &Db, actor: &User) -> AppResult<Vec<Expense>> {
    let shift = crate::repositories::shifts::active_shift_for(conn, actor.id)?
        .ok_or_else(|| AppError::business("shift.not_open"))?;
    expenses::list_for_shift(conn, shift.id)
}

/// The expenses booked to ANY shift — a MANAGER reviewing another cashier's
/// open shift before a managerial close sees the same list the cashier's own
/// dialog shows. The caller-scoped read above is untouched, and this one is
/// MANAGER+ both here and in its command.
pub fn expenses_of_shift(conn: &Db, actor: &User, shift_id: i64) -> AppResult<Vec<Expense>> {
    crate::services::auth::require_role(actor, "MANAGER")?;
    crate::repositories::shifts::get_shift(conn, shift_id)?
        .ok_or_else(|| AppError::not_found("shift.not_found"))?;
    expenses::list_for_shift(conn, shift_id)
}

/// The expenses workspace payload: KPIs, the daily trend and the category
/// ranking for ONE period.
///
/// The service owns the rule that is not SQL: **one window everywhere.** The
/// trend, the ranking, the KPI band and the expense list the page shows beside
/// them are all the same inclusive business-date bounds, so no section can
/// describe a different period than its neighbour.
///
/// A period with no expenses is NOT an error: the repository returns zeroes and
/// empty vectors, which is what lets the screen show a real empty state instead
/// of an error state.
pub fn expenses_overview(
    conn: &Db,
    from: Option<String>,
    to: Option<String>,
) -> AppResult<ExpenseOverview> {
    expenses::overview(conn, from.as_deref(), to.as_deref())
}

/// The monthly expense series over the window configured in Dev Settings.
///
/// THE WINDOW IS A SETTING, NOT A RULE — and it is the SAME setting the sales
/// monthly chart reads. `monthly_sales_period` is a cafe-wide "how many months
/// does a monthly comparison cover" preference, so the two monthly charts read
/// it through the same typed accessor and can never disagree. Nothing here reads
/// the Expenses page's date range picker: a calendar comparison is not a
/// range-filtered report, and the command cannot be handed that range at all.
///
/// `months` lets the caller state the value explicitly (the UI does, so the
/// screen and the query always agree); when it is absent the stored setting is
/// used, and an installation that never configured it reads the default.
/// The count is INCLUSIVE of the current month, so the window is
/// `business_date_months_ago(months - 1) .. today` — the same arithmetic the
/// sales monthly report uses. It is re-validated here, so an out-of-range value
/// is refused by the server no matter where it came from.
pub fn expenses_monthly(
    conn: &Db,
    actor: &User,
    months: Option<i64>,
) -> AppResult<ExpenseMonthlyWindow> {
    crate::services::auth::require_role(actor, "MANAGER")
        .map_err(|_| AppError::unauthorized("auth.forbidden"))?;
    let config = match months {
        Some(value) => crate::services::settings::MonthlySalesPeriodConfig { months: value },
        None => crate::services::settings::get_monthly_sales_period(conn)?,
    };
    config.validate()?;
    let from = crate::time::business_date_months_ago(config.months - 1);
    let to = crate::time::today_business_date();
    Ok(ExpenseMonthlyWindow {
        report: expenses::monthly_report(conn, &from, &to)?,
        from,
        to,
    })
}
