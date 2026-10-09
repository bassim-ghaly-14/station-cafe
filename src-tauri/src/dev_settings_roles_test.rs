//! WHO may change each Dev Settings section — asserted in the SERVICE layer.
//!
//! The React page hides sections a MANAGER may not open, and the navigation
//! offers the entry to MANAGER+. Neither is a security boundary: hiding a
//! control proves nothing, because a manager (or anyone holding a session
//! token) can call a Tauri command or the LAN `api/v1/cmd` endpoint directly.
//! So every rule here is asserted on the service function the command delegates
//! to — the layer that cannot be skipped, whichever transport is used.
//!
//! The matrix this file enforces:
//!
//!   section                     ADMIN   MANAGER   STAFF
//!   service-charge amounts      yes     yes       no
//!   discount quick amounts      yes     yes       no
//!   discount PIN                yes     yes       no
//!   credit rules                yes     yes       no
//!   monthly targets             yes     yes       no
//!   monthly chart window        yes     no        no
//!   table count                 yes     no        no
//!   database / demo data tools  yes     no        no
//!
//! Service charge, discount quick amounts, the PIN and credit rules are exactly
//! the MANAGER allowlist (with local network access and the update section,
//! which reach no settings service of their own). The chart window, the table
//! count and the data tools stay ADMIN-only — an allowlist, so anything not
//! named remains above the manager by default.

use crate::db::migrate;
use crate::demo_data::seed_for_development as run_if_empty;
use crate::services::auth::User;
use crate::services::settings;
use crate::services::{developer, pos as pos_svc};
use rusqlite::Connection;

fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    run_if_empty(&conn).unwrap();
    conn
}

fn actor(conn: &Connection, name: &str) -> User {
    let (id, role) = conn
        .query_row("SELECT id, role FROM users WHERE name = ?1", [name], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    User {
        id,
        name: name.to_string(),
        phone: None,
        role,
        status: "ACTIVE".into(),
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn service_charge(amounts: Vec<i64>) -> settings::ServiceChargeConfig {
    settings::ServiceChargeConfig { amounts }
}

fn discount_options(amounts: Vec<i64>) -> settings::DiscountOptionsConfig {
    settings::DiscountOptionsConfig { amounts }
}

fn credit_all() -> settings::CreditConfig {
    settings::CreditConfig {
        enabled: true,
        mode: "ALL".into(),
        allowed_customer_ids: vec![],
    }
}

fn targets(cafe_minor: i64, wash_minor: i64) -> settings::RevenueTargetDefaults {
    settings::RevenueTargetDefaults {
        cafe_minor,
        wash_minor,
    }
}

/// A MANAGER may configure every settings section on their allowlist, and the
/// values they save are the ones a later read returns.
#[test]
fn a_manager_may_configure_their_allowlisted_settings() {
    let conn = fresh();
    let manager = actor(&conn, "manager");

    settings::set_service_charge(&conn, &manager, &service_charge(vec![1_000, 2_000])).unwrap();
    settings::set_discount_options(&conn, &manager, &discount_options(vec![500])).unwrap();
    settings::set_discount_authorization_pin(&conn, &manager, "4820").unwrap();
    settings::set_credit_config(&conn, &manager, &credit_all()).unwrap();
    settings::set_revenue_target_defaults(&conn, &manager, &targets(1_000_00, 500_00)).unwrap();
    settings::set_revenue_target_override(
        &conn,
        &manager,
        "2026-10",
        settings::RevenueDepartment::Cafe,
        Some(1_200_00),
    )
    .unwrap();

    assert_eq!(
        settings::get_service_charge(&conn).unwrap().amounts,
        vec![1_000, 2_000]
    );
    assert_eq!(
        settings::get_discount_options(&conn).unwrap().amounts,
        vec![500]
    );
    assert!(
        settings::get_discount_authorization(&conn)
            .unwrap()
            .configured
    );
    assert_eq!(settings::get_credit_config(&conn).unwrap().mode, "ALL");
    assert_eq!(
        settings::resolve_monthly_target(&conn, "2026-10", settings::RevenueDepartment::Cafe)
            .unwrap()
            .target_minor,
        1_200_00
    );
}

/// An ADMIN may still configure all of it: nothing was taken away from them.
#[test]
fn an_admin_may_configure_the_whole_page() {
    let conn = fresh();
    let admin = actor(&conn, "admin");

    settings::set_service_charge(&conn, &admin, &service_charge(vec![1_000])).unwrap();
    settings::set_discount_options(&conn, &admin, &discount_options(vec![500])).unwrap();
    settings::set_discount_authorization_pin(&conn, &admin, "4820").unwrap();
    settings::set_credit_config(&conn, &admin, &credit_all()).unwrap();
    settings::set_monthly_sales_period(
        &conn,
        &admin,
        &settings::MonthlySalesPeriodConfig { months: 6 },
    )
    .unwrap();
    settings::set_revenue_target_defaults(&conn, &admin, &targets(100_00, 200_00)).unwrap();
    pos_svc::set_table_count(&conn, &admin, 14).unwrap();

    assert_eq!(settings::get_monthly_sales_period(&conn).unwrap().months, 6);
    assert_eq!(
        settings::get_service_charge(&conn).unwrap().amounts,
        vec![1_000]
    );
}

/// A CASHIER may not change ANY Dev Settings value — not through the UI, and
/// not by calling the service directly. Their POS still works; they simply
/// configure nothing.
#[test]
fn a_cashier_may_change_no_dev_setting() {
    let conn = fresh();
    let staff = actor(&conn, "cashier");
    // Whatever the installation currently holds — a fresh seeded database ships
    // default quick amounts — the point is that a refused write changes NOTHING.
    let service_before = settings::get_service_charge(&conn).unwrap().amounts;
    let discount_before = settings::get_discount_options(&conn).unwrap().amounts;
    let credit_enabled = settings::get_credit_config(&conn).unwrap().enabled;
    let credit_mode = settings::get_credit_config(&conn).unwrap().mode;
    let period_before = settings::get_monthly_sales_period(&conn).unwrap().months;

    assert!(
        settings::set_service_charge(&conn, &staff, &service_charge(vec![1_000])).is_err(),
        "service-charge amounts are MANAGER+"
    );
    assert!(
        settings::set_discount_options(&conn, &staff, &discount_options(vec![500])).is_err(),
        "discount quick amounts are MANAGER+"
    );
    assert!(
        settings::set_discount_authorization_pin(&conn, &staff, "4820").is_err(),
        "the discount PIN is MANAGER+"
    );
    assert!(
        settings::set_credit_config(&conn, &staff, &credit_all()).is_err(),
        "credit rules are MANAGER+"
    );
    assert!(
        settings::set_revenue_target_defaults(&conn, &staff, &targets(1_000_00, 1_000_00)).is_err(),
        "monthly targets are MANAGER+"
    );
    assert!(
        settings::set_monthly_sales_period(
            &conn,
            &staff,
            &settings::MonthlySalesPeriodConfig { months: 6 },
        )
        .is_err(),
        "the chart window is ADMIN-only"
    );

    // Not one refused write changed the stored configuration.
    assert_eq!(
        settings::get_service_charge(&conn).unwrap().amounts,
        service_before
    );
    assert_eq!(
        settings::get_discount_options(&conn).unwrap().amounts,
        discount_before
    );
    assert!(
        !settings::get_discount_authorization(&conn)
            .unwrap()
            .configured
    );
    assert_eq!(
        settings::get_credit_config(&conn).unwrap().enabled,
        credit_enabled
    );
    assert_eq!(
        settings::get_credit_config(&conn).unwrap().mode,
        credit_mode
    );
    assert_eq!(
        settings::get_monthly_sales_period(&conn).unwrap().months,
        period_before
    );
}

/// A MANAGER reaches nothing outside the allowlist, even calling the service
/// directly with no UI involved at all — this is the property that makes the
/// hidden React sections a convenience rather than the boundary.
#[test]
fn a_manager_may_not_touch_admin_only_settings() {
    let conn = fresh();
    let manager = actor(&conn, "manager");
    let tables_before: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cafe_tables WHERE is_active = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();

    assert!(
        settings::set_monthly_sales_period(
            &conn,
            &manager,
            &settings::MonthlySalesPeriodConfig { months: 6 },
        )
        .is_err(),
        "the monthly chart window is not on the manager allowlist"
    );
    assert!(
        pos_svc::set_table_count(&conn, &manager, 20).is_err(),
        "the table count is not on the manager allowlist"
    );
    assert!(
        developer::clear_database(&conn, &manager).is_err(),
        "clearing the database is ADMIN-only"
    );
    assert!(
        developer::load_official_data(&conn, &manager).is_err(),
        "loading the official dataset is ADMIN-only"
    );
    assert!(
        developer::load_demo_data(&conn, &manager).is_err(),
        "loading the demo dataset is ADMIN-only"
    );

    // And none of those refusals had a side effect.
    assert_eq!(
        settings::get_monthly_sales_period(&conn).unwrap().months,
        12
    );
    let tables_after: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cafe_tables WHERE is_active = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        tables_after, tables_before,
        "the refused reset left the tables in place"
    );
}
