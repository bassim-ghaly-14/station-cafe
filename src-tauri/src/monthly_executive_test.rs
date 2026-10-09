//! The monthly executive report — the COMPOSITION, not a re-derivation.
//!
//! This suite proves the report is a faithful VIEW of the existing sources
//! rather than a second set of rules: revenue attribution, target resolution
//! (including month overrides), the money figures, the previous month, the Cairo
//! month boundaries, and authorization.

use crate::db::migrate;
use crate::repositories::expenses;
use crate::repositories::invoices::{self, InvoiceLine};
use crate::repositories::users::User;
use crate::services::reports::{self, MonthlyComparison};
use crate::services::settings::{self, RevenueDepartment, RevenueTargetDefaults};
use rusqlite::Connection;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    for (name, role) in [("manager", "MANAGER"), ("cashier", "STAFF")] {
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
            Ok((r.get(0)?, r.get::<_, String>(1)?))
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

fn add_day(conn: &Connection, date: &str) -> i64 {
    conn.execute(
        "INSERT INTO business_days (day_date, opened_at, status, opened_by)
         VALUES (?1, datetime('now'), 'CLOSED', 1)",
        [date],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// A hybrid invoice carrying both departments, written through the repository
/// checkout itself uses, so the `cafe_total` / `wash_total` snapshot the report
/// reads is the one a real sale would have produced.
fn add_sale(conn: &Connection, no: i64, day_id: i64, cafe: i64, wash: i64, charge: i64) {
    let user_id = actor(conn, "manager").id;
    conn.execute(
        "INSERT INTO orders (order_type, user_id, business_day_id, status)
         VALUES ('TAKEAWAY', ?1, ?2, 'CLOSED')",
        rusqlite::params![user_id, day_id],
    )
    .unwrap();
    let order_id = conn.last_insert_rowid();
    let lines: Vec<InvoiceLine> = [("CAFE", cafe), ("WASH", wash)]
        .into_iter()
        .filter(|(_, total)| *total > 0)
        .map(|(department, total)| InvoiceLine {
            department: department.into(),
            product_name: "صنف".into(),
            unit_price: total,
            quantity: 1,
            discount_minor: 0,
            line_total: total,
        })
        .collect();
    invoices::insert_invoice(
        conn,
        no,
        order_id,
        None,
        day_id,
        None,
        user_id,
        "TAKEAWAY",
        None,
        None,
        cafe + wash,
        0,
        None,
        None,
        charge,
        cafe + wash + charge,
        cafe,
        wash,
        &lines,
    )
    .unwrap();
}

fn spend(conn: &Connection, category: &str, amount: i64, date: &str) {
    expenses::insert(
        conn,
        category,
        amount,
        None,
        date,
        false,
        None,
        None,
        None,
        true,
        actor(conn, "manager").id,
        None,
    )
    .unwrap();
}

fn report(conn: &Connection, month: Option<&str>) -> reports::MonthlyExecutiveReport {
    report_comparison(conn, month, MonthlyComparison::PreviousMonth)
}

fn report_comparison(
    conn: &Connection,
    month: Option<&str>,
    comparison: MonthlyComparison,
) -> reports::MonthlyExecutiveReport {
    reports::monthly_executive(conn, &actor(conn, "manager"), month, comparison).unwrap()
}

// ---------------------------------------------------------------------------
// revenue attribution
// ---------------------------------------------------------------------------

#[test]
fn cafe_and_wash_actuals_are_the_departments_own_share_of_the_month() {
    let conn = fresh();
    let day = add_day(&conn, "2026-03-10");
    add_sale(&conn, 1, day, 8_000_00, 4_000_00, 0);
    // A sale in ANOTHER month must not leak into March.
    let other = add_day(&conn, "2026-04-10");
    add_sale(&conn, 2, other, 99_000_00, 0, 0);

    let r = report(&conn, Some("2026-03"));
    assert_eq!(r.cafe.actual_minor, 8_000_00);
    assert_eq!(r.wash.actual_minor, 4_000_00);
    // The total is the invoice `total` — the same authoritative revenue the
    // Sales page prints.
    assert_eq!(r.money.revenue_minor, 12_000_00);
}

#[test]
fn a_service_charge_is_revenue_but_belongs_to_neither_department() {
    let conn = fresh();
    let day = add_day(&conn, "2026-03-10");
    add_sale(&conn, 1, day, 8_000_00, 4_000_00, 500_00);

    let r = report(&conn, Some("2026-03"));
    assert_eq!(r.money.revenue_minor, 12_500_00);
    assert_eq!(r.cafe.actual_minor, 8_000_00);
    assert_eq!(r.wash.actual_minor, 4_000_00);
}

#[test]
fn a_month_with_no_trading_reads_as_zero_rather_than_failing() {
    let conn = fresh();
    let r = report(&conn, Some("2026-03"));
    assert_eq!(r.money.revenue_minor, 0);
    assert_eq!(r.money.expenses_minor, 0);
    assert_eq!(r.cafe.actual_minor, 0);
    assert_eq!(r.wash.actual_minor, 0);
}

// ---------------------------------------------------------------------------
// targets — resolved, never re-derived, never combined
// ---------------------------------------------------------------------------

#[test]
fn each_department_uses_its_own_resolved_target_and_never_a_combined_one() {
    let conn = fresh();
    let day = add_day(&conn, "2026-03-10");
    add_sale(&conn, 1, day, 8_240_00, 4_300_00, 0);
    settings::set_revenue_target_defaults(
        &conn,
        &actor(&conn, "manager"),
        &RevenueTargetDefaults {
            cafe_minor: 8_000_00,
            wash_minor: 4_500_00,
        },
    )
    .unwrap();

    let r = report(&conn, Some("2026-03"));
    assert_eq!(r.cafe.target_minor, 8_000_00);
    assert_eq!(r.wash.target_minor, 4_500_00);
    assert_eq!(r.cafe.achievement_percent.as_deref(), Some("103.00"));
    assert_eq!(r.wash.achievement_percent.as_deref(), Some("95.56"));
    // There is no combined field at all, and cafe's surplus is never used to
    // excuse wash's shortfall.
    assert!(!r.cafe.overridden);
    assert!(!r.wash.overridden);
}

#[test]
fn a_month_override_is_reflected_for_that_month_and_that_month_only() {
    let conn = fresh();
    let day = add_day(&conn, "2026-03-10");
    add_sale(&conn, 1, day, 8_240_00, 0, 0);
    settings::set_revenue_target_defaults(
        &conn,
        &actor(&conn, "manager"),
        &RevenueTargetDefaults {
            cafe_minor: 8_000_00,
            wash_minor: 0,
        },
    )
    .unwrap();
    settings::set_revenue_target_override(
        &conn,
        &actor(&conn, "manager"),
        "2026-03",
        RevenueDepartment::Cafe,
        Some(10_000_00),
    )
    .unwrap();

    let overridden = report(&conn, Some("2026-03"));
    assert!(overridden.cafe.overridden);
    assert_eq!(overridden.cafe.target_minor, 10_000_00);
    assert_eq!(
        overridden.cafe.achievement_percent.as_deref(),
        Some("82.40")
    );

    // A month with no override keeps following the cafe-wide default.
    let april = report(&conn, Some("2026-04"));
    assert!(!april.cafe.overridden);
    assert_eq!(april.cafe.target_minor, 8_000_00);
}

#[test]
fn a_month_without_a_target_reports_no_percentage_at_all() {
    let conn = fresh();
    let day = add_day(&conn, "2026-03-10");
    add_sale(&conn, 1, day, 5_000_00, 0, 0);

    let r = report(&conn, Some("2026-03"));
    // `None` is the ONE "no target" answer in Station — never a fabricated 0%.
    assert_eq!(r.cafe.achievement_percent, None);
    assert_eq!(r.wash.achievement_percent, None);
}
// ---------------------------------------------------------------------------
// money
// ---------------------------------------------------------------------------

#[test]
fn net_is_revenue_minus_expenses_for_that_month() {
    let conn = fresh();
    let day = add_day(&conn, "2026-03-10");
    add_sale(&conn, 1, day, 8_000_00, 4_500_00, 0);
    spend(&conn, "SUPPLIES", 3_240_00, "2026-03-15");
    // An expense outside the month is not this month's spend.
    spend(&conn, "SUPPLIES", 9_999_00, "2026-04-02");

    let r = report(&conn, Some("2026-03"));
    assert_eq!(r.money.revenue_minor, 12_500_00);
    assert_eq!(r.money.expenses_minor, 3_240_00);
    assert_eq!(r.money.net_minor, 9_260_00);
}

// ---------------------------------------------------------------------------
// the previous month
// ---------------------------------------------------------------------------

#[test]
fn the_comparison_month_is_the_one_immediately_before() {
    let conn = fresh();
    let march = add_day(&conn, "2026-03-10");
    let february = add_day(&conn, "2026-02-10");
    add_sale(&conn, 1, march, 8_000_00, 4_000_00, 0);
    add_sale(&conn, 2, february, 6_000_00, 2_000_00, 0);
    spend(&conn, "SUPPLIES", 1_000_00, "2026-02-15");

    let r = report(&conn, Some("2026-03"));
    assert_eq!(r.comparison_month, "2026-02");
    assert_eq!(r.comparison, MonthlyComparison::PreviousMonth);
    assert_eq!(r.comparison_figures.revenue_minor, 8_000_00);
    assert_eq!(r.comparison_figures.expenses_minor, 1_000_00);
    assert_eq!(r.comparison_figures.net_minor, 7_000_00);
}

#[test]
fn january_compares_against_december_of_the_year_before() {
    let conn = fresh();
    assert_eq!(
        crate::time::previous_business_month("2026-01").as_deref(),
        Some("2025-12")
    );
    assert_eq!(
        crate::time::previous_business_month("2026-03").as_deref(),
        Some("2026-02")
    );
    // A month that does not exist has no month before it.
    assert_eq!(crate::time::previous_business_month("2026-13"), None);
    assert_eq!(crate::time::previous_business_month("nonsense"), None);

    let r = report(&conn, Some("2026-01"));
    assert_eq!(r.comparison_month, "2025-12");
}

// ---------------------------------------------------------------------------
// same month, previous year
// ---------------------------------------------------------------------------

#[test]
fn the_same_month_a_year_earlier_keeps_the_month_and_steps_the_year() {
    for (month, expected) in [
        ("2026-01", "2025-01"),
        ("2026-02", "2025-02"),
        ("2026-10", "2025-10"),
        ("2025-03", "2024-03"),
        ("2026-12", "2025-12"),
    ] {
        assert_eq!(
            crate::time::same_month_previous_year(month).as_deref(),
            Some(expected)
        );
    }
    // A month that does not exist has no year-earlier self.
    assert_eq!(crate::time::same_month_previous_year("2026-13"), None);
    assert_eq!(crate::time::same_month_previous_year("nonsense"), None);
}

/// The month the caller CHOSE decides the comparison year — a report about a
/// historical month never asks the system clock what year it is now.
#[test]
fn the_previous_year_comes_from_the_selected_month_not_from_today() {
    let conn = fresh();
    let r = report_comparison(
        &conn,
        Some("2026-01"),
        MonthlyComparison::SameMonthPreviousYear,
    );

    assert_eq!(r.month, "2026-01");
    assert_eq!(r.comparison, MonthlyComparison::SameMonthPreviousYear);
    assert_eq!(r.comparison_month, "2025-01");
    // Both periods carry the SAME month, so January is never December.
    assert_eq!(&r.comparison_month[5..], "01");
}

/// Each year keeps its own calendar length: February 2024 is bounded by its
/// 29 days and February 2023 by its 28, rather than one being stretched.
#[test]
fn february_uses_each_years_own_calendar_bounds() {
    let conn = fresh();
    // The leap day exists only in 2024; the comparison must read 2023 instead.
    let leap_day = add_day(&conn, "2024-02-29");
    let feb_2023 = add_day(&conn, "2023-02-14");
    add_sale(&conn, 1, leap_day, 1_000_00, 0, 0);
    add_sale(&conn, 2, feb_2023, 2_500_00, 0, 0);

    let r = report_comparison(
        &conn,
        Some("2024-02"),
        MonthlyComparison::SameMonthPreviousYear,
    );
    assert_eq!(r.comparison_month, "2023-02");
    // The reported month ends on the 29th; the comparison month on the 28th.
    assert_eq!(r.to, "2024-02-29");
    assert_eq!(r.comparison_figures.revenue_minor, 2_500_00);
    assert_eq!(r.money.revenue_minor, 1_000_00);
}

/// The two modes are the SAME aggregation over two different periods, so the
/// reported month's own figures never change when the mode does.
#[test]
fn switching_mode_changes_only_the_comparison_period() {
    let conn = fresh();
    let jan_2026 = add_day(&conn, "2026-01-15");
    let dec_2025 = add_day(&conn, "2025-12-15");
    let jan_2025 = add_day(&conn, "2025-01-15");
    add_sale(&conn, 1, jan_2026, 10_000_00, 0, 0);
    add_sale(&conn, 2, dec_2025, 6_000_00, 0, 0);
    add_sale(&conn, 3, jan_2025, 4_000_00, 0, 0);

    let previous = report_comparison(&conn, Some("2026-01"), MonthlyComparison::PreviousMonth);
    let year = report_comparison(
        &conn,
        Some("2026-01"),
        MonthlyComparison::SameMonthPreviousYear,
    );

    assert_eq!(previous.month, year.month);
    // The reported month's own figures are the mode-independent ones: comparing
    // a different period must not move a single figure of the month itself.
    assert_eq!(previous.money.revenue_minor, year.money.revenue_minor);
    assert_eq!(previous.money.expenses_minor, year.money.expenses_minor);
    assert_eq!(previous.money.net_minor, year.money.net_minor);
    assert_eq!(previous.comparison_month, "2025-12");
    assert_eq!(year.comparison_month, "2025-01");
    assert_eq!(previous.comparison_figures.revenue_minor, 6_000_00);
    assert_eq!(year.comparison_figures.revenue_minor, 4_000_00);
}

/// A month that never traded reads as zeroes rather than failing — a quiet
/// historical month is a fact, not an error, and it is never fabricated into
/// activity that did not happen. The mode changes nothing about that rule.
#[test]
fn an_empty_historical_month_reads_as_zeroes_rather_than_failing() {
    let conn = fresh();
    let sep_2026 = add_day(&conn, "2026-09-10");
    add_sale(&conn, 1, sep_2026, 5_000_00, 0, 0);

    let year = report_comparison(
        &conn,
        Some("2026-09"),
        MonthlyComparison::SameMonthPreviousYear,
    );
    assert_eq!(year.comparison_month, "2025-09");
    assert_eq!(year.comparison_figures.revenue_minor, 0);
    assert_eq!(year.comparison_figures.expenses_minor, 0);
    assert_eq!(year.comparison_figures.net_minor, 0);
    // The reported month still reports itself: an empty comparison is not an
    // empty report.
    assert_eq!(year.money.revenue_minor, 5_000_00);
}

// ---------------------------------------------------------------------------
// time
// ---------------------------------------------------------------------------

#[test]
fn the_period_is_the_business_month_and_stops_at_today_while_it_is_running() {
    let conn = fresh();
    let today = crate::time::current_business_month();
    let r = report(&conn, Some(&today));

    assert_eq!(r.month, today);
    let (first, last) = crate::time::business_month_bounds(&today).unwrap();
    assert_eq!(r.from, first);
    // The read never runs past the day that has actually happened.
    assert!(r.to <= last);
    assert!(r.to <= crate::time::today_business_date());
}

#[test]
fn an_absent_month_answers_for_the_current_business_month() {
    let conn = fresh();
    let r = report(&conn, None);
    assert_eq!(r.month, crate::time::current_business_month());
}

#[test]
fn a_month_that_is_not_a_real_month_is_refused() {
    let conn = fresh();
    let error = reports::monthly_executive(
        &conn,
        &actor(&conn, "manager"),
        Some("2026-13"),
        MonthlyComparison::PreviousMonth,
    )
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "validation error: settings.invalid_month"
    );
}

// ---------------------------------------------------------------------------
// authorization
// ---------------------------------------------------------------------------

#[test]
fn the_report_is_a_management_read_and_a_cashier_is_refused() {
    let conn = fresh();
    assert!(reports::monthly_executive(
        &conn,
        &actor(&conn, "cashier"),
        Some("2026-03"),
        MonthlyComparison::PreviousMonth
    )
    .is_err());
    assert!(reports::monthly_executive(
        &conn,
        &actor(&conn, "manager"),
        Some("2026-03"),
        MonthlyComparison::PreviousMonth
    )
    .is_ok());
}

/// Reading the report resolves targets and must never WRITE one.
#[test]
fn reading_the_report_never_writes_a_target_override() {
    let conn = fresh();
    report(&conn, Some("2026-03"));
    let resolved =
        settings::resolve_monthly_target(&conn, "2026-03", RevenueDepartment::Cafe).unwrap();
    assert!(!resolved.overridden);
    assert_eq!(resolved.target_minor, 0);
}

/// An empty historical month is a quiet month, not an error: the same zeroes
/// every other empty period already reports, and never a fabricated figure.
#[test]
fn an_empty_previous_year_reads_as_zeroes_rather_than_failing() {
    let conn = fresh();
    let jan_2026 = add_day(&conn, "2026-01-15");
    add_sale(&conn, 1, jan_2026, 9_000_00, 0, 0);

    let r = report_comparison(
        &conn,
        Some("2026-01"),
        MonthlyComparison::SameMonthPreviousYear,
    );
    assert_eq!(r.comparison_month, "2025-01");
    assert_eq!(r.comparison_figures.revenue_minor, 0);
    assert_eq!(r.comparison_figures.expenses_minor, 0);
    assert_eq!(r.comparison_figures.net_minor, 0);
}

/// The mode is the report's ONE statement of what the comparison is: it travels
/// on the payload, so a UI can never label the period wrongly.
#[test]
fn an_absent_mode_is_the_previous_month() {
    let conn = fresh();
    let r = report(&conn, Some("2026-03"));
    assert_eq!(r.comparison, MonthlyComparison::PreviousMonth);
    assert_eq!(
        MonthlyComparison::default(),
        MonthlyComparison::PreviousMonth,
        "the default must stay the original comparison"
    );
}

/// The wire form is the one the UI sends and reads, and a bad one is refused
/// rather than silently falling back to the previous month.
#[test]
fn the_comparison_mode_round_trips_through_its_wire_form() {
    let previous: MonthlyComparison =
        serde_json::from_str("\"PREVIOUS_MONTH\"").expect("previous month");
    let year: MonthlyComparison =
        serde_json::from_str("\"SAME_MONTH_PREVIOUS_YEAR\"").expect("same month previous year");
    assert_eq!(previous, MonthlyComparison::PreviousMonth);
    assert_eq!(year, MonthlyComparison::SameMonthPreviousYear);
    assert_eq!(
        serde_json::to_value(year).unwrap(),
        serde_json::json!("SAME_MONTH_PREVIOUS_YEAR")
    );
    assert!(serde_json::from_str::<MonthlyComparison>("\"LAST_WEEK\"").is_err());
}

/// The comparison figures are the comparison period's own persisted data, so no
/// month outside the resolved range leaks into them.
#[test]
fn the_comparison_figures_are_the_periods_real_persisted_data() {
    let conn = fresh();
    let feb_2026 = add_day(&conn, "2026-02-10");
    let feb_2025 = add_day(&conn, "2025-02-10");
    add_sale(&conn, 1, feb_2026, 6_000_00, 2_000_00, 0);
    add_sale(&conn, 2, feb_2025, 5_000_00, 1_000_00, 0);
    // A February 2026 expense: the previous-year read must never see it.
    spend(&conn, "SUPPLIES", 2_000_00, "2026-02-20");

    let year = report_comparison(
        &conn,
        Some("2026-02"),
        MonthlyComparison::SameMonthPreviousYear,
    );
    assert_eq!(year.comparison_month, "2025-02");
    // February 2025's own revenue, with no expenses of its own.
    assert_eq!(year.comparison_figures.revenue_minor, 6_000_00);
    assert_eq!(year.comparison_figures.expenses_minor, 0);
    assert_eq!(year.comparison_figures.net_minor, 6_000_00);
}
