//! Health-check / status commands.

use crate::error::{AppError, AppResult};
use crate::AppState;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub struct DbStatus {
    pub ok: bool,
    pub schema_version: i64,
}

/// Health-check command used by the frontend on startup to verify the
/// database is reachable and to learn the applied schema version.
#[tauri::command(rename_all = "snake_case")]
pub fn db_status(state: State<'_, AppState>) -> AppResult<DbStatus> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::internal("database lock poisoned"))?;
    let version: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM _migrations",
        [],
        |row| row.get(0),
    )?;
    Ok(DbStatus {
        ok: true,
        schema_version: version,
    })
}

/// Resolve the caller as MANAGER+, returning the stored configuration.
fn require_manager(
    state: &State<'_, AppState>,
    token: &str,
) -> AppResult<crate::network::config::NetworkConfig> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::internal("database lock poisoned"))?;
    let actor = crate::services::auth::require_user(&conn, token)?;
    crate::services::auth::require_role(&actor, "MANAGER")?;
    crate::network::config::get(&conn)
}

/// Resolve the caller only, without reading configuration.
fn require_manager_user(state: &State<'_, AppState>, token: &str) -> AppResult<crate::services::auth::User> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::internal("database lock poisoned"))?;
    let actor = crate::services::auth::require_user(&conn, token)?;
    crate::services::auth::require_role(&actor, "MANAGER")?;
    Ok(actor)
}

/// The local-access QR, for any signed-in Station user.
///
/// AUTHENTICATED, not MANAGER+: the QR Code page is a destination every role may
/// open, so a cashier can show the code at the till. That is safe precisely
/// because of what the payload is — `network::qr` assembles an ADDRESS and
/// nothing else: no token, no session, no PIN, no data. A QR is a sticker on a
/// counter that anyone nearby can photograph, so nothing secret can be in it,
/// and the user still signs in on their own account after scanning.
///
/// This relaxation is deliberately NARROW. It applies to reading the code and
/// to nothing else: `get_network_config` stays MANAGER+ and
/// `set_network_config` still activates and deactivates the service behind
/// `auth::require_role`, so the Dev Settings surface and every control on it
/// keep exactly the authorization they had.
#[tauri::command(rename_all = "snake_case")]
pub fn local_access_qr(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<crate::network::qr::LocalAccess> {
    let cfg = {
        let conn = state
            .conn
            .lock()
            .map_err(|_| AppError::internal("database lock poisoned"))?;
        // Any valid session may read the code; the CONFIGURATION it reflects
        // stays a manager's business, which is why only the read is relaxed.
        crate::services::auth::require_user(&conn, &token)?;
        crate::network::config::get(&conn)?
    };
    // Read the LIVE listener address. A `url` is only produced when a listener
    // actually exists, so a stopped service can never be shown as reachable.
    let running = state
        .api
        .lock()
        .ok()
        .and_then(|g| g.as_ref().filter(|h| h.is_running()).map(|h| h.local_addr()));
    let discovery = state.discovery.lock().map(|g| g.is_some()).unwrap_or(false);

    crate::network::qr::local_access(&cfg, running, discovery).map_err(AppError::internal)
}

/// The stored local-API configuration, for the settings surface.
#[tauri::command(rename_all = "snake_case")]
pub fn get_network_config(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<crate::network::config::NetworkConfig> {
    require_manager(&state, &token)
}

/// Persist the local-API configuration AND make the running service match it.
///
/// This is the command whose absence WAS the defect: `enabled` could be stored
/// by nothing, so the API was permanently off with no way to switch it on. One
/// call now both remembers the choice and acts on it, so they cannot drift.
///
/// Returns the OBSERVED runtime status, which is deliberately not the same
/// thing as the setting: a bind that failed reports `running: false` even
/// though `enabled` is `true`.
#[tauri::command(rename_all = "snake_case")]
pub fn set_network_config(
    state: State<'_, AppState>,
    token: String,
    config: crate::network::config::NetworkConfig,
) -> AppResult<crate::network::runtime::RuntimeStatus> {
    let actor = require_manager_user(&state, &token)?;
    crate::network::runtime::save_and_apply(&state, &actor, &config)
}

/// Observed runtime state, independent of the setting.
#[tauri::command(rename_all = "snake_case")]
pub fn local_api_status(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<crate::network::runtime::RuntimeStatus> {
    require_manager(&state, &token)?;
    Ok(crate::network::runtime::status(&state))
}
