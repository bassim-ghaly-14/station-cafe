//! Station Cafe — Tauri backend entry point.
//!
//! Architecture (see /docs/ARCHITECTURE.md):
//! UI (React) → Tauri commands → services → repositories → SQLite.
//! The UI never executes SQL directly; all data access lives here.

// EXPECTED_UNUSED_PENDING_PHASE2: the backend implements the full Phase 2
// service/repository/command surface ahead of frontend consumption. Dead-code
// warnings are suppressed here until every command is wired into the UI;
// remove this attribute once Phase 2 wiring is complete.
#![allow(dead_code)]

mod commands;
mod db;
mod error;
mod money;
mod printing;
mod repositories;
mod seed;
mod services;
#[cfg(test)]
mod workflow_test;

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
        // NOTE: no updater plugin — tauri-plugin-updater requires a
        // `plugins.updater` config (pubkey/endpoints) in tauri.conf.json;
        // registering it without config crashes the app at startup. This is a
        // fully-offline application; re-add the plugin together with its
        // configuration when auto-update is actually introduced.
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

            app.manage(AppState {
                conn: Mutex::new(conn),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::status::db_status,
            commands::auth::login,
            commands::auth::logout,
            commands::auth::me,
            commands::auth::change_password,
            commands::auth::create_staff,
            commands::auth::list_staff,
            commands::auth::set_staff_status,
            commands::catalog::list_products,
            commands::catalog::create_product,
            commands::catalog::set_product_price,
            commands::catalog::set_product_active,
            commands::catalog::rename_product,
            commands::catalog::get_service_charge,
            commands::catalog::set_service_charge,
            commands::catalog::get_credit_config,
            commands::catalog::set_credit_config,
            commands::catalog::get_discount_limit,
            commands::catalog::set_discount_limit,
            commands::customers::search_customers,
            commands::customers::list_cars_of,
            commands::customers::find_cars_by_plate,
            commands::customers::create_customer,
            commands::customers::update_customer,
            commands::customers::create_car,
            commands::pos::list_tables,
            commands::pos::open_table,
            commands::pos::close_empty_table,
            commands::pos::start_order,
            commands::pos::start_takeaway,
            commands::pos::list_open_takeaway_orders,
            commands::pos::discard_order,
            commands::pos::get_order,
            commands::pos::add_order_line,
            commands::pos::set_line_quantity,
            commands::pos::remove_order_line,
            commands::pos::mark_ready_to_pay,
            commands::pos::attach_customer,
            commands::pos::detach_customer,
            commands::pos::get_order_customer,
            commands::pos::preview_order,
            commands::pos::issue_wash_ticket,
            commands::pos::checkout_order,
            commands::pos::get_invoice,
            commands::pos::search_invoices,
            commands::pos::cancel_invoice,
            commands::pos::list_credit_accounts,
            commands::pos::settle_credit,
            commands::shifts::day_shift_state,
            commands::shifts::open_business_day,
            commands::shifts::open_shift,
            commands::shifts::close_shift,
            commands::shifts::close_business_day,
            commands::shifts::list_shifts,
            commands::shifts::shift_report,
            commands::shifts::day_report,
            commands::ops::list_stock,
            commands::ops::list_stock_movements,
            commands::ops::adjust_stock,
            commands::ops::set_stock_minimum,
            commands::ops::list_expenses,
            commands::ops::create_expense,
            commands::ops::today_summary,
            commands::ops::sales_by_day,
            commands::ops::product_sales,
            commands::ops::list_audit,
            commands::ops::get_print_config,
            commands::ops::set_print_config,
            commands::ops::print_test,
            commands::ops::print_invoice,
            commands::ops::print_wash_ticket,
            commands::ops::preview_order_document,
            commands::ops::preview_invoice,
            commands::ops::preview_wash_ticket,
            commands::ops::print_shift_report,
            commands::ops::print_day_report_cmd,
            commands::ops::list_print_jobs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
