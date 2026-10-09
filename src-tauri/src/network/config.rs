//! Local API configuration — the single source of truth for the listener.
//!
//! Stored in the existing `app_settings` JSON store (like `printer` and
//! `service_charge`), so it needs no migration and inherits the same
//! MANAGER+-only write policy from `services::settings`.

use crate::error::{AppError, AppResult};
use crate::repositories::Db;
use crate::services::auth::User;
use serde::{Deserialize, Serialize};

/// The settings key. Namespaced so it can never collide with business config.
pub const SETTINGS_KEY: &str = "network";

/// Default TCP port for the local API.
///
/// Chosen in the dynamic/private range (49152-65535) to avoid colliding with
/// anything a Windows machine is likely to be running.
pub const DEFAULT_PORT: u16 = 47821;

/// Lowest port the app will bind. Ports below 1024 need elevated privileges
/// and are almost never the right answer on a cafe PC.
const MIN_PORT: u16 = 1024;

/// Address meaning "every interface".
pub const ANY_INTERFACE: &str = "0.0.0.0";

/// Address meaning "the LAN interface only" — resolved at bind time from the
/// machine's real interfaces, never hardcoded to a guessed subnet.
pub const LAN_INTERFACE: &str = "lan";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NetworkConfig {
    /// Master switch. When false nothing binds and no port is opened.
    pub enabled: bool,
    /// `LAN_INTERFACE` (default) or a literal address. Only MANAGER/ADMIN may
    /// set a literal address, and the ANY_INTERFACE case is refused outright
    /// (see `set`) because it would expose the API on every adapter.
    pub bind: String,
    pub port: u16,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            // Off by default: Station is a local desktop POS, and opening a
            // listening socket is a decision the owner makes deliberately.
            enabled: false,
            bind: LAN_INTERFACE.to_string(),
            port: DEFAULT_PORT,
        }
    }
}

/// Read the stored configuration, falling back to the default.
pub fn get(conn: &Db) -> AppResult<NetworkConfig> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [SETTINGS_KEY],
            |r| r.get(0),
        )
        .ok();
    match raw {
        // A malformed value must not stop the app from starting; the safe
        // fallback is "off", not "on".
        Some(v) => Ok(serde_json::from_str(&v).unwrap_or_default()),
        None => Ok(NetworkConfig::default()),
    }
}

/// Validate and persist the configuration. MANAGER+.
pub fn set(conn: &Db, actor: &User, cfg: &NetworkConfig) -> AppResult<()> {
    crate::services::auth::require_role(actor, "MANAGER")?;

    if cfg.port < MIN_PORT {
        return Err(AppError::validation("network.invalid_port"));
    }
    // Binding every interface would publish the API on the VPN, on a tethered
    // hotspot, or on a second network the cafe does not control. There is no
    // legitimate reason for it here, so it is refused rather than warned about.
    if cfg.bind.trim() == ANY_INTERFACE || cfg.bind.trim() == "::" {
        return Err(AppError::validation("network.bind_not_permitted"));
    }
    // A loopback bind is equally useless: nothing on the LAN can reach it, and
    // the access QR would encode an address that resolves to the scanning
    // device itself. Refused here so it can never be configured in the first
    // place.
    if let Ok(ip) = cfg.bind.trim().parse::<std::net::IpAddr>() {
        if ip.is_loopback() || ip.is_unspecified() {
            return Err(AppError::validation("network.bind_not_permitted"));
        }
    }

    let json = serde_json::to_string(cfg)
        .map_err(|e| AppError::internal(format!("serialize network config: {e}")))?;
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = station_now()",
        rusqlite::params![SETTINGS_KEY, json],
    )?;
    crate::services::audit::record(
        conn,
        Some(actor.id),
        Some(&actor.role),
        "settings.network_changed",
        "settings",
        None,
        None,
        Some(&serde_json::json!({
            "enabled": cfg.enabled,
            "bind": cfg.bind,
            "port": cfg.port,
        })),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate;
    use crate::demo_data::seed_for_development as run_if_empty;
    use rusqlite::Connection;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        run_if_empty(&conn).unwrap();
        conn
    }

    fn login_as(conn: &Connection, name: &str) -> User {
        crate::services::auth::login(
            conn,
            &crate::services::auth::LoginInput {
                name: name.into(),
                password: crate::demo_data::demo_password_of(name)
                    .unwrap_or_else(|| panic!("{name} is not a seeded demo account"))
                    .into(),
            },
        )
        .unwrap()
        .user
    }

    #[test]
    fn default_is_disabled_so_no_port_opens_without_a_deliberate_choice() {
        let cfg = NetworkConfig::default();
        assert!(!cfg.enabled);
        assert_eq!(cfg.bind, LAN_INTERFACE);
        assert_eq!(cfg.port, DEFAULT_PORT);
    }

    #[test]
    fn a_manager_can_save_and_read_back_the_configuration() {
        let conn = fresh();
        let cfg = NetworkConfig {
            enabled: true,
            bind: LAN_INTERFACE.into(),
            port: 47899,
        };
        set(&conn, &login_as(&conn, "manager"), &cfg).unwrap();
        assert_eq!(get(&conn).unwrap(), cfg);
    }

    #[test]
    fn staff_cannot_change_the_network_configuration() {
        // Enabling a listening socket is a management action. Authorization is
        // enforced in the service, not by hiding a control in the UI.
        let conn = fresh();
        let err = set(
            &conn,
            &login_as(&conn, "cashier"),
            &NetworkConfig::default(),
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Unauthorized(_)));
        assert!(
            !get(&conn).unwrap().enabled,
            "the write must not have landed"
        );
    }

    #[test]
    fn binding_every_interface_is_refused() {
        // 0.0.0.0 would publish the API on every adapter the machine has, and a
        // loopback bind is unreachable from the LAN while still producing a QR.
        let conn = fresh();
        let mgr = login_as(&conn, "manager");
        for bind in ["0.0.0.0", "::", "127.0.0.1", "::1"] {
            let err = set(
                &conn,
                &mgr,
                &NetworkConfig {
                    enabled: true,
                    bind: bind.into(),
                    port: DEFAULT_PORT,
                },
            )
            .unwrap_err();
            assert!(matches!(err, AppError::Validation(_)), "{bind} refused");
        }
    }

    #[test]
    fn a_privileged_port_is_refused() {
        let conn = fresh();
        let err = set(
            &conn,
            &login_as(&conn, "manager"),
            &NetworkConfig {
                enabled: true,
                bind: LAN_INTERFACE.into(),
                port: 80,
            },
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn a_corrupt_stored_value_falls_back_to_disabled_rather_than_enabling() {
        // Fail safe, not fail open: an unparseable value must never open a
        // listener the owner did not ask for.
        let conn = fresh();
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, 'not-json')",
            [SETTINGS_KEY],
        )
        .unwrap();
        assert_eq!(get(&conn).unwrap(), NetworkConfig::default());
    }

    #[test]
    fn a_network_change_is_audited() {
        let conn = fresh();
        set(
            &conn,
            &login_as(&conn, "manager"),
            &NetworkConfig {
                enabled: true,
                bind: LAN_INTERFACE.into(),
                port: 47830,
            },
        )
        .unwrap();
        let (action, after): (String, String) = conn
            .query_row(
                "SELECT action, after_json FROM audit_log
                 WHERE action = 'settings.network_changed'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(action, "settings.network_changed");
        assert!(after.contains("47830"));
    }
}
