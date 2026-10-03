//! Business configuration (service charge, credit authorization).
//! Values live in `app_settings` as JSON; typed accessors are the ONLY way
//! to read them so every calculation uses the same rules (DECISIONS.md #1/#3).

use crate::error::{AppError, AppResult};
use crate::repositories::Db;
use crate::services::auth::User;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServiceChargeConfig {
    /// Ordered fixed amounts in minor units (piastres).
    pub amounts: Vec<i64>,
}

impl Default for ServiceChargeConfig {
    fn default() -> Self {
        Self {
            amounts: Vec::new(),
        }
    }
}
fn read_json<T: serde::de::DeserializeOwned>(conn: &Db, key: &str, default: T) -> AppResult<T> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [key],
            |r| r.get(0),
        )
        .ok();
    match raw {
        Some(v) => Ok(serde_json::from_str(&v)
            .map_err(|e| AppError::internal(format!("invalid settings JSON for {key}: {e}")))?),
        None => Ok(default),
    }
}

fn write_json(conn: &Db, key: &str, value: &impl Serialize) -> AppResult<()> {
    let json = serde_json::to_string(value)
        .map_err(|e| AppError::internal(format!("serialize settings {key}: {e}")))?;
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = station_now()",
        params![key, json],
    )?;
    Ok(())
}

pub fn get_service_charge(conn: &Db) -> AppResult<ServiceChargeConfig> {
    read_json(conn, "service_charge", ServiceChargeConfig::default())
}

/// MANAGER+ configures the ordered fixed service-charge option list.
///
/// The role is re-checked HERE as well as at the command boundary, exactly like
/// every other settings service in this file (`set_credit_config`,
/// `set_discount_options`, …). Hiding the control in the UI proves nothing — a
/// session holder can invoke the command directly over Tauri IPC or the LAN
/// bridge — so the service itself refuses a role below MANAGER.
pub fn set_service_charge(conn: &Db, actor: &User, cfg: &ServiceChargeConfig) -> AppResult<()> {
    crate::services::auth::require_role(actor, "MANAGER")
        .map_err(|_| AppError::unauthorized("auth.forbidden"))?;
    let mut unique = std::collections::HashSet::new();
    if cfg
        .amounts
        .iter()
        .any(|amount| *amount <= 0 || !unique.insert(*amount))
    {
        return Err(AppError::validation("settings.invalid_service_charge"));
    }
    write_json(conn, "service_charge", cfg)?;
    crate::services::audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "settings.service_charge_changed",
        "settings",
        Some("service_charge"),
        None,
        Some(&serde_json::to_value(cfg).unwrap_or_default()),
    )
}

/// **THE** service-charge amount rule — one function, every caller.
///
/// `preview`, `checkout` and the print preview all resolve the service charge
/// through here, so a quick-pick amount and a typed custom amount can never be
/// judged by two different rules, and an amount the POS display shows can never
/// be one the invoice refuses.
///
/// The rules, and nothing else:
///   * `None` (or `0`) means NO service charge — the same outcome, so the caller
///     never has to distinguish "cleared" from "never chosen";
///   * any POSITIVE amount is valid, quick-pick or not. The configured
///     `amounts` list is a set of UI SHORTCUTS, never a whitelist: a cashier may
///     type 37 EGP when the presets are 10/20/30/50, and the backend accepts it;
///   * a NEGATIVE amount is refused — money is never subtracted as a charge.
///
/// NO AUTHORIZATION, EVER. A service charge is not an administrative discount,
/// so this function takes no actor and no credential: selecting, entering,
/// editing or removing one never consults the shared discount PIN
/// (`docs/DECISIONS.md` — "Service charge is completely independent").
pub fn resolve_service_charge(requested: Option<i64>) -> AppResult<i64> {
    match requested {
        None => Ok(0),
        Some(amount) if amount >= 0 => Ok(amount),
        Some(_) => Err(AppError::validation("settings.invalid_service_charge")),
    }
}

/// How many CALENDAR MONTHS the monthly sales comparison chart covers.
///
/// This is cafe configuration, so it lives in `app_settings` next to every other
/// Station setting and is read through the same typed accessor. It is a REPORTING
/// window, never a business rule: the repository, the SQL and the chart are all
/// period-agnostic, and this value only says how many month buckets the caller
/// asks for.
///
/// The allowed values are a CLOSED SET rather than a free number, because a
/// month count is a presentation choice, not an input: 6 / 12 / 18 / 24 cover a
/// quarter, a trading year, a year and a half and two years, and every one of
/// them keeps a grouped bar chart readable. A free number would only invite `0`,
/// negatives and four-digit values that no screen can render, so the same set
/// validates the saved value AND the value a caller passes at read time.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct MonthlySalesPeriodConfig {
    /// Number of calendar-month buckets, INCLUDING the current month.
    pub months: i64,
}

/// The supported windows, in ascending order. The default is the middle one: a
/// full trading year, the smallest window in which a month-over-month reading
/// still means something.
pub const MONTHLY_SALES_PERIOD_MONTHS: [i64; 4] = [6, 12, 18, 24];

impl Default for MonthlySalesPeriodConfig {
    fn default() -> Self {
        Self { months: 12 }
    }
}

impl MonthlySalesPeriodConfig {
    /// The one validation rule, shared by the setter and the reader: the value
    /// must be one of the supported windows.
    pub fn validate(&self) -> AppResult<()> {
        if !MONTHLY_SALES_PERIOD_MONTHS.contains(&self.months) {
            return Err(AppError::validation(
                "settings.invalid_monthly_sales_period",
            ));
        }
        Ok(())
    }
}

/// MANAGER+ reads the configured window. An unset setting reads as the default,
/// so an installation that never configured it behaves exactly as it always has.
pub fn get_monthly_sales_period(conn: &Db) -> AppResult<MonthlySalesPeriodConfig> {
    let config = read_json(
        conn,
        "monthly_sales_period",
        MonthlySalesPeriodConfig::default(),
    )?;
    // A stored value from an older build that is no longer supported falls back
    // to the default instead of failing the whole report.
    if config.validate().is_ok() {
        Ok(config)
    } else {
        Ok(MonthlySalesPeriodConfig::default())
    }
}

/// ADMIN owns the monthly sales comparison window.
///
/// It is deliberately NOT one of the MANAGER-visible Dev Settings sections:
/// this window is a REPORTING/presentation choice, not one of the cafe's
/// operational levers, so the role allowlist keeps it ADMIN-only. The READ stays
/// MANAGER+ because the Sales and Expenses reports show this window to a manager.
pub fn set_monthly_sales_period(
    conn: &Db,
    actor: &User,
    config: &MonthlySalesPeriodConfig,
) -> AppResult<()> {
    crate::services::auth::require_role(actor, "ADMIN")
        .map_err(|_| AppError::unauthorized("auth.forbidden"))?;
    config.validate()?;
    write_json(conn, "monthly_sales_period", config)?;
    crate::services::audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "settings.monthly_sales_period_changed",
        "settings",
        Some("monthly_sales_period"),
        None,
        Some(&serde_json::to_value(config).unwrap_or_default()),
    )
}

/// Credit authorization config: mode LIST = only listed customers (default,
/// safest); mode ALL = every customer allowed. Final rules are pending —
/// both modes are configurable (DECISIONS.md #3).
fn credit_enabled_default() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreditConfig {
    #[serde(default = "credit_enabled_default")]
    pub enabled: bool,
    pub mode: String, // "LIST" | "ALL"
    pub allowed_customer_ids: Vec<i64>,
}

impl Default for CreditConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: "LIST".into(),
            allowed_customer_ids: Vec::new(),
        }
    }
}

/// Admin-configured discount QUICK-PICK amounts, in minor units.
///
/// Discounts are open-ended: this list is a set of shortcuts the POS offers,
/// NOT a whitelist and NOT a ceiling. Any positive amount up to the applicable
/// subtotal is accepted, whatever this list contains. A historical invoice
/// keeps the amount that was actually applied, so changing this list never
/// rewrites past records.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiscountOptionsConfig {
    /// Ordered fixed amounts in minor units (piastres).
    pub amounts: Vec<i64>,
}

impl Default for DiscountOptionsConfig {
    fn default() -> Self {
        Self {
            amounts: Vec::new(),
        }
    }
}

pub fn get_discount_options(conn: &Db) -> AppResult<DiscountOptionsConfig> {
    read_json(conn, "discount_options", DiscountOptionsConfig::default())
}

/// MANAGER+ owns the discount quick-pick catalogue, exactly like the
/// service-charge amounts beside it. The VALIDATION is unchanged: amounts must
/// be positive and distinct — a duplicated or zero option is a configuration
/// mistake, never a sale. This changes only WHO may save the list, never WHAT
/// a discount may be (that stays `validate_discount_selection`, PIN included).
pub fn set_discount_options(conn: &Db, actor: &User, cfg: &DiscountOptionsConfig) -> AppResult<()> {
    crate::services::auth::require_role(actor, "MANAGER")
        .map_err(|_| AppError::unauthorized("auth.forbidden"))?;
    let mut unique = std::collections::HashSet::new();
    if cfg
        .amounts
        .iter()
        .any(|amount| *amount <= 0 || !unique.insert(*amount))
    {
        return Err(AppError::validation("settings.invalid_discount"));
    }
    write_json(conn, "discount_options", cfg)?;
    crate::services::audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "settings.discount_options_changed",
        "settings",
        Some("discount_options"),
        None,
        Some(&serde_json::to_value(cfg).unwrap_or_default()),
    )
}

/// One global shared discount-authorization PIN for the whole cafe.
///
/// The PIN is a STRING, never a number: `0097` is a valid PIN. It is stored as
/// an Argon2id PHC hash in `app_settings` (`discount_authorization_hash`) — the
/// same global-settings mechanism every other Station setting uses — and is
/// owned by NOBODY: any authenticated staff member who knows it may authorize a
/// discount. Only ADMIN/MANAGER may create or change it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiscountAuthorizationConfig {
    /// Administrator-facing status ONLY. The PIN itself never leaves the
    /// backend, and this boolean is never used to answer an authorization
    /// attempt (see `authorize_discount`).
    pub configured: bool,
}

pub fn get_discount_authorization(conn: &Db) -> AppResult<DiscountAuthorizationConfig> {
    let configured = read_json::<Option<String>>(conn, "discount_authorization_hash", None)?
        .is_some_and(|hash| !hash.is_empty());
    Ok(DiscountAuthorizationConfig { configured })
}

/// The shared PIN is exactly FOUR ASCII digits (`0`-`9`), leading zeros allowed.
///
/// This is deliberately NOT `validate_password`: the shared discount PIN is not
/// an account credential, so the account length rules never apply to it.
pub fn validate_discount_pin(pin: &str) -> AppResult<()> {
    let digits = pin.as_bytes();
    if digits.len() != 4 || !digits.iter().all(|b| b.is_ascii_digit()) {
        return Err(AppError::validation("discount.invalid_pin"));
    }
    Ok(())
}

/// MANAGER+ sets or changes THE ONE shared discount-authorization PIN.
///
/// There is no per-user target and no second credential: this is cafe-wide
/// configuration, hashed with the project's existing Argon2id implementation,
/// never returned to the frontend, and never written to the audit trail.
pub fn set_discount_authorization_pin(conn: &Db, actor: &User, pin: &str) -> AppResult<()> {
    crate::services::auth::require_role(actor, "MANAGER")
        .map_err(|_| AppError::unauthorized("auth.forbidden"))?;
    validate_discount_pin(pin)?;

    let was_configured = get_discount_authorization(conn)?.configured;
    let hash = crate::services::auth::hash_password(pin)?;
    write_json(conn, "discount_authorization_hash", &hash)?;

    // THAT the shared PIN changed — never the PIN, never the hash.
    crate::services::audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "settings.discount_authorization_changed",
        "settings",
        Some("discount_authorization"),
        Some(&serde_json::json!({ "configured": was_configured })),
        Some(&serde_json::json!({ "configured": true })),
    )
}

/// Verify THE shared discount-authorization PIN, and record who used it.
///
/// Identity and authorization are separate questions and stay separate here:
/// `actor` answers WHO performed the action (auditability), while `pin` answers
/// whether the person knows the ONE shared credential. The verification NEVER
/// consults the actor's login password, any other user's credentials, or any
/// per-user column — there is exactly one PIN for the system.
///
/// Failure is deliberately uniform — a missing PIN, a malformed PIN and a wrong
/// PIN all return the SAME error — so the POS can never probe whether a stored
/// hash exists.
pub fn authorize_discount(
    conn: &Db,
    actor: &User,
    order_id: i64,
    discount_minor: i64,
    pin: Option<&str>,
) -> AppResult<()> {
    let denied = || AppError::unauthorized("discount.authorization_failed");
    let Some(pin) = pin.filter(|value| validate_discount_pin(value).is_ok()) else {
        return Err(denied());
    };
    let hash = read_json::<Option<String>>(conn, "discount_authorization_hash", None)?;
    let Some(hash) = hash.filter(|value| !value.is_empty()) else {
        return Err(denied());
    };
    if !crate::services::auth::verify_password(pin, &hash) {
        return Err(denied());
    }

    // The authorization is audited against the operation it authorizes: the
    // authenticated actor, this order, this exact amount. The credential is
    // never part of the record.
    crate::services::audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "discount.authorized",
        "order",
        Some(&order_id.to_string()),
        None,
        Some(&serde_json::json!({
            "discount_minor": discount_minor,
            "result": "AUTHORIZED"
        })),
    )
}

pub fn get_credit_config(conn: &Db) -> AppResult<CreditConfig> {
    read_json(conn, "credit", CreditConfig::default())
}

pub fn customer_allowed_credit(conn: &Db, customer_id: i64) -> AppResult<bool> {
    let cfg = get_credit_config(conn)?;
    Ok(cfg.enabled && (cfg.mode == "ALL" || cfg.allowed_customer_ids.contains(&customer_id)))
}

pub fn set_credit_config(conn: &Db, actor: &User, cfg: &CreditConfig) -> AppResult<()> {
    crate::services::auth::require_role(actor, "MANAGER")
        .map_err(|_| AppError::unauthorized("auth.forbidden"))?;
    if !["LIST", "ALL"].contains(&cfg.mode.as_str()) {
        return Err(AppError::validation("credit.invalid_policy"));
    }
    if cfg.allowed_customer_ids.iter().any(|id| *id <= 0) {
        return Err(AppError::validation("credit.invalid_customer"));
    }
    write_json(conn, "credit", cfg)?;
    crate::services::audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "settings.credit_rules_changed",
        "settings",
        Some("credit"),
        None,
        Some(&serde_json::to_value(cfg).unwrap_or_default()),
    )
}

// ---------------------------------------------------------------------------
// MONTHLY REVENUE TARGETS (CAFE / WASH)
//
// Station has exactly TWO revenue departments, and they are the departments the
// invoice ITSELF splits into: `cafe_total` and `wash_total`. A target therefore
// exists for CAFE and WASH and for nothing else — `order_type` is not a revenue
// department, so TAKEAWAY and HYBRID never get a target of their own; a hybrid
// invoice simply contributes its cafe part to the cafe target and its wash part
// to the wash target, exactly as it already contributes to those two figures on
// the Sales page.
//
// # Two settings keys, because they have DIFFERENT lifetimes
//
// * `revenue_target_defaults` — the default for every month that has no explicit
//   override. One pair of numbers, editable in Dev Settings.
// * `revenue_target_months` — the overrides, keyed by canonical `YYYY-MM`.
//
// They are deliberately SEPARATE records rather than one blob with a nested
// map. That is what makes the required behaviour structural instead of
// careful: an override can never be rewritten by editing a default, because no
// code path writes one through the other, and a month that was overridden in
// October keeps October's number when the default is changed in November.
//
// # Money
//
// Amounts are `Money` — integers in minor units (piastres), like every other
// amount in Station. A target is stated in WHOLE POUNDS, so a stored target must
// be an exact multiple of 100 piastres; 150.50 EGP is not a target Station can
// hold, and is refused rather than rounded.
//
// # Authorization
//
// MANAGER+, like the other operational Dev Settings sections. A manager owns
// the cafe/wash yardstick and the current month's override of it; the role
// allowlist grants these two and nothing else here.

/// The cafe-wide default monthly targets, used by every month with no override.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct RevenueTargetDefaults {
    /// Default monthly CAFE revenue target, in minor units (piastres).
    pub cafe_minor: i64,
    /// Default monthly WASH revenue target, in minor units (piastres).
    pub wash_minor: i64,
}

/// The two revenue departments a target exists for.
///
/// This is a CLOSED SET on purpose. `order_type` values (`TAKEAWAY`, `CAFE`,
/// `WASH`, `HYBRID`) are NOT departments, and a type that named a target here
/// would create a target the invoice totals can never fill.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevenueDepartment {
    Cafe,
    Wash,
}

impl RevenueDepartment {
    /// The stored / transported name. Stable, so a saved configuration keeps
    /// working across builds.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cafe => "CAFE",
            Self::Wash => "WASH",
        }
    }
}

/// The effective target of ONE department for ONE month, and where it came from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MonthlyTarget {
    /// The month this target applies to, `YYYY-MM`.
    pub month: String,
    /// The department, `CAFE` | `WASH`.
    pub department: String,
    /// The effective target in minor units (piastres): override if present,
    /// otherwise the default.
    pub target_minor: i64,
    /// Whether the month carries its OWN override for this department. The UI
    /// states this rather than inferring it, so "overridden for October" and
    /// "inherited from the default" can never look the same.
    pub overridden: bool,
}

/// The month's OWN overrides, as stored. A department left absent here falls
/// back to the default — the "override cafe only" case, which is why the two
/// are `Option` rather than two mandatory zeros.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MonthTargetOverride {
    /// Override for this month's CAFE target.
    pub cafe_minor: Option<i64>,
    /// Override for this month's WASH target.
    pub wash_minor: Option<i64>,
}

impl MonthTargetOverride {
    /// Whether this override record carries nothing at all — in which case the
    /// month has no override and is removed from storage entirely rather than
    /// kept as an empty husk.
    pub fn is_empty(&self) -> bool {
        self.cafe_minor.is_none() && self.wash_minor.is_none()
    }

    /// The stored value for one department.
    pub fn get(&self, department: RevenueDepartment) -> Option<i64> {
        match department {
            RevenueDepartment::Cafe => self.cafe_minor,
            RevenueDepartment::Wash => self.wash_minor,
        }
    }

    /// A copy with one department's value replaced.
    fn with(&self, department: RevenueDepartment, value: Option<i64>) -> Self {
        match department {
            RevenueDepartment::Cafe => Self {
                cafe_minor: value,
                wash_minor: self.wash_minor,
            },
            RevenueDepartment::Wash => Self {
                cafe_minor: self.cafe_minor,
                wash_minor: value,
            },
        }
    }
}

/// The largest target Station accepts, in minor units: one trillion piastres,
/// i.e. ten billion Egyptian pounds. A café does not earn that in a month, so
/// anything above it is a typo or a hostile value, and refusing it keeps every
/// later percentage computation far away from an `i64` overflow.
pub const MAX_REVENUE_TARGET_MINOR: i64 = 1_000_000_000_000;

/// Whether a target is a legal monthly target. Three rules, one place:
///
/// * **whole pounds only** — a multiple of `MINOR_PER_MAJOR`, because that is
///   how a target is stated and Station stores no fractional targets;
/// * **not negative** — a negative target would make "remaining" and every
///   percentage derived from it meaningless rather than merely wrong;
/// * **inside the storage ceiling** — see [`MAX_REVENUE_TARGET_MINOR`].
///
/// Zero is legal on purpose: a month may genuinely have no target set, and that
/// is a state the progress display reports explicitly rather than refusing.
pub fn validate_revenue_target(amount_minor: i64) -> AppResult<()> {
    if amount_minor < 0
        || amount_minor % crate::money::MINOR_PER_MAJOR != 0
        || amount_minor > MAX_REVENUE_TARGET_MINOR
    {
        return Err(AppError::validation("settings.invalid_revenue_target"));
    }
    Ok(())
}

/// Validate a month key, returning it trimmed. A month is a key into stored
/// configuration, so a malformed one is refused rather than repaired — guessing
/// `2026-1` into `2026-01` would silently read a month nobody configured.
fn require_month(month: &str) -> AppResult<String> {
    let month = month.trim();
    if !crate::time::is_business_month(month) {
        return Err(AppError::validation(
            "settings.invalid_revenue_target_month",
        ));
    }
    Ok(month.to_string())
}

/// The stored cafe-wide defaults, treating an absent (or no-longer-legal)
/// record as "no target configured".
pub fn get_revenue_target_defaults(conn: &Db) -> AppResult<RevenueTargetDefaults> {
    let defaults = read_json(
        conn,
        "revenue_target_defaults",
        RevenueTargetDefaults::default(),
    )?;
    // A stored value that predates a rule change is treated as unset rather
    // than failing every screen that reads the target.
    if validate_revenue_target(defaults.cafe_minor).is_ok()
        && validate_revenue_target(defaults.wash_minor).is_ok()
    {
        Ok(defaults)
    } else {
        Ok(RevenueTargetDefaults::default())
    }
}

/// The month's stored overrides, empty when it has none.
pub fn get_revenue_target_overrides(conn: &Db, month: &str) -> AppResult<MonthTargetOverride> {
    let month = require_month(month)?;
    let all = read_json::<std::collections::HashMap<String, MonthTargetOverride>>(
        conn,
        "revenue_target_months",
        Default::default(),
    )?;
    Ok(all.get(&month).cloned().unwrap_or_default())
}

/// MANAGER+ sets the DEFAULT monthly targets.
///
/// Writing the defaults can never touch a month's override: the two live in
/// separate settings records and only this function writes the first one.
pub fn set_revenue_target_defaults(
    conn: &Db,
    actor: &User,
    defaults: &RevenueTargetDefaults,
) -> AppResult<()> {
    crate::services::auth::require_role(actor, "MANAGER")
        .map_err(|_| AppError::unauthorized("auth.forbidden"))?;
    validate_revenue_target(defaults.cafe_minor)?;
    validate_revenue_target(defaults.wash_minor)?;
    write_json(conn, "revenue_target_defaults", defaults)?;
    crate::services::audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "settings.revenue_target_defaults_changed",
        "settings",
        Some("revenue_target_defaults"),
        None,
        Some(&serde_json::to_value(defaults).unwrap_or_default()),
    )
}

/// MANAGER+ sets (or clears) ONE department's override for ONE month.
///
/// `amount` of `None` removes that department's override for that month, and the
/// month immediately resolves to the default again. The OTHER department's
/// override is untouched, which is what makes "override cafe only" and "clear
/// only the cafe override" ordinary operations rather than rewrites of the whole
/// month.
///
/// When the last override of a month is removed, the month's record is deleted
/// rather than stored empty: a month with no override and a month with an empty
/// override must not be two different things.
pub fn set_revenue_target_override(
    conn: &Db,
    actor: &User,
    month: &str,
    department: RevenueDepartment,
    amount: Option<i64>,
) -> AppResult<()> {
    crate::services::auth::require_role(actor, "MANAGER")
        .map_err(|_| AppError::unauthorized("auth.forbidden"))?;
    let month = require_month(month)?;
    if let Some(amount) = amount {
        validate_revenue_target(amount)?;
    }
    let mut all = read_json::<std::collections::HashMap<String, MonthTargetOverride>>(
        conn,
        "revenue_target_months",
        Default::default(),
    )?;
    let updated = all
        .get(&month)
        .cloned()
        .unwrap_or_default()
        .with(department, amount);
    if updated.is_empty() {
        all.remove(&month);
    } else {
        all.insert(month.clone(), updated);
    }
    write_json(conn, "revenue_target_months", &all)?;
    crate::services::audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "settings.revenue_target_override_changed",
        "settings",
        Some(&format!("revenue_target_months:{month}")),
        None,
        Some(&serde_json::json!({
            "month": month,
            "department": department.as_str(),
            "amount_minor": amount,
        })),
    )
}

/// **THE** target resolution — one function, one rule, every caller.
///
/// `resolve_monthly_target(month, department)` answers: what is this
/// department's target for this month? The month's override applies when the
/// month has one for THIS department, and the cafe-wide default applies
/// otherwise. Every screen, report and read that needs a target goes through
/// here; there is deliberately no second fallback written anywhere else, because
/// two fallbacks are how a Sales page and a report end up disagreeing about the
/// same month.
///
/// A month with no override therefore resolves to the CURRENT default, which is
/// the correct reading of "months without an override follow the default"; a
/// month WITH an override stays at the number that was set for it, which is what
/// keeps history from being rewritten by a later configuration change.
pub fn resolve_monthly_target(
    conn: &Db,
    month: &str,
    department: RevenueDepartment,
) -> AppResult<MonthlyTarget> {
    let month = require_month(month)?;
    let override_amount = get_revenue_target_overrides(conn, &month)?.get(department);
    let default = match department {
        RevenueDepartment::Cafe => get_revenue_target_defaults(conn)?.cafe_minor,
        RevenueDepartment::Wash => get_revenue_target_defaults(conn)?.wash_minor,
    };
    Ok(MonthlyTarget {
        month: month.clone(),
        department: department.as_str().to_string(),
        target_minor: override_amount.unwrap_or(default),
        overridden: override_amount.is_some(),
    })
}

/// Both departments' effective targets for one month — the pair a monthly
/// progress read needs, resolved through [`resolve_monthly_target`] so the pair
/// can never be assembled from a different rule than a single one.
pub fn resolve_monthly_targets(conn: &Db, month: &str) -> AppResult<[MonthlyTarget; 2]> {
    Ok([
        resolve_monthly_target(conn, month, RevenueDepartment::Cafe)?,
        resolve_monthly_target(conn, month, RevenueDepartment::Wash)?,
    ])
}