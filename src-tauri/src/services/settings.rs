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
pub fn set_service_charge(conn: &Db, actor: &User, cfg: &ServiceChargeConfig) -> AppResult<()> {
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

/// MANAGER+ configures how many months the monthly sales comparison shows.
pub fn set_monthly_sales_period(
    conn: &Db,
    actor: &User,
    config: &MonthlySalesPeriodConfig,
) -> AppResult<()> {
    crate::services::auth::require_role(actor, "MANAGER")
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

/// ADMIN owns the discount catalogue. Amounts must be positive and unique —
/// a duplicated or zero option is a configuration mistake, never a sale.
pub fn set_discount_options(conn: &Db, actor: &User, cfg: &DiscountOptionsConfig) -> AppResult<()> {
    crate::services::auth::require_role(actor, "ADMIN")
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
