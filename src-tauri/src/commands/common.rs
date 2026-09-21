// Shared command helpers: connection access + session/role resolution.
use crate::error::{AppError, AppResult};
use crate::repositories::{users, Db};
use crate::services::auth;
use crate::AppState;
use tauri::State;

pub fn with_conn<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&Db) -> AppResult<T>,
) -> AppResult<T> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| AppError::internal("database lock poisoned"))?;
    f(&conn)
}

/// Resolve + authorize the caller, then run `f` with the connection and user.
pub fn authorized<T>(
    state: &State<'_, AppState>,
    token: &str,
    min_role: &str,
    f: impl FnOnce(&Db, &users::User) -> AppResult<T>,
) -> AppResult<T> {
    with_conn(state, |conn| {
        let user = auth::require_user(conn, token)?;
        auth::require_role(&user, min_role)?;
        f(conn, &user)
    })
}
