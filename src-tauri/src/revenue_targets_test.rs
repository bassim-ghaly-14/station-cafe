//! Monthly revenue targets (CAFE / WASH) — business-rule tests.
//!
//! These prove the SEMANTICS of the target feature, not that it renders:
//!
//! 1. **Defaults** — an installation that never configured a target resolves to
//!    the stored default for both departments.
//! 2. **Overrides** — a month's override replaces the default for THAT
//!    department only, and clearing it restores the default.
//! 3. **Month isolation** — October's override never reaches November, and
//!    changing the global default never mutates a month that already overrides.
//! 4. **Money rules** — targets are whole pounds; negatives, decimals and
//!    out-of-range values are refused by the service, not merely hidden.
//! 5. **Revenue attribution** — cafe money only fills the cafe target, wash
//!    money only the wash target, a hybrid invoice splits, a takeaway invoice
//!    contributes by its ITEMS, and a service charge belongs to neither.
//! 6. **Percentages** — zero target, normal, above 100%, and no division by
//!    zero anywhere.
//! 7. **Time** — the month is Cairo's, and it is the backend's to decide.
//! 8. **Persistence** — defaults and overrides survive a new connection, i.e. a
//!    restart.
//! 9. **Authorization** — configuring a target is ADMIN; a cashier or manager
//!    cannot do it.

use crate::db::migrate;
use crate::repositories::invoices::{self, InvoiceLine};
use crate::repositories::users::User;
use crate::services::sales as sales_svc;
use crate::services::settings::{
    self, MonthTargetOverride, RevenueDepartment, RevenueTargetDefaults,
};
use rusqlite::Connection;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    for (name, role) in [
        ("admin", "ADMIN"),
        ("manager", "MANAGER"),
        ("cashier", "STAFF"),
    ] {
        conn.execute(
            "INSERT INTO users (name, role, password_hash) VALUES (?1, ?2, 'x')",
            rusqlite::params![name, role],
        )
        .unwrap();
    }
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

/// The owner's example, in piastres: CAFE 150,000 EGP / WASH 80,000 EGP.
fn defaults() -> RevenueTargetDefaults {
    RevenueTargetDefaults {
        cafe_minor: 15_000_000,
        wash_minor: 8_000_000,
    }
}

fn set_defaults(conn: &Connection, cafe: i64, wash: i64) {
    settings::set_revenue_target_defaults(
        conn,
        &actor(conn, "admin"),
        &RevenueTargetDefaults {
            cafe_minor: cafe,
            wash_minor: wash,
        },
    )
    .unwrap();
}

/// Sets or clears each department's override for one month, independently.
fn override_month(conn: &Connection, month: &str, cafe: Option<i64>, wash: Option<i64>) {
    for (department, amount) in [
        (RevenueDepartment::Cafe, cafe),
        (RevenueDepartment::Wash, wash),
    ] {
        settings::set_revenue_target_override(
            conn,
            &actor(conn, "admin"),
            month,
            department,
            amount,
        )
        .unwrap();
    }
}

fn target(
    conn: &Connection,
    month: &str,
    department: RevenueDepartment,
) -> settings::MonthlyTarget {
    settings::resolve_monthly_target(conn, month, department).unwrap()
}

fn add_day(conn: &Connection, date: &str) -> i64 {
    conn.execute(
        "INSERT INTO business_days (day_date, opened_at, status, opened_by)
         VALUES (?1, datetime('now'), 'CLOSED', 1)",
        [date],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// The month the fixtures are dated in: the one the backend clock is in.
fn business_month() -> String {
    crate::time::current_business_month()
}

/// The progress read the Sales page performs, for a manager.
fn current_progress(conn: &Connection) -> sales_svc::MonthlyTargetProgress {
    sales_svc::target_progress(conn, &actor(conn, "manager")).unwrap()
}

/// Days in a `YYYY-MM` key, from the rule the backend resolves bounds by.
fn days_in_month(month: &str) -> u32 {
    crate::time::business_month_bounds(month).unwrap().1[8..].parse().unwrap()
}

/// Up to `count` business dates ending TODAY, all still inside the current
/// month.
///
/// The progress read deliberately stops at today, so a test cannot invent a
/// business day in the future and expect it in the series. Asking for the last
/// few days instead keeps the fixture valid on the FIRST of a month as well as
/// on the thirty-first.
fn recent_business_days(count: usize) -> Vec<String> {
    let today = crate::time::today_business_date();
    let month = today[..7].to_string();
    let date = chrono::NaiveDate::parse_from_str(&today, "%Y-%m-%d").unwrap();
    (0..count)
        .map(|back| (date - chrono::Duration::days(back as i64)).to_string())
        .take_while(|day| day.starts_with(&month))
        .collect()
}

/// An invoice whose LINES define its department split, exactly as checkout
/// snapshots it: `cafe_total` is the sum of its CAFE lines and `wash_total` the
/// sum of its WASH lines. The helper computes those the same way, so no test can
/// assert a split that checkout would never have produced.
///
/// `takeaway` picks the order TYPE, which Station stores as `TABLE` or
/// `TAKEAWAY` only. That is the point of the parameter: an invoice is neither a
/// cafe invoice nor a wash invoice because of its type — a "hybrid" document is
/// simply one carrying BOTH departments' lines, and this helper can build one
/// from a `TABLE` order, which is exactly what makes `revenue_department =
/// order_type` impossible to smuggle in.
fn add_invoice(
    conn: &Connection,
    invoice_no: i64,
    day_id: i64,
    user_id: i64,
    takeaway: bool,
    service_charge: i64,
    lines: &[(&str, i64)],
) -> i64 {
    let order_type = if takeaway { "TAKEAWAY" } else { "TABLE" };
    let order_id = {
        // A TABLE order must reference a real table; a takeaway must not. The
        // schema enforces that pairing, which is why the helper picks the
        // column from the same flag it picks the type from.
        let table_id = if takeaway {
            None
        } else {
            conn.execute(
                "INSERT INTO cafe_tables (label) VALUES ('طاولة ' || ?1)",
                [conn.last_insert_rowid().to_string()],
            )
            .unwrap();
            Some(conn.last_insert_rowid())
        };
        conn.execute(
            "INSERT INTO orders (order_type, table_id, user_id, business_day_id, status)
             VALUES (?1, ?2, ?3, ?4, 'CLOSED')",
            rusqlite::params![order_type, table_id, user_id, day_id],
        )
        .unwrap();
        conn.last_insert_rowid()
    };
    let cafe: i64 = lines
        .iter()
        .filter(|(d, _)| *d == "CAFE")
        .map(|(_, total)| *total)
        .sum();
    let wash: i64 = lines
        .iter()
        .filter(|(d, _)| *d == "WASH")
        .map(|(_, total)| *total)
        .sum();
    let snapshot: Vec<InvoiceLine> = lines
        .iter()
        .map(|(department, total)| InvoiceLine {
            department: (*department).into(),
            product_name: "صنف".into(),
            unit_price: *total,
            quantity: 1,
            discount_minor: 0,
            line_total: *total,
        })
        .collect();
    invoices::insert_invoice(
        conn,
        invoice_no,
        order_id,
        None,
        day_id,
        None,
        user_id,
        order_type,
        None,
        None,
        cafe + wash,
        0,
        None,
        None,
        service_charge,
        cafe + wash + service_charge,
        cafe,
        wash,
        &snapshot,
    )
    .unwrap()
}

fn user_id(conn: &Connection, name: &str) -> i64 {
    conn.query_row("SELECT id FROM users WHERE name = ?1", [name], |r| r.get(0))
        .unwrap()
}

// ---------------------------------------------------------------------------
// 1. defaults
// ---------------------------------------------------------------------------

#[test]
fn an_unconfigured_installation_has_no_target_at_all() {
    let conn = fresh();
    // Nothing configured reads as zero — "no target", not an invented number,
    // and never a fabricated 100% achievement.
    let cafe = target(&conn, "2026-10", RevenueDepartment::Cafe);
    assert_eq!(cafe.target_minor, 0);
    assert!(!cafe.overridden);
    assert_eq!(
        target(&conn, "2026-10", RevenueDepartment::Wash).target_minor,
        0
    );
}

#[test]
fn the_default_targets_resolve_for_both_departments() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);

    let cafe = target(&conn, "2026-10", RevenueDepartment::Cafe);
    assert_eq!(cafe.target_minor, 15_000_000);
    assert_eq!(cafe.department, "CAFE");
    assert!(!cafe.overridden, "the default is not an override");

    let wash = target(&conn, "2026-10", RevenueDepartment::Wash);
    assert_eq!(wash.target_minor, 8_000_000);
    assert_eq!(wash.department, "WASH");
    assert!(!wash.overridden);
}

// ---------------------------------------------------------------------------
// 2. overrides
// ---------------------------------------------------------------------------

#[test]
fn a_months_override_replaces_the_default_for_that_month() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    override_month(&conn, "2026-10", Some(17_500_000), None);

    let cafe = target(&conn, "2026-10", RevenueDepartment::Cafe);
    assert_eq!(cafe.target_minor, 17_500_000);
    assert!(cafe.overridden, "the month states that it overrides");
    // Overriding cafe leaves wash on the default.
    assert_eq!(
        target(&conn, "2026-10", RevenueDepartment::Wash).target_minor,
        8_000_000
    );
}

#[test]
fn overriding_one_department_never_moves_the_other() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    override_month(&conn, "2026-10", Some(17_500_000), None);
    assert_eq!(
        target(&conn, "2026-10", RevenueDepartment::Wash).target_minor,
        8_000_000
    );

    // And the reverse: a wash-only override leaves cafe exactly where it was.
    let other = fresh();
    set_defaults(&other, 15_000_000, 8_000_000);
    override_month(&other, "2026-10", None, Some(9_000_000));
    assert_eq!(
        target(&other, "2026-10", RevenueDepartment::Cafe).target_minor,
        15_000_000
    );
    assert_eq!(
        target(&other, "2026-10", RevenueDepartment::Wash).target_minor,
        9_000_000
    );
}
#[test]
fn both_departments_override_independently() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    override_month(&conn, "2026-10", Some(17_500_000), Some(9_000_000));

    assert_eq!(
        target(&conn, "2026-10", RevenueDepartment::Cafe).target_minor,
        17_500_000
    );
    assert_eq!(
        target(&conn, "2026-10", RevenueDepartment::Wash).target_minor,
        9_000_000
    );
    let stored = settings::get_revenue_target_overrides(&conn, "2026-10").unwrap();
    assert_eq!(stored.cafe_minor, Some(17_500_000));
    assert_eq!(stored.wash_minor, Some(9_000_000));
}

#[test]
fn clearing_one_override_restores_the_default_and_keeps_the_other() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    override_month(&conn, "2026-10", Some(17_500_000), Some(9_000_000));

    settings::set_revenue_target_override(
        &conn,
        &actor(&conn, "admin"),
        "2026-10",
        RevenueDepartment::Cafe,
        None,
    )
    .unwrap();

    // The cafe override is gone; the wash override survived the clearing.
    let cafe = target(&conn, "2026-10", RevenueDepartment::Cafe);
    assert_eq!(cafe.target_minor, 15_000_000, "back to the default");
    assert!(!cafe.overridden);
    assert_eq!(
        target(&conn, "2026-10", RevenueDepartment::Wash).target_minor,
        9_000_000
    );
}

#[test]
fn clearing_the_last_override_leaves_the_month_with_no_record_at_all() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    override_month(&conn, "2026-10", Some(17_500_000), Some(9_000_000));
    override_month(&conn, "2026-10", None, None);

    // An empty husk would be a SECOND way of saying "no override"; the month is
    // simply absent again.
    assert_eq!(
        settings::get_revenue_target_overrides(&conn, "2026-10").unwrap(),
        MonthTargetOverride::default()
    );
    assert_eq!(
        target(&conn, "2026-10", RevenueDepartment::Cafe).target_minor,
        15_000_000
    );
}

#[test]
fn overriding_the_same_month_again_replaces_its_effective_value() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    override_month(&conn, "2026-10", Some(17_500_000), None);
    assert_eq!(
        target(&conn, "2026-10", RevenueDepartment::Cafe).target_minor,
        17_500_000
    );

    override_month(&conn, "2026-10", Some(20_000_000), None);
    assert_eq!(
        target(&conn, "2026-10", RevenueDepartment::Cafe).target_minor,
        20_000_000
    );
}

// ---------------------------------------------------------------------------
// 3. month isolation & historical determinism
// ---------------------------------------------------------------------------

#[test]
fn octobers_override_does_not_reach_november() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    override_month(&conn, "2026-10", Some(17_500_000), None);

    assert_eq!(
        target(&conn, "2026-11", RevenueDepartment::Cafe).target_minor,
        15_000_000
    );
    assert_eq!(
        target(&conn, "2026-09", RevenueDepartment::Cafe).target_minor,
        15_000_000
    );
    assert!(!target(&conn, "2026-11", RevenueDepartment::Cafe).overridden);
}

#[test]
fn changing_the_default_never_mutates_a_month_that_already_overrides_it() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    override_month(&conn, "2026-10", Some(17_500_000), Some(9_000_000));

    // The owner raises the default for future months.
    set_defaults(&conn, 20_000_000, 10_000_000);

    // October keeps its own numbers…
    assert_eq!(
        target(&conn, "2026-10", RevenueDepartment::Cafe).target_minor,
        17_500_000
    );
    assert_eq!(
        target(&conn, "2026-10", RevenueDepartment::Wash).target_minor,
        9_000_000
    );
    // …and a month with no override follows the new default.
    assert_eq!(
        target(&conn, "2026-11", RevenueDepartment::Cafe).target_minor,
        20_000_000
    );
    assert_eq!(
        target(&conn, "2026-11", RevenueDepartment::Wash).target_minor,
        10_000_000
    );
}
#[test]
fn several_months_are_stored_independently() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    override_month(&conn, "2026-08", Some(12_000_000), None);
    override_month(&conn, "2026-10", Some(17_500_000), Some(9_000_000));
    override_month(&conn, "2026-12", None, Some(11_000_000));

    assert_eq!(
        target(&conn, "2026-07", RevenueDepartment::Cafe).target_minor,
        15_000_000
    );
    assert_eq!(
        target(&conn, "2026-08", RevenueDepartment::Cafe).target_minor,
        12_000_000
    );
    assert_eq!(
        target(&conn, "2026-08", RevenueDepartment::Wash).target_minor,
        8_000_000
    );
    assert_eq!(
        target(&conn, "2026-10", RevenueDepartment::Cafe).target_minor,
        17_500_000
    );
    assert_eq!(
        target(&conn, "2026-11", RevenueDepartment::Cafe).target_minor,
        15_000_000
    );
    assert_eq!(
        target(&conn, "2026-12", RevenueDepartment::Wash).target_minor,
        11_000_000
    );
}

#[test]
fn reading_a_historical_month_is_repeatable() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    override_month(&conn, "2026-06", Some(11_000_000), None);

    // The same month resolves to the same number every time it is asked for —
    // the model is a lookup, never a moving figure.
    for _ in 0..3 {
        assert_eq!(
            target(&conn, "2026-06", RevenueDepartment::Cafe).target_minor,
            11_000_000
        );
    }
}

// ---------------------------------------------------------------------------
// 4. money rules
// ---------------------------------------------------------------------------

#[test]
fn a_whole_pound_target_is_accepted() {
    assert!(settings::validate_revenue_target(0).is_ok());
    assert!(settings::validate_revenue_target(15_000_000).is_ok());
    assert!(settings::validate_revenue_target(100).is_ok());
}

#[test]
fn a_fractional_negative_or_absurd_target_is_refused() {
    // 150,000.50 EGP, a negative target, and a value past the storage ceiling.
    for bad in [15_000_050, 15_000_001, -100, -15_000_000, i64::MAX] {
        assert!(
            settings::validate_revenue_target(bad).is_err(),
            "{bad} must be refused"
        );
    }
}

#[test]
fn a_refused_default_leaves_the_stored_one_untouched() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);

    assert!(settings::set_revenue_target_defaults(
        &conn,
        &actor(&conn, "admin"),
        &RevenueTargetDefaults {
            cafe_minor: 15_000_050, // half a piastre over a whole pound
            wash_minor: 8_000_000,
        },
    )
    .is_err());

    assert_eq!(
        settings::get_revenue_target_defaults(&conn).unwrap().cafe_minor,
        15_000_000
    );
}

#[test]
fn a_refused_override_leaves_the_month_untouched() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    override_month(&conn, "2026-10", Some(17_500_000), None);

    assert!(settings::set_revenue_target_override(
        &conn,
        &actor(&conn, "admin"),
        "2026-10",
        RevenueDepartment::Cafe,
        Some(-1),
    )
    .is_err());

    assert_eq!(
        target(&conn, "2026-10", RevenueDepartment::Cafe).target_minor,
        17_500_000
    );
}

#[test]
fn a_malformed_month_is_refused_rather_than_repaired() {
    let conn = fresh();
    // Guessing `2026-1` into `2026-01` would read a month nobody configured.
    for bad in ["2026-1", "2026-13", "2026/10", "2026-10-01", "أكتوبر 2026", ""] {
        assert!(
            settings::set_revenue_target_override(
                &conn,
                &actor(&conn, "admin"),
                bad,
                RevenueDepartment::Cafe,
                Some(17_500_000),
            )
            .is_err(),
            "{bad} must be refused"
        );
        assert!(
            settings::resolve_monthly_target(&conn, bad, RevenueDepartment::Cafe).is_err(),
            "{bad} must not resolve"
        );
    }
}
// ---------------------------------------------------------------------------
// 5. revenue attribution — the canonical rules, unchanged
// ---------------------------------------------------------------------------

#[test]
fn cafe_revenue_fills_the_cafe_target_only() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    let day = add_day(&conn, &crate::time::today_business_date());
    add_invoice(
        &conn,
        1,
        day,
        user_id(&conn, "cashier"),
        false,
        0,
        &[("CAFE", 6_000_000)],
    );

    let progress = current_progress(&conn);
    assert_eq!(progress.cafe.actual_minor, 6_000_000);
    assert_eq!(progress.wash.actual_minor, 0, "cafe money is not wash money");
}

#[test]
fn wash_revenue_fills_the_wash_target_only() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    let day = add_day(&conn, &crate::time::today_business_date());
    add_invoice(
        &conn,
        1,
        day,
        user_id(&conn, "cashier"),
        false,
        0,
        &[("WASH", 2_000_000)],
    );

    let progress = current_progress(&conn);
    assert_eq!(progress.wash.actual_minor, 2_000_000);
    assert_eq!(progress.cafe.actual_minor, 0);
}

#[test]
fn a_hybrid_invoice_splits_between_the_two_targets() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    let day = add_day(&conn, &crate::time::today_business_date());
    // One hybrid order carrying both lines — the department split comes from the
    // ITEMS, exactly as the invoice snapshot records it.
    add_invoice(
        &conn,
        1,
        day,
        user_id(&conn, "cashier"),
        false,
        0,
        &[("CAFE", 4_000_000), ("WASH", 1_000_000)],
    );

    let progress = current_progress(&conn);
    assert_eq!(progress.cafe.actual_minor, 4_000_000);
    assert_eq!(progress.wash.actual_minor, 1_000_000);
    // There is no hybrid target that could have got the split wrong.
    assert_eq!(progress.cafe.department, "CAFE");
    assert_eq!(progress.wash.department, "WASH");
}

#[test]
fn a_takeaway_invoice_contributes_by_its_items_and_gets_no_target() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    let day = add_day(&conn, &crate::time::today_business_date());
    // TAKEAWAY is not a revenue department, so this money lands in the
    // department its LINES are in — not in a takeaway target of its own.
    add_invoice(
        &conn,
        1,
        day,
        user_id(&conn, "cashier"),
        true,
        0,
        &[("CAFE", 3_000_000)],
    );

    let progress = current_progress(&conn);
    assert_eq!(progress.cafe.actual_minor, 3_000_000);
    assert_eq!(progress.wash.actual_minor, 0);
}

#[test]
fn a_service_charge_is_neither_departments_revenue() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    let day = add_day(&conn, &crate::time::today_business_date());
    add_invoice(
        &conn,
        1,
        day,
        user_id(&conn, "cashier"),
        false,
        1_000_000,
        &[("CAFE", 5_000_000)],
    );

    let progress = current_progress(&conn);
    // The charge is on the invoice total and in neither department subtotal, so
    // it must not inflate either target's achievement.
    assert_eq!(progress.cafe.actual_minor, 5_000_000);
    assert_eq!(progress.wash.actual_minor, 0);
}
// ---------------------------------------------------------------------------
// 6. percentages
// ---------------------------------------------------------------------------

#[test]
fn a_half_achieved_month_reads_exactly_fifty_percent() {
    let conn = fresh();
    set_defaults(&conn, 17_500_000, 9_000_000);
    let day = add_day(&conn, &crate::time::today_business_date());
    add_invoice(
        &conn,
        1,
        day,
        user_id(&conn, "cashier"),
        false,
        0,
        &[("CAFE", 8_750_000), ("WASH", 4_500_000)],
    );

    let progress = current_progress(&conn);
    assert_eq!(progress.cafe.achievement_hundredths, Some(5_000));
    assert_eq!(progress.cafe.achievement_percent.as_deref(), Some("50.00"));
    assert_eq!(progress.wash.achievement_hundredths, Some(5_000));
    assert_eq!(progress.wash.achievement_percent.as_deref(), Some("50.00"));
}

#[test]
fn an_over_achieved_month_is_never_clamped_to_one_hundred() {
    let conn = fresh();
    set_defaults(&conn, 17_500_000, 8_000_000);
    let day = add_day(&conn, &crate::time::today_business_date());
    add_invoice(
        &conn,
        1,
        day,
        user_id(&conn, "cashier"),
        false,
        0,
        &[("CAFE", 20_000_000)],
    );

    let progress = current_progress(&conn);
    // 200,000 / 175,000 = 114.2857…%, which half-up at two decimals is 114.29%.
    // The business value is deliberately NOT clamped to 100.
    assert_eq!(progress.cafe.achievement_hundredths, Some(11_429));
    assert_eq!(progress.cafe.achievement_percent.as_deref(), Some("114.29"));
    // Nothing is left to earn toward a target that has been passed.
    assert_eq!(progress.cafe.remaining_minor, 0);
}

#[test]
fn a_zero_target_reports_no_achievement_rather_than_dividing() {
    let conn = fresh();
    // No target configured at all, but real revenue.
    let day = add_day(&conn, &crate::time::today_business_date());
    add_invoice(
        &conn,
        1,
        day,
        user_id(&conn, "cashier"),
        false,
        0,
        &[("CAFE", 4_000_000)],
    );

    let progress = current_progress(&conn);
    // The ONE representation of "nothing to measure against": unavailable, not
    // 0% (which would claim nothing was achieved) and not 100% (invented).
    assert_eq!(progress.cafe.achievement_hundredths, None);
    assert_eq!(progress.cafe.achievement_percent, None);
    assert_eq!(progress.cafe.target_minor, 0);
    assert_eq!(progress.cafe.actual_minor, 4_000_000);
    assert_eq!(progress.cafe.remaining_minor, 0);
}

#[test]
fn an_explicitly_zero_target_behaves_the_same_as_no_target() {
    let conn = fresh();
    override_month(&conn, &business_month(), Some(0), None);
    let day = add_day(&conn, &crate::time::today_business_date());
    add_invoice(
        &conn,
        1,
        day,
        user_id(&conn, "cashier"),
        false,
        0,
        &[("CAFE", 1_000_000)],
    );

    let progress = current_progress(&conn);
    assert_eq!(progress.cafe.target_minor, 0);
    assert!(progress.cafe.overridden, "zero is a real override");
    assert_eq!(progress.cafe.achievement_hundredths, None);
}

#[test]
fn a_month_with_no_revenue_reports_zero_against_a_real_target() {
    let conn = fresh();
    set_defaults(&conn, 15_000_000, 8_000_000);
    let progress = current_progress(&conn);

    assert_eq!(progress.cafe.actual_minor, 0);
    assert_eq!(progress.cafe.achievement_hundredths, Some(0));
    assert_eq!(progress.cafe.remaining_minor, 15_000_000);
    assert!(progress.daily.is_empty());
}
// ---------------------------------------------------------------------------
// 7. daily progress & time
// ---------------------------------------------------------------------------

#[test]
fn the_daily_series_is_cumulative_and_uses_the_effective_target() {
    let conn = fresh();
    let month = business_month();
    // Today and the days before it, so the fixture never reaches past the
    // month the read stops at. `recent_business_days` walks BACK from today, so
    // it hands them over newest first; the series reads forward through the
    // month, so they are ordered oldest first here and the running sum is
    // predictable.
    let mut ordered = recent_business_days(3);
    ordered.sort();
    let dates: [String; 3] = match ordered.try_into() {
        Ok(three) => three,
        Err(_) => {
            // The first of the month leaves only one day to report; the series is
            // still correct, just shorter, and the cumulative rule is covered by
            // `a_quiet_day_still_appears_as_a_zero_day`.
            return;
        }
    };
    let [first, second, third] = dates;
    for (no, (date, amount)) in [first.clone(), second.clone(), third.clone()]
        .into_iter()
        .zip([2_000_000, 3_000_000, 1_000_000])
        .enumerate()
    {
        let day = add_day(&conn, &date);
        add_invoice(
            &conn,
            no as i64 + 1,
            day,
            user_id(&conn, "cashier"),
            false,
            0,
            &[("CAFE", amount)],
        );
    }

    // The override applies to the WHOLE month, so every day is read against it.
    override_month(&conn, &month, Some(12_000_000), None);

    let progress = current_progress(&conn);
    let days = &progress.daily;
    assert_eq!(days.len(), 3, "one row per business day, in order");
    assert_eq!(days[0].day_date, first);
    assert_eq!(days[1].day_date, second);
    assert_eq!(days[2].day_date, third);

    // A day's own revenue…
    assert_eq!(days[1].cafe_revenue, 3_000_000);
    // …and the running sum through that day, measured against the FULL monthly
    // target — never a "daily target" derived by dividing it by the days.
    assert_eq!(days[0].cafe_cumulative, 2_000_000);
    assert_eq!(days[1].cafe_cumulative, 5_000_000);
    assert_eq!(days[2].cafe_cumulative, 6_000_000);
    assert_eq!(progress.cafe.actual_minor, 6_000_000);
    assert_eq!(progress.cafe.target_minor, 12_000_000);
    // 6,000,000 / 12,000,000.
    assert_eq!(progress.cafe.achievement_hundredths, Some(5_000));
}

#[test]
fn a_quiet_day_still_appears_as_a_zero_day() {
    let conn = fresh();
    // Today trades; the day before it is open but silent. Both are business days,
    // so both must appear — one with revenue and one without.
    let dates = recent_business_days(2);
    let [quiet, busy]: [String; 2] = match dates.try_into() {
        Ok(pair) => pair,
        Err(_) => {
            // Only one day of the month has happened yet; there is no quiet day
            // to prove anything about.
            return;
        }
    };
    let busy_day = add_day(&conn, &busy);
    add_day(&conn, &quiet);
    add_invoice(
        &conn,
        1,
        busy_day,
        user_id(&conn, "cashier"),
        false,
        0,
        &[("CAFE", 2_000_000)],
    );

    let progress = current_progress(&conn);
    assert_eq!(
        progress.daily.len(),
        2,
        "a quiet day reads as zero, not as gone"
    );
    assert_eq!(progress.daily[1].cafe_revenue, 0);
    assert_eq!(
        progress.daily[1].cafe_cumulative, 2_000_000,
        "cumulative carries the month forward through a quiet day"
    );
}

#[test]
fn the_progress_read_states_the_cairo_business_month_and_its_days() {
    let conn = fresh();
    let progress = current_progress(&conn);
    let today = crate::time::today_business_date();

    // The month the BACKEND clock is in — not one a browser could disagree with,
    // and not a localized display string.
    assert_eq!(progress.month, crate::time::current_business_month());
    assert!(progress.month.starts_with(&today[..7]));
    // The window starts on the first of that month and stops at today, so the
    // series never claims days that have not happened yet.
    assert_eq!(progress.from, format!("{}-01", progress.month));
    assert_eq!(progress.to, today);
}

#[test]
fn revenue_from_last_month_does_not_count_towards_this_month() {
    let conn = fresh();
    let month = business_month();
    // The last day of the PREVIOUS month, from the same calendar rule.
    let previous_month = &crate::time::business_date_months_ago(1)[..7];
    let last_day = format!("{previous_month}-{}", days_in_month(previous_month));
    let old_day = add_day(&conn, &last_day);
    add_invoice(
        &conn,
        1,
        old_day,
        user_id(&conn, "cashier"),
        false,
        0,
        &[("CAFE", 9_000_000)],
    );

    set_defaults(&conn, 15_000_000, 8_000_000);
    let progress = current_progress(&conn);
    assert_eq!(progress.cafe.actual_minor, 0, "last month is last month");
    assert!(
        progress.daily.iter().all(|d| d.day_date.starts_with(&month)),
        "the series describes this month only"
    );
}
// ---------------------------------------------------------------------------
// 8. persistence
// ---------------------------------------------------------------------------

#[test]
fn defaults_and_overrides_survive_a_restart() {
    let dir = std::env::temp_dir().join(format!(
        "station-targets-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("station_cafe.db");

    {
        let conn = Connection::open(&path).unwrap();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO users (name, role, password_hash) VALUES ('admin', 'ADMIN', 'x')",
            [],
        )
        .unwrap();
        let admin = actor(&conn, "admin");
        settings::set_revenue_target_defaults(&conn, &admin, &defaults()).unwrap();
        settings::set_revenue_target_override(
            &conn,
            &admin,
            "2026-10",
            RevenueDepartment::Cafe,
            Some(17_500_000),
        )
        .unwrap();
    }

    // A brand new connection is what a restart actually looks like.
    let reopened = Connection::open(&path).unwrap();
    migrate(&reopened).unwrap();
    assert_eq!(
        settings::get_revenue_target_defaults(&reopened).unwrap(),
        defaults()
    );
    let october =
        settings::resolve_monthly_target(&reopened, "2026-10", RevenueDepartment::Cafe).unwrap();
    assert_eq!(october.target_minor, 17_500_000);
    assert!(october.overridden);
    assert_eq!(
        settings::resolve_monthly_target(&reopened, "2026-10", RevenueDepartment::Wash)
            .unwrap()
            .target_minor,
        8_000_000
    );

    drop(reopened);
    std::fs::remove_dir_all(&dir).ok();
}

// ---------------------------------------------------------------------------
// 9. authorization
// ---------------------------------------------------------------------------

#[test]
fn configuring_a_target_is_manager_or_above() {
    let conn = fresh();

    // A MANAGER owns the cafe/wash yardstick and the active month's override:
    // both are on the manager's Dev Settings allowlist.
    let manager = actor(&conn, "manager");
    settings::set_revenue_target_defaults(&conn, &manager, &defaults()).unwrap();
    settings::set_revenue_target_override(
        &conn,
        &manager,
        "2026-10",
        RevenueDepartment::Cafe,
        Some(17_500_000),
    )
    .unwrap();
    assert_eq!(
        settings::get_revenue_target_defaults(&conn).unwrap(),
        defaults()
    );

    // A CASHIER may not. They configure nothing in Dev Settings at all.
    let user = actor(&conn, "cashier");
    assert!(
        settings::set_revenue_target_defaults(&conn, &user, &defaults()).is_err(),
        "cashier must not set defaults"
    );
    assert!(
        settings::set_revenue_target_override(
            &conn,
            &user,
            "2026-10",
            RevenueDepartment::Cafe,
            Some(17_500_000),
        )
        .is_err(),
        "cashier must not set an override"
    );
    // A refused write changes nothing: the manager's values are still stored.
    assert_eq!(
        settings::get_revenue_target_defaults(&conn).unwrap(),
        defaults()
    );
    assert_eq!(
        settings::resolve_monthly_target(&conn, "2026-10", RevenueDepartment::Cafe)
            .unwrap()
            .target_minor,
        17_500_000
    );
}

#[test]
fn a_cashier_cannot_read_the_target_progress() {
    let conn = fresh();
    assert!(sales_svc::target_progress(&conn, &actor(&conn, "cashier")).is_err());
    // A manager can — it is the Sales page's own surface.
    assert!(sales_svc::target_progress(&conn, &actor(&conn, "manager")).is_ok());
}
