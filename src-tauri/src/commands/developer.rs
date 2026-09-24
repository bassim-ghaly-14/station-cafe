use crate::error::AppResult;
use crate::services::{auth, developer};
use crate::AppState;
use rand::RngCore;
use tauri::State;

/// Clear every application row, then recreate the one developer ADMIN account.
#[tauri::command(rename_all = "snake_case")]
pub fn clear_database(state: State<'_, AppState>, token: String) -> AppResult<String> {
    let actor = super::common::with_conn(&state, |conn| {
        let actor = auth::require_user(conn, &token)?;
        auth::require_role(&actor, "ADMIN")?;
        developer::clear_database(conn, &actor)?;
        Ok(actor)
    })?;

    let mut grant = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut grant);
    let value = grant.iter().map(|b| format!("{b:02x}")).collect::<String>();
    *state
        .developer_seed_grant
        .lock()
        .map_err(|_| crate::error::AppError::internal("developer grant lock poisoned"))? =
        Some((value.clone(), actor));
    Ok(value)
}

#[tauri::command(rename_all = "snake_case")]
pub fn load_official_data(
    state: State<'_, AppState>,
    token: Option<String>,
    reseed_token: Option<String>,
) -> AppResult<()> {
    let via_grant = reseed_token.as_ref().is_some_and(|value| {
        state
            .developer_seed_grant
            .lock()
            .ok()
            .and_then(|grant| grant.as_ref().map(|(expected, _)| expected == value))
            .unwrap_or(false)
    });

    let loaded = super::common::with_conn(&state, |conn| {
        if via_grant {
            let actor = state
                .developer_seed_grant
                .lock()
                .map_err(|_| crate::error::AppError::internal("developer grant lock poisoned"))?
                .as_ref()
                .map(|(_, actor)| actor.clone())
                .ok_or_else(|| crate::error::AppError::unauthorized("auth.invalid_session"))?;
            developer::load_official_data(conn, &actor)
        } else {
            let actor = auth::require_user(conn, token.as_deref().unwrap_or_default())?;
            developer::load_official_data(conn, &actor)
        }
    })?;

    if via_grant {
        *state
            .developer_seed_grant
            .lock()
            .map_err(|_| crate::error::AppError::internal("developer grant lock poisoned"))? = None;
    }
    Ok(loaded)
}
