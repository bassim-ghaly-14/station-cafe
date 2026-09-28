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

/// The local-access QR, for the manager's phone.
///
/// MANAGER+ because opening a network listener and showing its address is a
/// management action. Enforced by the shared `authorized` helper, so this is
/// the same role check the desktop surfaces use — not a second rule.
///
/// The returned payload is an ADDRESS and nothing more. It is assembled in
/// `network::qr` from the port the listener actually bound and this machine's
/// real IP, so it cannot contain a token: the URL is built from exactly four
/// parts and has no code path that appends a query string or credential.
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
        crate::network::config::get(&conn)?
    };
    // Authorization still runs, even though nothing is read from the
    // connection here, so the check cannot be skipped by a future edit.
    let actor = {
        let conn = state
            .conn
            .lock()
            .map_err(|_| AppError::internal("database lock poisoned"))?;
        crate::services::auth::require_user(&conn, &token)?
    };
    crate::services::auth::require_role(&actor, "MANAGER")?;

    // Read the live listener address so the QR always matches what is actually
    // being served, rather than a configured value that may not have bound.
    let running = state
        .api
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|h| h.local_addr()));
    let discovery = state.discovery.lock().map(|g| g.is_some()).unwrap_or(false);

    crate::network::qr::local_access(&cfg, running, discovery)
        .map_err(|e| AppError::internal(e))
}
