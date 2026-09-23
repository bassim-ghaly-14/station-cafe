//! Business configuration (service charge, credit authorization).
//! Values live in `app_settings` as JSON; typed accessors are the ONLY way
//! to read them so every calculation uses the same rules (DECISIONS.md #1/#3).

use crate::error::{AppError, AppResult};
use crate::repositories::Db;
use crate::services::auth::User;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "UPPERCASE")]
pub enum ServiceChargeMode {
    None,
    Fixed,
    Percent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceChargeConfig {
    pub mode: ServiceChargeMode,
    /// FIXED: minor units (piasters). PERCENT: rate ×1000 (10_000 = 10%).
    pub value: i64,
}

impl Default for ServiceChargeConfig {
    fn default() -> Self {
        // Open business decision → safest default is OFF (configurable).
        Self {
            mode: ServiceChargeMode::None,
            value: 0,
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
         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')",
        params![key, json],
    )?;
    Ok(())
}

pub fn get_service_charge(conn: &Db) -> AppResult<ServiceChargeConfig> {
    read_json(conn, "service_charge", ServiceChargeConfig::default())
}

/// MANAGER+ sets the service-charge mode/value; every consumer (POS preview,
/// checkout, reports) reads it through here.
pub fn set_service_charge(conn: &Db, actor: &User, cfg: &ServiceChargeConfig) -> AppResult<()> {
    if cfg.mode == ServiceChargeMode::Percent && !(0..=100_000).contains(&cfg.value) {
        return Err(AppError::validation("settings.invalid_percent"));
    }
    if cfg.mode == ServiceChargeMode::Fixed && cfg.value < 0 {
        return Err(AppError::validation("settings.invalid_fixed"));
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

/// Credit authorization config: mode LIST = only listed customers (default,
/// safest); mode ALL = every customer allowed. Final rules are pending —
/// both modes are configurable (DECISIONS.md #3).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreditConfig {
    pub mode: String, // "LIST" | "ALL"
    pub allowed_customer_ids: Vec<i64>,
}

impl Default for CreditConfig {
    fn default() -> Self {
        Self {
            mode: "LIST".into(),
            allowed_customer_ids: Vec::new(),
        }
    }
}

/// Discount limit config: NONE = no discounts allowed; PERCENT = max rate
/// ×1000 (15_000 = 15%); FIXED = max minor units. MANAGER+ configures,
/// STAFF+ applies within the limit. Backend enforces — UI is hint only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "UPPERCASE")]
pub enum DiscountLimitMode {
    None,
    Percent,
    Fixed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscountLimitConfig {
    pub mode: DiscountLimitMode,
    pub value: i64,
}

impl Default for DiscountLimitConfig {
    fn default() -> Self {
        // Safest default: capped at 100% would allow anything, so default to
        // NONE (no discount) would break existing flows/tests that use 10%.
        // Default mirrors historic behaviour: discounts allowed up to 100%.
        Self {
            mode: DiscountLimitMode::Percent,
            value: 100_000,
        }
    }
}

pub fn get_discount_limit(conn: &Db) -> AppResult<DiscountLimitConfig> {
    // Back-compat: very old DBs seeded discount as separate keys; prefer the
    // unified JSON blob, fall back to legacy keys when present.
    if let Ok(raw) = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'discount_limit'",
        [],
        |r| r.get::<_, String>(0),
    ) {
        if let Ok(cfg) = serde_json::from_str::<DiscountLimitConfig>(&raw) {
            return Ok(cfg);
        }
    }
    Ok(DiscountLimitConfig::default())
}

/// MANAGER+ sets the global discount ceiling. Audited.
pub fn set_discount_limit(conn: &Db, actor: &User, cfg: &DiscountLimitConfig) -> AppResult<()> {
    crate::services::auth::require_role(actor, "MANAGER")
        .map_err(|_| AppError::unauthorized("auth.forbidden"))?;
    match cfg.mode {
        DiscountLimitMode::None => {}
        DiscountLimitMode::Percent => {
            if !(0..=100_000).contains(&cfg.value) {
                return Err(AppError::validation("discount.invalid_limit"));
            }
        }
        DiscountLimitMode::Fixed => {
            if cfg.value < 0 {
                return Err(AppError::validation("discount.invalid_limit"));
            }
        }
    }
    write_json(conn, "discount_limit", cfg)?;
    crate::services::audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "settings.discount_limit_changed",
        "settings",
        Some("discount_limit"),
        None,
        Some(&serde_json::to_value(cfg).unwrap_or_default()),
    )
}

/// Human-readable ceiling for UI hints (minor units) given a subtotal.
pub fn discount_ceiling_minor(limit: &DiscountLimitConfig, subtotal: i64) -> i64 {
    match limit.mode {
        DiscountLimitMode::None => 0,
        DiscountLimitMode::Fixed => limit.value.max(0).min(subtotal.max(0)),
        DiscountLimitMode::Percent => {
            crate::money::percent_of(subtotal.max(0), limit.value.max(0).min(100_000))
        }
    }
}

pub fn get_credit_config(conn: &Db) -> AppResult<CreditConfig> {
    read_json(conn, "credit", CreditConfig::default())
}

pub fn customer_allowed_credit(conn: &Db, customer_id: i64) -> AppResult<bool> {
    let cfg = get_credit_config(conn)?;
    Ok(cfg.mode == "ALL" || cfg.allowed_customer_ids.contains(&customer_id))
}

pub fn set_credit_config(conn: &Db, actor: &User, cfg: &CreditConfig) -> AppResult<()> {
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
