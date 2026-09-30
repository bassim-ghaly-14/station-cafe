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
use crate::network::api;
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
/// No application handle, so the browser surface and the command bridge have
/// nothing to serve from. Reported rather than silently degraded.
pub const ERR_NO_APP_HANDLE: &str = "no_app_handle";

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

    // 2. Resolve the address to bind.
    //
    // Two DIFFERENT questions are answered here, and conflating them is what
    // made an enabled service silently never start:
    //
    //   * `LAN_INTERFACE` (or an empty bind) means "choose for me". That choice
    //     is made by the classifier, and it must be a genuinely usable LAN
    //     address — never loopback, never unspecified, never link-local.
    //   * a LITERAL address means the operator already decided. It is bound as
    //     written, because re-deciding it here would silently ignore them.
    //
    // The one thing refused in BOTH cases is the unspecified address: binding
    // 0.0.0.0/:: would publish the API on every adapter the machine has, which
    // is exactly what `config::set` refuses to store in the first place.
    //
    // Loopback is deliberately NOT refused here. It is refused at the
    // configuration layer, which is where an operator's choice is validated;
    // re-refusing it at bind time meant a caller that had already decided could
    // never open a socket at all, and the service reported itself unavailable
    // while its own setting said enabled.
    let auto = {
        let bind = cfg.bind.trim();
        bind.is_empty() || bind == config::LAN_INTERFACE
    };
    let ip = match api::resolve_bind_address(&cfg.bind) {
        Ok(ip) if !ip.is_unspecified() => ip,
        Ok(_) => {
            log::error!(
                "local api: refusing to bind the unspecified address {:?}; the POS is unaffected",
                cfg.bind
            );
            return unavailable(true, ERR_NO_LAN_ADDRESS);
        }
        Err(e) => {
            log::error!(
                "local api: no usable address for bind {:?} ({e}); the POS is unaffected",
                cfg.bind
            );
            return unavailable(true, ERR_NO_LAN_ADDRESS);
        }
    };
    // Only an AUTOMATIC choice is held to the classifier's standard.
    if auto && !crate::network::address::is_usable(&ip) {
        log::error!(
            "local api: selected address {ip} is not usable for a LAN bind; the POS is unaffected"
        );
        return unavailable(true, ERR_NO_LAN_ADDRESS);
    }
    let addr = SocketAddr::new(ip, cfg.port);

    // 3. Bind. A failure here is a normal, recoverable condition.
    //
    // The application handle is taken from the state, never from a global. It
    // is OPTIONAL: the JSON API needs only the database this function already
    // has, so a missing handle costs the browser surface and the command
    // bridge — both of which say so per request — but it does NOT stop the
    // socket from opening. Refusing to bind here is what made an enabled
    // service report itself unavailable while its own setting said enabled.
    let handle = match crate::network::server::start(
        addr,
        Arc::clone(&state.conn),
        state.app().cloned(),
    ) {
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
