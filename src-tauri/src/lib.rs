//! Station Cafe — Tauri backend entry point.
//!
//! Architecture (see /docs/ARCHITECTURE.md):
//! UI (React) → Tauri commands → services → repositories → SQLite.
//! The UI never executes SQL directly; all data access lives here.

mod commands;
mod db;
mod error;
mod money;
mod seed;

use std::sync::Mutex;
use tauri::Manager;

/// Shared application state: connection pool is a single connection
/// (SQLite is file-based; serialize access through a mutex).
pub struct AppState {
    pub conn: Mutex<db::Db>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Open (or create) the SQLite database in the app data dir.
            let conn = db::open(&app.path().app_data_dir()?)?;
            db::migrate(&conn)?;
            // Seeding runs only when the DB is empty (fresh install);
            // it is deterministic and safe to re-run.
            seed::run_if_empty(&conn)?;

            app.manage(AppState { conn: Mutex::new(conn) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::db_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

