//! Customer management + activity analytics.
//!
//! This service owns ONE rule the rest of the app must not re-invent: who may
//! see customer money. The page itself is open to every authenticated role, but
//! the period aggregate is only ever computed for a role that passes the
//! existing `MANAGER` gate, so a cashier's payload contains no financial field
//! at all — the UI never receives data it would only have to hide.
//!
//! It reuses the existing authorization model (`auth::require_role`) and adds no
//! parallel permission system. Nothing here is cached or denormalized: every
//! figure is aggregated in SQL at the repository layer on each request.

use crate::error::{AppError, AppResult};
use crate::repositories::customer_analytics::{
    self, CustomerDetails, CustomerList, CustomerOverview,
};
use crate::repositories::customers::{self, CustomerPhoneEntry};
use crate::repositories::users::User;
use crate::repositories::Db;
use crate::services::auth;

/// The customer list, projected for the caller's role.
///
/// `financial_visible` is decided by the SAME gate the drawer and the KPI band
/// use, so the table, the KPIs and the drawer can never disagree about what a
/// role is allowed to see.
pub fn list(
    conn: &Db,
    actor: &User,
    query: &str,
    from: Option<&str>,
    to: Option<&str>,
) -> AppResult<CustomerList> {
    let financial_visible = auth::require_role(actor, "MANAGER").is_ok();
    Ok(CustomerList {
        financial_visible,
        customers: customer_analytics::list_rows(conn, query, from, to, financial_visible)?,
    })
}

/// Page-level customer KPIs.
///
/// Manager-level: this is a financial aggregate, so the gate is enforced HERE,
/// inside the service, and a cashier receives a real refusal — never a
/// redacted copy of the numbers.
pub fn overview(
    conn: &Db,
    actor: &User,
    from: Option<&str>,
    to: Option<&str>,
) -> AppResult<CustomerOverview> {
    auth::require_role(actor, "MANAGER")?;
    customer_analytics::overview(conn, from, to)
}

/// One customer's details: identity, cars, aggregated activity and recent
/// invoices. Manager-level for the same reason as [`overview`].
pub fn details(
    conn: &Db,
    actor: &User,
    customer_id: i64,
    from: Option<&str>,
    to: Option<&str>,
) -> AppResult<CustomerDetails> {
    auth::require_role(actor, "MANAGER")?;
    customer_analytics::details(conn, customer_id, from, to)
}

/// Permanently delete a customer. ADMIN only.
///
/// # What is deleted and what is refused
///
/// Station's customer table is a live registry — a customer with no activity is
/// a duplicate or a mistake, and removing the row is the correct answer. So this
/// really does delete, and the safety comes from the dependency check rather than
/// from keeping the record:
///
///   - **Cars are deleted with the customer.** A vehicle is an owned
///     registration with no independent history: an invoice never reads a car's
///     row, it snapshots the plate into `invoice_customers`. Deleting the owner
///     without its plates would orphan a plate nothing could reach.
///   - **Orders, invoices and credit accounts BLOCK the delete.** These are the
///     financial history. Cascading them would destroy paid invoices and money
///     movements to make a record removable, which is exactly what must never
///     happen — so the call returns a domain error and changes nothing.
///     Deactivation is not a customer concept here; a customer with history is
///     simply permanent, which is the correct answer for a financial ledger.
///
/// The check runs BEFORE any write, and the writes then share one transaction
/// with the audit entry, so there is no partial deletion: the cars and the
/// customer are removed together or not at all.
pub fn delete(conn: &Db, actor: &User, customer_id: i64) -> AppResult<()> {
    auth::require_role(actor, "ADMIN")?;

    let tx = conn.unchecked_transaction()?;
    let customer = customers::find_by_id(&tx, customer_id)?
        .ok_or_else(|| AppError::not_found("customers.not_found"))?;

    let blockers = customers::delete_blockers(&tx, customer_id)?;
    if !blockers.is_empty() {
        return Err(AppError::business("customers.has_history"));
    }

    // Only reached once the customer is proven to own no history, so the only
    // dependent rows here are the vehicle registrations, which are owned.
    let cars_deleted = customers::delete_cars_of(&tx, customer_id)?;
    customers::delete(&tx, customer_id)?;

    crate::services::audit::record(
        &tx,
        Some(actor.id),
        Some(&actor.role),
        "customer.deleted",
        "customer",
        Some(&customer_id.to_string()),
        Some(&serde_json::json!({
            "name": customer.name,
            "phone": customer.phone,
            "cars_deleted": cars_deleted,
        })),
        None,
    )?;

    tx.commit()?;
    Ok(())
}

/// Phone export rows for owner-controlled communication workflows.
///
/// MANAGER-gated: customer phone numbers are personal data, and the list
/// command is open to every role, so this dedicated read is the boundary that
/// keeps an "export all" out of a cashier's reach. `customer_ids = None`
/// means every eligible customer (no page cap); `Some(ids)` exports exactly
/// those rows. Rows arrive ordered by `name, id` from the repository and are
/// deduplicated here by normalized `phone_key`, keeping the first (lowest
/// name, then lowest id) occurrence so the output is deterministic.
pub fn export_phones(
    conn: &Db,
    actor: &User,
    customer_ids: Option<Vec<i64>>,
) -> AppResult<Vec<CustomerPhoneEntry>> {
    auth::require_role(actor, "MANAGER")?;
    let rows = customers::export_phones(conn, customer_ids.as_deref())?;
    let mut seen = std::collections::HashSet::new();
    Ok(rows
        .into_iter()
        .filter(|row| seen.insert(row.phone_key.clone()))
        .collect())
}

/// The activity band + the period a customer is being viewed for. Pure input
/// normalization shared by the list, the KPIs and the drawer so all three
/// always describe the same window.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct CustomerPeriod {
    pub from: Option<String>,
    pub to: Option<String>,
}

impl CustomerPeriod {
    /// Empty / whitespace-only bounds mean "unbounded", exactly like the
    /// reports service treats an empty date filter.
    pub fn bounds(&self) -> (Option<&str>, Option<&str>) {
        (clean(self.from.as_deref()), clean(self.to.as_deref()))
    }
}

fn clean(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// Reject a malformed period before it can reach a report query.
pub fn validate_period(period: &CustomerPeriod) -> AppResult<()> {
    for value in [clean(period.from.as_deref()), clean(period.to.as_deref())]
        .into_iter()
        .flatten()
    {
        if !is_iso_date(value) {
            return Err(AppError::validation("customers.invalid_period"));
        }
    }
    Ok(())
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| matches!(i, 4 | 7) || b.is_ascii_digit())
}
