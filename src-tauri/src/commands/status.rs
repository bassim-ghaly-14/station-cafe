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
#[tauri::command]
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
    Ok(DbStatus { ok: true, schema_version: version })
}