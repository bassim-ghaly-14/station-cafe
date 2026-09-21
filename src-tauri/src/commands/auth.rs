// Tauri commands — auth & staff management.
// Thin: resolve session → authorize → delegate to service/repository.

use super::common::{authorized, with_conn};
use crate::error::{AppError, AppResult};
use crate::repositories::users;
use crate::services::auth;
use crate::AppState;
use serde::Deserialize;
use tauri::State;

#[tauri::command]
pub fn login(state: State<'_, AppState>, input: auth::LoginInput) -> AppResult<auth::SessionInfo> {
    with_conn(&state, |conn| auth::login(conn, &input))
}

#[tauri::command]
pub fn logout(state: State<'_, AppState>, token: String) -> AppResult<()> {
    with_conn(&state, |conn| auth::logout(conn, &token))
}

/// Validate the stored session on app start (session restoration).
#[tauri::command]
pub fn me(state: State<'_, AppState>, token: String) -> AppResult<users::User> {
    with_conn(&state, |conn| auth::require_user(conn, &token))
}

#[tauri::command]
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

#[derive(Deserialize)]
pub struct NewStaffInput {
    pub name: String,
    pub phone: Option<String>,
    pub role: String,
    pub password: String,
}

#[tauri::command]
pub fn create_staff(
    state: State<'_, AppState>,
    token: String,
    input: NewStaffInput,
) -> AppResult<i64> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::validation("user.name_required"));
    }
    if !auth::ROLES.contains(&input.role.as_str()) {
        return Err(AppError::validation("user.invalid_role"));
    }
    auth::validate_password(&input.password)?;
    let hash = auth::hash_password(&input.password)?;

    authorized(&state, &token, "MANAGER", move |conn, actor| {
        // Only ADMIN may create another ADMIN (privilege-escalation guard).
        if input.role == "ADMIN" && actor.role != "ADMIN" {
            return Err(AppError::unauthorized("auth.admin_only"));
        }
        let id = users::insert(
            conn,
            &users::NewUser {
                name: &name,
                phone: input.phone.as_deref(),
                role: &input.role,
                password_hash: &hash,
                is_seed: false,
            },
        )?
        .ok_or_else(|| AppError::conflict("user.name_taken"))?;
        crate::services::audit::record(
            conn,
            Some(actor.id),
            Some(&actor.role),
            "user.created",
            "user",
            Some(&id.to_string()),
            None,
            Some(&serde_json::json!({ "name": name, "role": input.role })),
        )?;
        Ok(id)
    })
}

#[tauri::command]
pub fn list_staff(state: State<'_, AppState>, token: String) -> AppResult<Vec<users::User>> {
    authorized(&state, &token, "MANAGER", |conn, _actor| users::list(conn))
}

#[tauri::command]
pub fn set_staff_status(
    state: State<'_, AppState>,
    token: String,
    user_id: i64,
    status: String,
) -> AppResult<()> {
    if !["ACTIVE", "SUSPENDED"].contains(&status.as_str()) {
        return Err(AppError::validation("user.invalid_status"));
    }
    authorized(&state, &token, "MANAGER", move |conn, actor| {
        if actor.id == user_id {
            return Err(AppError::business("user.cannot_suspend_self"));
        }
        let target = users::find_by_id(conn, user_id)?
            .ok_or_else(|| AppError::not_found("user.not_found"))?;
        if target.role == "ADMIN" && actor.role != "ADMIN" {
            return Err(AppError::unauthorized("auth.admin_only"));
        }
        users::set_status(conn, user_id, &status)?;
        crate::services::audit::record(
            conn,
            Some(actor.id),
            Some(&actor.role),
            "user.status_changed",
            "user",
            Some(&user_id.to_string()),
            Some(&serde_json::json!({ "status": target.status })),
            Some(&serde_json::json!({ "status": status })),
        )
    })
}