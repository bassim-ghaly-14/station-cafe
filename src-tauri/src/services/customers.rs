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
    for value in [clean(period.from.as_deref()), clean(period.to.as_deref())].into_iter().flatten() {
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
