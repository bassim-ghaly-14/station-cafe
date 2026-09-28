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
#[cfg(test)]
mod deletion_test;
#[cfg(test)]
mod employees_test;
mod error;
mod network;
#[cfg(test)]
mod network_test;
#[cfg(test)]
mod expense_categories_test;
mod expenses_analytics_test;
mod money;
mod normalize;
#[cfg(test)]
mod offline_verify;
#[cfg(test)]
mod pos_rules_test;
mod printing;
#[cfg(test)]
mod reconciliation_test;
mod repositories;
#[cfg(test)]
mod sales_analytics_test;
mod seed;
mod services;
#[cfg(test)]
mod workflow_test;

pub mod time;
mod wash_tickets_test;

use std::sync::{Arc, Mutex};
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
    /// The mDNS advertisement, if discovery started. Purely optional: `None`
    /// leaves the API fully usable by IP.
    pub discovery: Mutex<Option<network::mdns::Advertisement>>,
}

/// Start the local HTTP API if the owner enabled it.
///
/// Returns `None` — never an error the caller must handle — because no network
/// condition is a reason to refuse to run a till. The reason is logged, so the
/// condition stays diagnosable rather than silent.
fn start_local_api(conn: &Arc<Mutex<db::Db>>) -> Option<network::server::ServerHandle> {
    let cfg = {
        let guard = conn.lock().unwrap_or_else(|e| e.into_inner());
        network::config::get(&guard).unwrap_or_default()
    };

    if !cfg.enabled {
        log::info!("local api: disabled by configuration");
        return None;
    }

    let ip = match network::api::resolve_bind_address(&cfg.bind) {
        Ok(ip) => ip,
        Err(e) => {
            log::error!("local api: cannot resolve bind address ({e}); the POS is unaffected");
            return None;
        }
    };
    let addr = std::net::SocketAddr::new(ip, cfg.port);

    match network::server::start(addr, Arc::clone(conn)) {
        Ok(handle) => {
            log::info!("local api: listening on http://{}", handle.local_addr());
            Some(handle)
        }
        Err(e) => {
            // Most often: the port is already taken by another program, or the
            // interface disappeared. Neither may stop the POS.
            log::error!("local api: not started ({e}); the POS is unaffected");
            None
        }
    }
}

/// Advertise Station over mDNS, if discovery is possible.
///
/// Returns `None` on any failure. Multicast being blocked, a missing
/// interface or a name conflict are all recoverable conditions for a POS: the
/// API keeps serving and the manager reaches it by IP.
fn start_discovery(bound: std::net::SocketAddr) -> Option<network::mdns::Advertisement> {
    let version = env!("CARGO_PKG_VERSION");
    match network::mdns::Advertisement::register(bound.ip(), bound.port(), version) {
        Ok(ad) => {
            log::info!(
                "local discovery: advertising {} as {} on {bound}",
                network::mdns::INSTANCE_NAME,
                network::mdns::SERVICE_TYPE
            );
            Some(ad)
        }
        Err(e) => {
            log::error!("local discovery: not advertised ({e}); the API and POS are unaffected");
            None
        }
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
        // Registering the plugin adds the update CHANNEL. No command, UI,
        // polling, or install flow is added here — that is deliberately out
        // of scope, and until it exists the app simply never asks for an
        // update. Station therefore remains fully functional offline.
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

            // The local API shares the POS's own connection, so it competes
            // for the lock exactly as a desktop command does and can never
            // observe or mutate a different copy of the business data.
            let conn = Arc::new(Mutex::new(conn));

            // Starting the network is OPTIONAL. Every failure below is
            // reported and swallowed on purpose: a cafe whose port is taken,
            // or whose LAN address cannot be resolved, must still open its
            // till in the morning. Station is a local POS first.
            let api = start_local_api(&conn);

            // Discovery is advertised ONLY if the API actually came up, and a
            // discovery failure can never affect the API or the POS. There is
            // no point announcing a service that is not listening.
            let discovery = api
                .as_ref()
                .and_then(|h| start_discovery(h.local_addr()));

            app.manage(AppState {
                conn,
                developer_seed_grant: Mutex::new(None),
                api: Mutex::new(api),
                discovery: Mutex::new(discovery),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window ends the session: stop advertising, stop
            // accepting connections and release the port, rather than leaving
            // a listener behind or a phantom service on the cafe network.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    if let Ok(mut guard) = state.discovery.lock() {
                        guard.take();
                    }
                    if let Ok(mut guard) = state.api.lock() {
                        if let Some(handle) = guard.take() {
                            handle.stop();
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::status::db_status,
            commands::auth::login,
            commands::auth::logout,
            commands::auth::me,
            commands::auth::change_password,
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
            commands::sales::sales_monthly,
            commands::pos::list_tables,
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
