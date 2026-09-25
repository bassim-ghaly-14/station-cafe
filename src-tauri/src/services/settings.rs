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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiscountAuthorizationConfig {
    pub configured: bool,
}

pub fn get_discount_authorization(conn: &Db) -> AppResult<DiscountAuthorizationConfig> {
    let configured = read_json::<Option<String>>(conn, "discount_authorization_hash", None)?
        .is_some_and(|hash| !hash.is_empty());
    Ok(DiscountAuthorizationConfig { configured })
}

pub fn set_discount_authorization_password(
    conn: &Db,
    actor: &User,
    password: &str,
) -> AppResult<()> {
    crate::services::auth::require_role(actor, "ADMIN")
        .map_err(|_| AppError::unauthorized("auth.forbidden"))?;
    if password.len() < 6 {
        return Err(AppError::validation("discount.password_too_short"));
    }
    let hash = crate::services::auth::hash_password(password)?;
    write_json(conn, "discount_authorization_hash", &hash)?;
    crate::services::audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "settings.discount_authorization_changed",
        "settings",
        Some("discount_authorization"),
        None,
        Some(&serde_json::json!({ "configured": true })),
    )
}

pub fn authorize_discount(conn: &Db, password: Option<&str>) -> AppResult<()> {
    if matches!(password, Some(p) if !p.is_empty()) {
        let hash = read_json::<Option<String>>(conn, "discount_authorization_hash", None)?
            .ok_or_else(|| AppError::unauthorized("discount.password_required"))?;
        if crate::services::auth::verify_password(password.unwrap_or_default(), &hash) {
            return Ok(());
        }
    }
    Err(AppError::unauthorized("discount.password_incorrect"))
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
