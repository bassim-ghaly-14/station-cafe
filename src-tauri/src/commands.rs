//! Tauri IPC commands exposed to the frontend.
//! Commands stay thin: validation/orchestration only — business logic
//! belongs in services (Phase 1), data access in repositories.

use crate::AppState;
use tauri::State;

#[derive(serde::Serialize)]
pub struct DbStatus {
    pub ok: bool,
    pub schema_version: i64,
}

/// Health-check command used by the frontend on startup to verify the
/// database is reachable and to learn the applied schema version.
#[tauri::command]
pub fn db_status(state: State<'_, AppState>) -> Result<DbStatus, crate::error::AppError> {
    let conn = state.conn.lock().map_err(|_| {
        crate::error::AppError::Internal("database lock poisoned".into())
    })?;
    let version: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM _migrations",
        [],
        |row| row.get(0),
    )?;
    Ok(DbStatus { ok: true, schema_version: version })
}
