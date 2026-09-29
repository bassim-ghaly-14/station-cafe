//! The browser transport for the REAL Station command surface.
//!
//! This module is the reason the phone runs the same application as the till
//! instead of a look-alike: it exposes the very same `commands::*` functions
//! that `tauri::generate_handler!` registers for the desktop, so there is
//! exactly ONE implementation of every operation, ONE authorization check and
//! ONE business rule.
//!
//! What this module deliberately does NOT contain:
//!
//! - No SQL and no business logic. Every fact and every rule still comes from
//!   the existing `services::` layer, through the command.
//! - No role logic. Each command already ends in `common::authorized`, which
//!   calls `services::auth::require_role`. A browser caller is held to exactly
//!   the same gate as a desktop caller, because it runs the same code.
//! - No second login. `auth::login` is reached through `commands::auth::login`,
//!   the same function the desktop login screen calls.
//!
//! Authentication is deliberately the desktop's: the bearer token is read from
//! the `Authorization` header and handed to the command as its `token`
//! argument, exactly as the IPC layer does. It is never read from a URL, a
//! query string or the request body.

use crate::error::AppError;
use crate::network::api::{ApiError, ApiResponse};
use crate::AppState;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::{Manager, State};

/// Path segment that introduces a command call.
pub const CMD_PREFIX: &str = "/cmd";

/// Serialise a command's result the way the IPC layer serialises it.
///
/// `AppError` already has a hand-written `Serialize` emitting the stable
/// `{kind, message, code}` shape the UI translates. Reusing THAT (rather than
/// the older bespoke `{error:{code,message}}` envelope) is what lets
/// `src/services/ipc.ts` behave identically on both transports.
///
/// The status code is still the one [`from_app_error`] computes — only the BODY
/// comes from the error itself. That distinction is the whole point: mapping a
/// domain error down to an opaque `INTERNAL` before it crosses the boundary
/// would discard the stable machine key (`printer.open_failed`, and so on) and
/// leave the browser with nothing to translate but "an error happened", which is
/// exactly the generic toast this surface must never show.
fn out<T: serde::Serialize>(result: crate::error::AppResult<T>) -> Result<ApiResponse, ApiError> {
    match result {
        Ok(value) => Ok(ApiResponse {
            status: 200,
            body: serde_json::to_value(value).unwrap_or(Value::Null),
        }),
        Err(err) => {
            // The technical detail (a win32 code, a queue name) is logged here,
            // on the machine that owns the printer, and only the stable key
            // travels to the client.
            let boundary = from_app_error(&err);
            if boundary.status >= 500 {
                log::error!("command error [{}]: {}", err.kind().as_str(), err);
            }
            Ok(ApiResponse {
                status: boundary.status,
                body: serde_json::to_value(&err).unwrap_or(Value::Null),
            })
        }
    }
}

/// Translate a domain error into the HTTP boundary.
///
/// The mapping is by KIND, exactly as [`ApiError::from_domain`] already does for
/// the older routes, so both transports classify a failure identically. The one
/// addition is that an authorization refusal is a real `403`: a caller who is
/// authenticated but not permitted must be told so, rather than being told to
/// sign in again as though their session had expired.
fn from_app_error(err: &AppError) -> ApiError {
    if err.kind() == crate::error::ErrorKind::Unauthorized {
        return match err_message(err) {
            // A session that no longer resolves: the client must sign in again.
            "auth.invalid_session" | "auth.session_expired" | "auth.suspended" => {
                ApiError::unauthorized()
            }
            // A wrong password is a failed AUTHENTICATION, not a permission
            // decision, so it must stay a 401.
            "auth.bad_credentials" => ApiError::unauthorized(),
            // Everything else in this kind is a PERMISSION decision on an
            // otherwise-valid session: a real 403, never a 401.
            _ => ApiError::new("FORBIDDEN", "Insufficient permissions", 403),
        };
    }
    ApiError::from_domain(err)
}

/// Recover the stable machine key an `AppError` carries.
///
/// The variants that matter store that key verbatim, so matching on it is
/// stable and never exposes raw text to the client.
fn err_message(err: &AppError) -> &str {
    match err {
        AppError::Unauthorized(m)
        | AppError::Validation(m)
        | AppError::BusinessRule(m)
        | AppError::Conflict(m)
        | AppError::NotFound(m)
        | AppError::Internal(m) => m.as_str(),
        _ => "",
    }
}

/// A REQUIRED argument, read from the JSON body.
///
/// Absent or null is a client mistake and is refused as a 400 rather than being
/// silently defaulted, because a defaulted `0` or `""` is how a real business
/// rule gets skipped by accident.
fn req<T: DeserializeOwned>(body: &Value, key: &str) -> Result<T, ApiError> {
    match body.get(key).filter(|v| !v.is_null()) {
        Some(v) => serde_json::from_value(v.clone()).map_err(|_| ApiError::bad_request()),
        None => Err(ApiError::bad_request()),
    }
}

/// An OPTIONAL argument.
///
/// `Option<T>` in a command means "the caller may omit this", which is what the
/// IPC layer already honours, so a missing or null key is `None` here too.
fn opt<T: DeserializeOwned>(body: &Value, key: &str) -> Result<Option<T>, ApiError> {
    match body.get(key) {
        Some(v) if !v.is_null() => serde_json::from_value(v.clone())
            .map(Some)
            .map_err(|_| ApiError::bad_request()),
        _ => Ok(None),
    }
}

/// Run one Station command, addressed by name.
///
/// `state` is a REAL `State<AppState>` taken from the running application, which
/// is what allows these very command functions to be called here. The desktop
/// and the browser therefore execute identical code against the identical
/// `Mutex<Connection>`.
pub fn call(
    handle: &tauri::AppHandle,
    name: &str,
    token: &str,
    body: &Value,
) -> Result<ApiResponse, ApiError> {
    let state: State<'_, AppState> = handle.state::<AppState>();
    dispatch(name, state, token, body)
}

/// The command table.
///
/// One arm per command, each a direct call into the command module. Every arm is
/// a real call to the function `tauri::generate_handler!` registers, so the two
/// surfaces cannot drift: renaming or re-typing a command breaks this file.
fn dispatch(
    name: &str,
    state: State<'_, AppState>,
    token: &str,
    body: &Value,
) -> Result<ApiResponse, ApiError> {
    match name {
            "login" => out(crate::commands::auth::login(state.clone(), req::<_>(body, "input")?)),
            "logout" => out(crate::commands::auth::logout(state.clone(), token.to_owned())),
            "me" => out(crate::commands::auth::me(state.clone(), token.to_owned())),
            "change_password" => out(crate::commands::auth::change_password(state.clone(), token.to_owned(), req::<_>(body, "target_id")?, req::<_>(body, "new_password")?)),
            "list_products" => out(crate::commands::catalog::list_products(state.clone(), token.to_owned(), opt::<_>(body, "department")?, req::<_>(body, "active_only")?)),
            "create_product" => out(crate::commands::catalog::create_product(state.clone(), token.to_owned(), req::<_>(body, "input")?)),
            "create_category" => out(crate::commands::catalog::create_category(state.clone(), token.to_owned(), req::<_>(body, "name")?)),
            "update_category" => out(crate::commands::catalog::update_category(state.clone(), token.to_owned(), req::<_>(body, "category_id")?, req::<_>(body, "name")?)),
            "delete_category" => out(crate::commands::catalog::delete_category(state.clone(), token.to_owned(), req::<_>(body, "category_id")?)),
            "list_categories" => out(crate::commands::catalog::list_categories(state.clone(), token.to_owned())),
            "update_product" => out(crate::commands::catalog::update_product(state.clone(), token.to_owned(), req::<_>(body, "product_id")?, req::<_>(body, "input")?)),
            "set_product_price" => out(crate::commands::catalog::set_product_price(state.clone(), token.to_owned(), req::<_>(body, "product_id")?, req::<_>(body, "price_minor")?)),
            "set_product_active" => out(crate::commands::catalog::set_product_active(state.clone(), token.to_owned(), req::<_>(body, "product_id")?, req::<_>(body, "active")?)),
            "delete_product" => out(crate::commands::catalog::delete_product(state.clone(), token.to_owned(), req::<_>(body, "product_id")?)),
            "rename_product" => out(crate::commands::catalog::rename_product(state.clone(), token.to_owned(), req::<_>(body, "product_id")?, req::<_>(body, "name")?)),
            "get_discount_options" => out(crate::commands::catalog::get_discount_options(state.clone(), token.to_owned())),
            "set_discount_options" => out(crate::commands::catalog::set_discount_options(state.clone(), token.to_owned(), req::<_>(body, "config")?)),
            "get_discount_authorization" => out(crate::commands::catalog::get_discount_authorization(state.clone(), token.to_owned())),
            "set_discount_authorization_pin" => out(crate::commands::catalog::set_discount_authorization_pin(state.clone(), token.to_owned(), req::<_>(body, "pin")?)),
            "get_service_charge" => out(crate::commands::catalog::get_service_charge(state.clone(), token.to_owned())),
            "set_service_charge" => out(crate::commands::catalog::set_service_charge(state.clone(), token.to_owned(), req::<_>(body, "config")?)),
            "get_monthly_sales_period" => out(crate::commands::catalog::get_monthly_sales_period(state.clone(), token.to_owned())),
            "set_monthly_sales_period" => out(crate::commands::catalog::set_monthly_sales_period(state.clone(), token.to_owned(), req::<_>(body, "config")?)),
            "get_credit_config" => out(crate::commands::catalog::get_credit_config(state.clone(), token.to_owned())),
            "set_credit_config" => out(crate::commands::catalog::set_credit_config(state.clone(), token.to_owned(), req::<_>(body, "config")?)),
            "search_customers" => out(crate::commands::customers::search_customers(state.clone(), token.to_owned(), req::<_>(body, "query")?)),
            "list_customers" => out(crate::commands::customers::list_customers(state.clone(), token.to_owned(), opt::<_>(body, "query")?, opt::<_>(body, "period")?)),
            "customer_overview" => out(crate::commands::customers::customer_overview(state.clone(), token.to_owned(), opt::<_>(body, "period")?)),
            "customer_details" => out(crate::commands::customers::customer_details(state.clone(), token.to_owned(), req::<_>(body, "customer_id")?, opt::<_>(body, "period")?)),
            "list_cars_of" => out(crate::commands::customers::list_cars_of(state.clone(), token.to_owned(), req::<_>(body, "customer_id")?)),
            "find_cars_by_plate" => out(crate::commands::customers::find_cars_by_plate(state.clone(), token.to_owned(), req::<_>(body, "plate")?)),
            "create_customer" => out(crate::commands::customers::create_customer(state.clone(), token.to_owned(), req::<_>(body, "input")?)),
            "update_customer" => out(crate::commands::customers::update_customer(state.clone(), token.to_owned(), req::<_>(body, "customer_id")?, req::<_>(body, "input")?)),
            "delete_customer" => out(crate::commands::customers::delete_customer(state.clone(), token.to_owned(), req::<_>(body, "customer_id")?)),
            "create_car" => out(crate::commands::customers::create_car(state.clone(), token.to_owned(), req::<_>(body, "input")?)),
            "clear_database" => out(crate::commands::developer::clear_database(state.clone(), token.to_owned())),
            // This command's session token is OPTIONAL: it may instead carry a
            // one-time reseed grant issued by a previous `clear_database`. The
            // grant is still checked by the command itself, so passing `None`
            // for an unauthenticated caller cannot grant anything.
            "load_official_data" => out(crate::commands::developer::load_official_data(state.clone(), (!token.is_empty()).then(|| token.to_owned()), opt::<_>(body, "reseed_token")?)),
            "list_employees" => out(crate::commands::employees::list_employees(state.clone(), token.to_owned(), opt::<_>(body, "query")?, opt::<_>(body, "period")?, opt::<_>(body, "include_inactive")?)),
            "employee_overview" => out(crate::commands::employees::employee_overview(state.clone(), token.to_owned(), opt::<_>(body, "period")?)),
            "my_attendance" => out(crate::commands::employees::my_attendance(state.clone(), token.to_owned())),
            "record_attendance" => out(crate::commands::employees::record_attendance(state.clone(), token.to_owned(), req::<_>(body, "employee_id")?, req::<_>(body, "action")?, opt::<_>(body, "note")?)),
            "correct_attendance" => out(crate::commands::employees::correct_attendance(state.clone(), token.to_owned(), req::<_>(body, "employee_id")?, req::<_>(body, "business_date")?, req::<_>(body, "action")?, opt::<_>(body, "note")?)),
            "override_employee_attendance" => out(crate::commands::employees::override_employee_attendance(state.clone(), token.to_owned(), req::<_>(body, "employee_id")?, req::<_>(body, "business_date")?, opt::<_>(body, "check_in")?, opt::<_>(body, "check_out")?, opt::<_>(body, "reason")?)),
            "employee_details" => out(crate::commands::employees::employee_details(state.clone(), token.to_owned(), req::<_>(body, "employee_id")?, opt::<_>(body, "period")?)),
            "create_employee" => out(crate::commands::employees::create_employee(state.clone(), token.to_owned(), req::<_>(body, "input")?)),
            "update_employee" => out(crate::commands::employees::update_employee(state.clone(), token.to_owned(), req::<_>(body, "employee_id")?, req::<_>(body, "input")?)),
            "set_employee_status" => out(crate::commands::employees::set_employee_status(state.clone(), token.to_owned(), req::<_>(body, "employee_id")?, req::<_>(body, "status")?)),
            "delete_employee" => out(crate::commands::employees::delete_employee(state.clone(), token.to_owned(), req::<_>(body, "employee_id")?)),
            "set_employee_base_salary" => out(crate::commands::employees::set_employee_base_salary(state.clone(), token.to_owned(), req::<_>(body, "employee_id")?, req::<_>(body, "base_salary")?)),
            "create_employee_advance" => out(crate::commands::employees::create_employee_advance(state.clone(), token.to_owned(), req::<_>(body, "employee_id")?, req::<_>(body, "input")?)),
            "reverse_employee_advance" => out(crate::commands::employees::reverse_employee_advance(state.clone(), token.to_owned(), req::<_>(body, "advance_id")?)),
            "payroll_preview" => out(crate::commands::employees::payroll_preview(state.clone(), token.to_owned(), req::<_>(body, "employee_id")?, req::<_>(body, "period")?)),
            "create_payroll_run" => out(crate::commands::employees::create_payroll_run(state.clone(), token.to_owned(), req::<_>(body, "employee_id")?, req::<_>(body, "period")?, opt::<_>(body, "deductions")?)),
            "finalize_payroll_run" => out(crate::commands::employees::finalize_payroll_run(state.clone(), token.to_owned(), req::<_>(body, "run_id")?)),
            "list_wash_workers" => out(crate::commands::employees::list_wash_workers(state.clone(), token.to_owned())),
            "set_order_wash_employee" => out(crate::commands::employees::set_order_wash_employee(state.clone(), token.to_owned(), req::<_>(body, "order_id")?, opt::<_>(body, "wash_employee_id")?)),
            "list_stock" => out(crate::commands::ops::list_stock(state.clone(), token.to_owned())),
            "list_stock_movements" => out(crate::commands::ops::list_stock_movements(state.clone(), token.to_owned(), req::<_>(body, "limit")?)),
            "adjust_stock" => out(crate::commands::ops::adjust_stock(state.clone(), token.to_owned(), req::<_>(body, "product_id")?, req::<_>(body, "change")?, req::<_>(body, "reason")?, opt::<_>(body, "note")?)),
            "set_stock_minimum" => out(crate::commands::ops::set_stock_minimum(state.clone(), token.to_owned(), req::<_>(body, "product_id")?, req::<_>(body, "min_quantity")?)),
            "list_expense_categories" => out(crate::commands::ops::list_expense_categories(state.clone(), token.to_owned())),
            "create_expense_category" => out(crate::commands::ops::create_expense_category(state.clone(), token.to_owned(), req::<_>(body, "name")?)),
            "rename_expense_category" => out(crate::commands::ops::rename_expense_category(state.clone(), token.to_owned(), req::<_>(body, "code")?, req::<_>(body, "name")?)),
            "delete_expense_category" => out(crate::commands::ops::delete_expense_category(state.clone(), token.to_owned(), req::<_>(body, "code")?)),
            "list_expenses" => out(crate::commands::ops::list_expenses(state.clone(), token.to_owned(), opt::<_>(body, "from")?, opt::<_>(body, "to")?, req::<_>(body, "recurring_only")?)),
            "expenses_overview" => out(crate::commands::ops::expenses_overview(state.clone(), token.to_owned(), opt::<_>(body, "from")?, opt::<_>(body, "to")?)),
            "expenses_monthly" => out(crate::commands::ops::expenses_monthly(state.clone(), token.to_owned(), opt::<_>(body, "months")?)),
            "create_expense" => out(crate::commands::ops::create_expense(state.clone(), token.to_owned(), req::<_>(body, "input")?)),
            "list_shift_expenses" => out(crate::commands::ops::list_shift_expenses(state.clone(), token.to_owned())),
            "today_summary" => out(crate::commands::ops::today_summary(state.clone(), token.to_owned())),
            "analytics_charts" => out(crate::commands::ops::analytics_charts(state.clone(), token.to_owned(), opt::<_>(body, "from")?, opt::<_>(body, "to")?)),
            "list_audit" => out(crate::commands::ops::list_audit(state.clone(), token.to_owned(), req::<_>(body, "limit")?, opt::<_>(body, "action_like")?)),
            "get_print_config" => out(crate::commands::ops::get_print_config(state.clone(), token.to_owned())),
            "set_print_config" => out(crate::commands::ops::set_print_config(state.clone(), token.to_owned(), req::<_>(body, "config")?)),
            "print_test" => out(crate::commands::ops::print_test(state.clone(), token.to_owned())),
            "print_invoice" => out(crate::commands::ops::print_invoice(state.clone(), token.to_owned(), req::<_>(body, "invoice_id")?, opt::<_>(body, "force")?)),
            "print_wash_ticket" => out(crate::commands::ops::print_wash_ticket(state.clone(), token.to_owned(), req::<_>(body, "order_id")?, opt::<_>(body, "force")?)),
            "preview_order_document" => out(crate::commands::ops::preview_order_document(state.clone(), token.to_owned(), req::<_>(body, "order_id")?, opt::<_>(body, "discount_mode")?, opt::<_>(body, "discount_value")?, opt::<_>(body, "service_charge_minor")?)),
            "preview_invoice" => out(crate::commands::ops::preview_invoice(state.clone(), token.to_owned(), req::<_>(body, "invoice_id")?)),
            "preview_wash_ticket" => out(crate::commands::ops::preview_wash_ticket(state.clone(), token.to_owned(), req::<_>(body, "order_id")?)),
            "print_shift_report" => out(crate::commands::ops::print_shift_report(state.clone(), token.to_owned(), req::<_>(body, "shift_id")?, opt::<_>(body, "force")?)),
            "preview_shift_report" => out(crate::commands::ops::preview_shift_report(state.clone(), token.to_owned(), opt::<_>(body, "shift_id")?)),
            "preview_day_report_cmd" => out(crate::commands::ops::preview_day_report_cmd(state.clone(), token.to_owned(), req::<_>(body, "day_id")?)),
            "print_day_report_cmd" => out(crate::commands::ops::print_day_report_cmd(state.clone(), token.to_owned(), req::<_>(body, "day_id")?, opt::<_>(body, "force")?)),
            "list_print_jobs" => out(crate::commands::ops::list_print_jobs(state.clone(), token.to_owned(), req::<_>(body, "limit")?)),
            "list_tables" => out(crate::commands::pos::list_tables(state.clone(), token.to_owned())),
            "set_table_count" => out(crate::commands::pos::set_table_count(state.clone(), token.to_owned(), req::<_>(body, "count")?)),
            "open_table" => out(crate::commands::pos::open_table(state.clone(), token.to_owned(), req::<_>(body, "table_id")?)),
            "close_empty_table" => out(crate::commands::pos::close_empty_table(state.clone(), token.to_owned(), req::<_>(body, "table_id")?)),
            "start_order" => out(crate::commands::pos::start_order(state.clone(), token.to_owned(), req::<_>(body, "table_id")?)),
            "start_takeaway" => out(crate::commands::pos::start_takeaway(state.clone(), token.to_owned())),
            "list_open_takeaway_orders" => out(crate::commands::pos::list_open_takeaway_orders(state.clone(), token.to_owned())),
            "discard_order" => out(crate::commands::pos::discard_order(state.clone(), token.to_owned(), req::<_>(body, "order_id")?)),
            "get_order" => out(crate::commands::pos::get_order(state.clone(), token.to_owned(), req::<_>(body, "order_id")?)),
            "add_order_line" => out(crate::commands::pos::add_order_line(state.clone(), token.to_owned(), req::<_>(body, "order_id")?, req::<_>(body, "product_id")?, req::<_>(body, "quantity")?)),
            "set_line_quantity" => out(crate::commands::pos::set_line_quantity(state.clone(), token.to_owned(), req::<_>(body, "line_id")?, req::<_>(body, "quantity")?)),
            "remove_order_line" => out(crate::commands::pos::remove_order_line(state.clone(), token.to_owned(), req::<_>(body, "order_id")?, req::<_>(body, "line_id")?)),
            "mark_ready_to_pay" => out(crate::commands::pos::mark_ready_to_pay(state.clone(), token.to_owned(), req::<_>(body, "order_id")?)),
            "set_order_discount" => out(crate::commands::pos::set_order_discount(state.clone(), token.to_owned(), req::<_>(body, "order_id")?, opt::<_>(body, "discount_mode")?, opt::<_>(body, "discount_value")?, opt::<_>(body, "discount_pin")?)),
            "attach_customer" => out(crate::commands::pos::attach_customer(state.clone(), token.to_owned(), req::<_>(body, "input")?)),
            "detach_customer" => out(crate::commands::pos::detach_customer(state.clone(), token.to_owned(), req::<_>(body, "order_id")?)),
            "get_order_customer" => out(crate::commands::pos::get_order_customer(state.clone(), token.to_owned(), req::<_>(body, "order_id")?)),
            "preview_order" => out(crate::commands::pos::preview_order(state.clone(), token.to_owned(), req::<_>(body, "order_id")?, opt::<_>(body, "discount_mode")?, opt::<_>(body, "discount_value")?, opt::<_>(body, "_discount_pin")?, opt::<_>(body, "service_charge_minor")?)),
            "list_daily_wash_tickets" => out(crate::commands::pos::list_daily_wash_tickets(state.clone(), token.to_owned(), opt::<_>(body, "business_day_id")?, opt::<_>(body, "query")?, opt::<_>(body, "order_status")?)),
            "issue_wash_ticket" => out(crate::commands::pos::issue_wash_ticket(state.clone(), token.to_owned(), req::<_>(body, "order_id")?)),
            "checkout_order" => out(crate::commands::pos::checkout_order(state.clone(), token.to_owned(), req::<_>(body, "input")?)),
            "get_invoice" => out(crate::commands::pos::get_invoice(state.clone(), token.to_owned(), req::<_>(body, "invoice_id")?)),
            "search_invoices" => out(crate::commands::pos::search_invoices(state.clone(), token.to_owned(), opt::<_>(body, "business_day_id")?, opt::<_>(body, "query")?, opt::<_>(body, "status")?, opt::<_>(body, "method")?)),
            "list_credit_accounts" => out(crate::commands::pos::list_credit_accounts(state.clone(), token.to_owned())),
            "settle_credit" => out(crate::commands::pos::settle_credit(state.clone(), token.to_owned(), req::<_>(body, "customer_id")?, req::<_>(body, "amount")?)),
            "sales_overview" => out(crate::commands::sales::sales_overview(state.clone(), token.to_owned(), opt::<_>(body, "filter")?, opt::<_>(body, "sort")?)),
            "sales_invoices" => out(crate::commands::sales::sales_invoices(state.clone(), token.to_owned(), opt::<_>(body, "filter")?)),
            "sales_monthly" => out(crate::commands::sales::sales_monthly(state.clone(), token.to_owned(), opt::<_>(body, "months")?)),
            "sales_cashiers" => out(crate::commands::sales::sales_cashiers(state.clone(), token.to_owned())),
            "day_shift_state" => out(crate::commands::shifts::day_shift_state(state.clone(), token.to_owned())),
            "open_business_day" => out(crate::commands::shifts::open_business_day(state.clone(), token.to_owned())),
            "open_shift" => out(crate::commands::shifts::open_shift(state.clone(), token.to_owned(), req::<_>(body, "opening_cash")?)),
            "preview_shift_close" => out(crate::commands::shifts::preview_shift_close(state.clone(), token.to_owned())),
            "close_shift" => out(crate::commands::shifts::close_shift(state.clone(), token.to_owned(), req::<_>(body, "actual_cash")?)),
            "preview_day_settlement" => out(crate::commands::shifts::preview_day_settlement(state.clone(), token.to_owned())),
            "settle_day" => out(crate::commands::shifts::settle_day(state.clone(), token.to_owned())),
            "day_settlement_history" => out(crate::commands::shifts::day_settlement_history(state.clone(), token.to_owned())),
            "preview_day_close" => out(crate::commands::shifts::preview_day_close(state.clone(), token.to_owned())),
            "close_business_day" => out(crate::commands::shifts::close_business_day(state.clone(), token.to_owned())),
            "list_closed_shifts" => out(crate::commands::shifts::list_closed_shifts(state.clone(), token.to_owned(), opt::<_>(body, "from")?, opt::<_>(body, "to")?)),
            "list_closed_business_days" => out(crate::commands::shifts::list_closed_business_days(state.clone(), token.to_owned(), opt::<_>(body, "from")?, opt::<_>(body, "to")?)),
            "list_shifts" => out(crate::commands::shifts::list_shifts(state.clone(), token.to_owned(), req::<_>(body, "day_id")?)),
            "shift_report" => out(crate::commands::shifts::shift_report(state.clone(), token.to_owned(), req::<_>(body, "shift_id")?)),
            "day_report" => out(crate::commands::shifts::day_report(state.clone(), token.to_owned(), req::<_>(body, "day_id")?)),
            "db_status" => out(crate::commands::status::db_status(state.clone())),
            "local_access_qr" => out(crate::commands::status::local_access_qr(state.clone(), token.to_owned())),
            "get_network_config" => out(crate::commands::status::get_network_config(state.clone(), token.to_owned())),
            "set_network_config" => out(crate::commands::status::set_network_config(state.clone(), token.to_owned(), req::<_>(body, "config")?)),
            "local_api_status" => out(crate::commands::status::local_api_status(state.clone(), token.to_owned())),
        _ => Err(ApiError::not_found()),
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    /// The defect this pins: a printer failure was mapped down to an opaque
    /// `INTERNAL` before it crossed the HTTP boundary, so the browser received
    /// a generic "an error happened" instead of the stable `printer.*` key it
    /// needs to show an actionable Arabic message. The status must stay a
    /// failure, and the BODY must be the same `{kind, message, code}` shape the
    /// Tauri IPC layer produces — that is what lets `ipc.ts` behave identically
    /// on both transports.
    #[test]
    fn a_printer_failure_keeps_its_stable_code_across_the_boundary() {
        for detail in [
            "printer.not_configured",
            "printer.open_failed: win32=1801",
            "printer.spool_failed: start_doc win32=5",
            "printer.write_failed: win32=2",
        ] {
            let ApiResponse { status, body } = out::<()>(Err(AppError::printer(detail)))
                .expect("a response, not a transport error");

            assert!(status >= 400, "{detail} must not report success");
            assert_eq!(body["kind"], "printer", "{detail}");
            // Only the stable prefix travels: the `win32=` detail stays on the
            // machine that owns the printer, in the log.
            assert_eq!(body["message"], detail.split(':').next().unwrap(), "{detail}");
            assert!(
                !body.to_string().contains("win32"),
                "{detail} leaked a raw win32 code to the client"
            );
        }
    }

    /// Each distinct failure boundary keeps its OWN code, so the UI can tell a
    /// missing configuration from an unreachable queue from a rejected job.
    #[test]
    fn each_printer_failure_keeps_its_own_code() {
        for code in [
            "printer.not_configured",
            "printer.unavailable",
            "printer.open_failed",
            "printer.spool_failed",
            "printer.write_failed",
            "printer.flush_failed",
        ] {
            let ApiResponse { body, .. } = out::<()>(Err(AppError::printer(code))).unwrap();
            assert_eq!(body["message"], code);
        }
    }

    /// A non-printer domain error keeps its kind too — the fix is about the
    /// error's own serialization, not about special-casing printing.
    #[test]
    fn a_business_failure_keeps_its_kind_and_code() {
        let ApiResponse { status, body } =
            out::<()>(Err(AppError::business("shift.already_open")))
                .expect("a response, not a transport error");
        assert_eq!(status, 422);
        assert_eq!(body["kind"], "business_rule");
        assert_eq!(body["message"], "shift.already_open");
    }

    /// An authorization refusal is still a real 403 (and a session loss is still
    /// a 401): the status mapping this bridge computes is unchanged.
    #[test]
    fn authorization_statuses_are_unchanged() {
        let forbidden = out::<()>(Err(AppError::unauthorized("auth.forbidden"))).unwrap();
        assert_eq!(forbidden.status, 403);
        let expired = out::<()>(Err(AppError::unauthorized("auth.session_expired"))).unwrap();
        assert_eq!(expired.status, 401);
    }
}
