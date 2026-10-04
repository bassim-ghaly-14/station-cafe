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

#[cfg(test)]
mod analytics_test;
#[cfg(test)]
mod attendance_override_test;
mod commands;
#[cfg(test)]
mod customer_analytics_test;
mod db;
mod demo_data;
#[cfg(test)]
mod deletion_test;
#[cfg(test)]
mod employees_test;
#[cfg(test)]
mod employee_financials_test;
#[cfg(test)]
mod invoice_identity_test;
mod error;
mod network;
#[cfg(test)]
mod network_test;
// THE LAN HTTP CONTRACT, kept apart because it spans the socket, the response
// writer, the bind address, the advertised name and the two QR URLs at once.
#[cfg(test)]
mod network_lan_http_test;
#[cfg(test)]
mod dev_settings_roles_test;
#[cfg(test)]
mod expense_categories_test;
mod expenses_analytics_test;
mod money;
#[cfg(test)]
mod monthly_executive_test;
mod normalize;
#[cfg(test)]
mod offline_verify;
#[cfg(test)]
mod pos_rules_test;
mod printing;
#[cfg(test)]
mod reconciliation_test;
#[cfg(test)]
mod revenue_targets_test;
mod repositories;
#[cfg(test)]
mod sales_analytics_test;
mod seed;
mod services;
#[cfg(test)]
mod table_lifecycle_test;
#[cfg(test)]
mod workflow_test;

pub mod time;
mod wash_tickets_test;

use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

/// Shared application state: connection pool is a single connection
/// (SQLite is file-based; serialize access through a mutex).
///
/// The connection is behind an `Arc` because the local HTTP API thread shares
/// THE SAME connection rather than opening its own. One connection, one mutex,
/// one set of transactions: the network surface cannot interleave with the POS
/// any differently from a second desktop command.
pub struct AppState {
    pub conn: Arc<Mutex<db::Db>>,
    /// One-time, non-persistent authorization for the mandated clear→seed flow.
    pub developer_seed_grant: Mutex<Option<(String, services::auth::User)>>,
    /// The running local API listener, if the owner enabled it. `None` means no
    /// port is open. Dropping the app closes it.
    pub api: Mutex<Option<network::server::ServerHandle>>,
    /// The mDNS advertisement, if discovery started AND the name verified
    /// resolvable. Purely optional: `None` leaves the API fully usable by IP,
    /// which is what the QR code then encodes. A name that could not be
    /// resolved is deliberately NOT kept — see `network::runtime`.
    pub discovery: Mutex<Option<network::mdns::Advertisement>>,
    /// The running application handle, stored so the local HTTP listener can
    /// reach the two things it must serve without a second implementation:
    /// the embedded Station assets and the real `State<AppState>` that the
    /// commands take.
    ///
    /// It is `Option` because the state is built before the handle is managed,
    /// and because unit tests construct `AppState` with no Tauri runtime at
    /// all. When it is `None` the API still serves health and login; only the
    /// browser application and the command surface are unavailable, and that is
    /// reported honestly rather than faked.
    pub handle: OnceLock<tauri::AppHandle>,
}

impl AppState {
    /// The application handle, when this state is running inside Tauri.
    pub fn app(&self) -> Option<&tauri::AppHandle> {
        self.handle.get()
    }
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Updater plugin — build infrastructure only.
        //
        // tauri-plugin-updater REQUIRES a `plugins.updater` config (pubkey +
        // endpoints) in tauri.conf.json; registering it without that config
        // aborts at startup. That config is now present, and `pubkey` is the
        // PUBLIC half only. The private signing key never enters this
        // repository: it exists solely as the CI secret
        // TAURI_SIGNING_PRIVATE_KEY used by the release workflow.
        //
        // The UI calls this plugin DIRECTLY, from the frontend, through the
        // tauri-plugin-updater JS API -- never through a Station command and
        // never through the LAN `api/v1/cmd` bridge. Adding a custom Rust
        // updater command would create a second path to the same signed
        // channel with its own error surface; the plugin is the channel.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Relaunch, so a manager sees Station reopen on the new version after
        // a successful install. `process:allow-restart` in
        // capabilities/default.json is the matching webview permission; the
        // capability set is asserted in src/lib/releaseIntegrity.test.ts.
        .plugin(tauri_plugin_process::init())
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

            // The local API shares the POS's own connection, so it competes
            // for the lock exactly as a desktop command does and can never
            // observe or mutate a different copy of the business data.
            let conn = Arc::new(Mutex::new(conn));
            let stored = network::config::get(&conn.lock().unwrap_or_else(|e| e.into_inner()))
                .unwrap_or_default();

            // Startup and the settings toggle go through the SAME `apply`
            // verb, so a service started by launching Station and a service
            // started by switching it on cannot behave differently.
            //
            // Failure is never fatal: `apply` reports it in the returned
            // status and Station carries on. A cafe whose port is taken must
            // still open its till.
            let api = {
                let state = AppState {
                    conn: Arc::clone(&conn),
                    developer_seed_grant: Mutex::new(None),
                    api: Mutex::new(None),
                    discovery: Mutex::new(None),
                    // Stored BEFORE the listener is applied, because starting the
                    // local service is what needs it: the listener serves the
                    // Station application out of the embedded assets and reaches
                    // the real commands through this handle.
                    handle: OnceLock::new(),
                };
                let _ = state.handle.set(app.handle().clone());
                let status = network::runtime::apply(&state, &stored);
                log::info!(
                    "local api: configured={} running={} {}",
                    status.enabled,
                    status.running,
                    status.error.as_deref().unwrap_or("")
                );
                state
            };

            app.manage(api);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window ends the session: stop advertising, stop
            // accepting connections and release the port, rather than leaving
            // a listener behind or a phantom service on the cafe network.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    network::runtime::stop(&state);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::status::db_status,
            commands::status::local_access_qr,
            commands::status::get_network_config,
            commands::status::set_network_config,
            commands::status::local_api_status,
            commands::auth::login,
            commands::auth::logout,
            commands::auth::me,
            commands::auth::change_password,
            commands::auth::list_login_accounts,
            commands::catalog::list_products,
            commands::catalog::list_categories,
            commands::catalog::create_category,
            commands::catalog::update_category,
            commands::catalog::delete_category,
            commands::catalog::create_product,
            commands::catalog::update_product,
            commands::catalog::set_product_price,
            commands::catalog::set_product_active,
            commands::catalog::delete_product,
            commands::catalog::rename_product,
            commands::catalog::get_service_charge,
            commands::catalog::get_monthly_sales_period,
            commands::catalog::set_monthly_sales_period,
            commands::catalog::get_revenue_targets,
            commands::catalog::set_revenue_targets,
            commands::catalog::set_revenue_target_override,
            commands::catalog::set_service_charge,
            commands::catalog::get_credit_config,
            commands::catalog::set_credit_config,
            commands::catalog::get_discount_options,
            commands::catalog::set_discount_options,
            commands::catalog::get_discount_authorization,
            commands::catalog::set_discount_authorization_pin,
            commands::customers::search_customers,
            commands::customers::list_customers,
            commands::customers::customer_overview,
            commands::customers::customer_details,
            commands::customers::list_cars_of,
            commands::customers::find_cars_by_plate,
            commands::customers::create_customer,
            commands::customers::update_customer,
            commands::customers::create_car,
            commands::customers::delete_customer,
            commands::sales::sales_overview,
            commands::sales::sales_invoices,
            commands::sales::sales_cashiers,
            commands::sales::sales_target_progress,
            commands::sales::sales_monthly,
            commands::pos::list_tables,
            commands::pos::table_lifecycle_counters,
            commands::pos::set_table_count,
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
            commands::pos::set_order_discount,
            commands::pos::attach_customer,
            commands::pos::detach_customer,
            commands::pos::get_order_customer,
            commands::pos::preview_order,
            commands::pos::issue_wash_ticket,
            commands::pos::list_daily_wash_tickets,
            commands::pos::checkout_order,
            commands::pos::get_invoice,
            commands::pos::search_invoices,
            commands::pos::list_credit_accounts,
            commands::pos::settle_credit,
            commands::shifts::day_shift_state,
            commands::shifts::open_business_day,
            commands::shifts::open_shift,
            commands::shifts::preview_shift_close,
            commands::shifts::close_shift,
            commands::shifts::preview_day_settlement,
            commands::shifts::settle_day,
            commands::shifts::day_settlement_history,
            commands::shifts::list_closed_shifts,
            commands::shifts::list_closed_business_days,
            commands::shifts::close_business_day,
            commands::shifts::preview_day_close,
            commands::shifts::list_shifts,
            commands::shifts::shift_report,
            commands::shifts::day_report,
            commands::ops::list_stock,
            commands::ops::list_stock_movements,
            commands::ops::adjust_stock,
            commands::ops::set_stock_minimum,
            commands::ops::list_expenses,
            commands::ops::expenses_overview,
            commands::ops::expenses_monthly,
            commands::ops::create_expense,
            commands::ops::list_expense_categories,
            commands::ops::create_expense_category,
            commands::ops::rename_expense_category,
            commands::ops::delete_expense_category,
            commands::ops::list_shift_expenses,
            commands::ops::today_summary,
            commands::ops::analytics_charts,
            commands::ops::monthly_executive_report,
            commands::ops::print_monthly_report,
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
            commands::ops::preview_shift_report,
            commands::ops::preview_day_report_cmd,
            commands::ops::print_day_report_cmd,
            commands::ops::list_print_jobs,
            commands::developer::clear_database,
            commands::developer::load_official_data,
            commands::developer::load_demo_data,
            commands::employees::list_employees,
            commands::employees::employee_overview,
            commands::employees::my_attendance,
            commands::employees::record_attendance,
            commands::employees::correct_attendance,
            commands::employees::override_employee_attendance,
            commands::employees::employee_details,
            commands::employees::create_employee,
            commands::employees::update_employee,
            commands::employees::set_employee_status,
            commands::employees::delete_employee,
            commands::employees::set_employee_base_salary,
            commands::employees::create_employee_advance,
            commands::employees::create_employee_deduction,
            commands::employees::reverse_employee_advance,
            commands::employees::payroll_preview,
            commands::employees::create_payroll_run,
            commands::employees::finalize_payroll_run,
            commands::employees::list_wash_workers,
            commands::employees::set_order_wash_employee,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

