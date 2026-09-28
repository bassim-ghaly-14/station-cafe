//! The lifecycle of the local service: apply a configuration, then make the
//! running reality match it.
//!
//! This module exists because of the defect it fixes. Previously the server was
//! started in exactly one place — application startup — from a setting that
//! nothing in the application could ever change. The result was a feature that
//! was permanently off, with no way to turn it on and no way to react to it
//! changing.
//!
//! Two ideas hold this together:
//!
//! 1. **CONFIGURED is not RUNNING.** `enabled` is intent; `running` is an
//!    observed fact — a bind that actually succeeded. They are separate fields
//!    and are never conflated, so a failed bind can never leave the UI claiming
//!    a reachable address.
//! 2. **APPLY is the only verb.** Startup, the settings command and the
//!    shutdown path all funnel through [`apply`], so a listener cannot end up
//!    running with the configuration disabled, or left stopped while the
//!    configuration says enabled.

use crate::error::AppResult;
use crate::network::config::{self, NetworkConfig};
use crate::network::mdns::Advertisement;
use crate::AppState;
use std::net::SocketAddr;
use std::sync::Arc;

/// What the local service is actually doing right now.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    /// The owner's intent, as stored.
    pub enabled: bool,
    /// Whether a listener is actually bound. NEVER derived from `enabled`.
    pub running: bool,
    /// The address actually bound, when running.
    pub address: Option<String>,
    /// Why the service is not running, when it is not. A stable machine key.
    pub error: Option<String>,
}

/// Reasons the service can be unavailable. Stable keys, never raw text.
pub const ERR_DISABLED: &str = "disabled";
pub const ERR_NO_LAN_ADDRESS: &str = "no_lan_address";
pub const ERR_BIND_FAILED: &str = "bind_failed";

/// Current observed state, without changing anything.
pub fn status(state: &AppState) -> RuntimeStatus {
    let running_addr = state
        .api
        .lock()
        .ok()
        .and_then(|g| g.as_ref().filter(|h| h.is_running()).map(|h| h.local_addr()));
    let enabled = state
        .conn
        .lock()
        .ok()
        .and_then(|c| config::get(&c).ok())
        .map(|c| c.enabled)
        .unwrap_or(false);

    match running_addr {
        Some(addr) => RuntimeStatus {
            enabled,
            running: true,
            address: Some(addr.to_string()),
            error: None,
        },
        None => RuntimeStatus {
            enabled,
            running: false,
            address: None,
            error: Some(if enabled {
                // Enabled but not listening can only mean the bind failed.
                ERR_BIND_FAILED.to_string()
            } else {
                ERR_DISABLED.to_string()
            }),
        },
    }
}

/// Make the running service match `cfg`.
///
/// Always tears the previous listener down first, so applying the same
/// configuration twice is safe and cannot leave two listeners competing for a
/// port. This is what makes it idempotent and restartable.
///
/// Never returns an error for a network condition: a cafe whose port is taken
/// must still open its till, so failure is reported in the returned status
/// instead of propagated.
pub fn apply(state: &AppState, cfg: &NetworkConfig) -> RuntimeStatus {
    // 1. Stop whatever is running. mDNS goes first, so we never advertise a
    //    service whose socket is on the way out.
    stop_inner(state);

    if !cfg.enabled {
        return status(state);
    }

    // 2. Resolve a genuinely usable LAN address. Never 0.0.0.0, never loopback.
    let ip = match crate::network::api::resolve_bind_address(&cfg.bind) {
        Ok(ip) if crate::network::address::is_usable(&ip) => ip,
        _ => {
            log::error!(
                "local api: no usable LAN address for bind {:?}; the POS is unaffected",
                cfg.bind
            );
            return unavailable(true, ERR_NO_LAN_ADDRESS);
        }
    };
    let addr = SocketAddr::new(ip, cfg.port);

    // 3. Bind. A failure here is a normal, recoverable condition.
    let handle = match crate::network::server::start(addr, Arc::clone(&state.conn)) {
        Ok(handle) => handle,
        Err(e) => {
            log::error!("local api: cannot bind {addr} ({e}); the POS is unaffected");
            return unavailable(true, ERR_BIND_FAILED);
        }
    };
    log::info!("local api: listening on http://{}", handle.local_addr());

    if let Ok(mut slot) = state.api.lock() {
        *slot = Some(handle);
    }

    // 4. Only now that the socket is genuinely bound do we advertise. mDNS
    //    must never point a manager at a service that does not exist.
    let discovery = Advertisement::register(addr.ip(), addr.port(), env!("CARGO_PKG_VERSION"));
    if let Ok(mut slot) = state.discovery.lock() {
        *slot = discovery.ok();
    }

    status(state)
}

fn unavailable(enabled: bool, error: &str) -> RuntimeStatus {
    RuntimeStatus {
        enabled,
        running: false,
        address: None,
        error: Some(error.to_string()),
    }
}

/// Stop the listener and unregister discovery, leaving no port held.
pub fn stop(state: &AppState) {
    stop_inner(state);
}

fn stop_inner(state: &AppState) {
    // mDNS first: a closed Station must not keep advertising itself.
    if let Ok(mut slot) = state.discovery.lock() {
        slot.take();
    }
    if let Ok(mut slot) = state.api.lock() {
        if let Some(handle) = slot.take() {
            handle.stop();
        }
    }
}

/// Persist `cfg` and immediately make the running service match it.
///
/// This is the enable/disable path the settings surface uses: one call both
/// remembers the choice and acts on it, so the two can never drift.
pub fn save_and_apply(
    state: &AppState,
    actor: &crate::services::auth::User,
    cfg: &NetworkConfig,
) -> AppResult<RuntimeStatus> {
    {
        let conn = state
            .conn
            .lock()
            .map_err(|_| crate::error::AppError::internal("database lock poisoned"))?;
        config::set(&conn, actor, cfg)?;
    }
    Ok(apply(state, cfg))
}

/// Read the stored configuration, for the settings surface.
pub fn current_config(state: &AppState) -> AppResult<NetworkConfig> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| crate::error::AppError::internal("database lock poisoned"))?;
    config::get(&conn)
}
