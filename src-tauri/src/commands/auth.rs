//! Tauri commands — authentication.
//!
//! Thin: resolve session → authorize → delegate to service/repository.
//!
//! There is deliberately NO staff/employee command here. Creating an account,
//! listing the roster and suspending a login all belong to the EMPLOYEES
//! surface, which owns the HR record and the login behind it in one place — a
//! manager can no longer deactivate a person through one screen and then find
//! them still listed in the other.

use super::common::{authorized, with_conn};
use crate::error::AppResult;
use crate::repositories::users;
use crate::services::auth;
use crate::AppState;
use tauri::State;

#[tauri::command(rename_all = "snake_case")]
pub fn login(state: State<'_, AppState>, input: auth::LoginInput) -> AppResult<auth::SessionInfo> {
    with_conn(&state, |conn| auth::login(conn, &input))
}

#[tauri::command(rename_all = "snake_case")]
pub fn logout(state: State<'_, AppState>, token: String) -> AppResult<()> {
    with_conn(&state, |conn| auth::logout(conn, &token))
}

/// Validate the stored session on app start (session restoration).
#[tauri::command(rename_all = "snake_case")]
pub fn me(state: State<'_, AppState>, token: String) -> AppResult<users::User> {
    with_conn(&state, |conn| auth::require_user(conn, &token))
}

#[tauri::command(rename_all = "snake_case")]
pub fn change_password(
    state: State<'_, AppState>,
    token: String,
    target_id: i64,
    new_password: String,
) -> AppResult<()> {
    authorized(&state, &token, "STAFF", |conn, actor| {
        auth::change_password(conn, actor, target_id, &new_password)
    })
}

/// The account cards the login screen offers.
///
/// **Unauthenticated on purpose**, and the ONLY command here that is: it has to
/// answer "who may sign in?" before anyone has signed in. It therefore returns
/// nothing but an id, a display name and a role — see
/// [`crate::repositories::users::LoginAccount`], which documents the projection.
///
/// Offering a card grants NOTHING. It is the same string a user would otherwise
/// have typed into a username field, carried to the very same
/// `auth::login`, which still verifies the Argon2 hash and still decides the
/// session. Choosing someone else's card therefore gets an attacker no closer
/// to a session than typing that person's name did.
#[tauri::command(rename_all = "snake_case")]
pub fn list_login_accounts(state: State<'_, AppState>) -> AppResult<Vec<users::LoginAccount>> {
    with_conn(&state, |conn| users::list_login_accounts(conn))
}
