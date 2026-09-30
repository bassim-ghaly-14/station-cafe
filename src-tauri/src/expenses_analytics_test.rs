//! Expenses analytics tests — period filtering, category and daily aggregation,
//! empty periods and zero-value rows.
//!
//! Everything runs against a migrated in-memory SQLite file, so the suite
//! exercises the real schema and the real grouped SQL. There is no network in
//! this file, by construction: the only I/O is the in-memory database.

use crate::db::migrate;
use crate::repositories::expenses::{self, ExpenseMonthRow, ExpenseOverview};
use crate::demo_data::seed_for_development as run_if_empty;
use rusqlite::Connection;

/// Migrated + seeded in-memory database.
fn fresh() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    run_if_empty(&conn).unwrap();
    conn
}

/// One expense row, written through the repository so the test exercises the
/// real schema rather than a hand-rolled insert.
fn spend(conn: &Connection, category: &str, amount: i64, date: &str, cash: bool, recurring: bool) {
    expenses::insert(
        conn,
        category,
        amount,
        None,
        date,
        recurring,
        if recurring { Some("MONTHLY") } else { None },
        None,
        None,
        cash,
        1,
    )
    .unwrap();
}

fn overview(conn: &Connection, from: Option<&str>, to: Option<&str>) -> ExpenseOverview {
    expenses::overview(conn, from, to).unwrap()
}

fn category_code(o: &ExpenseOverview, index: usize) -> String {
    o.categories[index].category.clone()
}

#[test]
fn an_empty_period_reports_zeroes_and_no_categories() {
    let conn = fresh();
    let o = overview(&conn, Some("2026-01-01"), Some("2026-01-31"));

    // The schema CHECKs `amount > 0`, so a stored expense can never be zero:
    // "a total of zero" is reachable only as an EMPTY period, and that must be
    // a clean zeroed payload — never a division by zero, never an error.
    assert_eq!(o.total_amount, 0);
    assert_eq!(o.expenses_count, 0);
    assert_eq!(o.cash_amount, 0);
    assert_eq!(o.cash_count, 0);
    assert_eq!(o.recurring_amount, 0);
    assert_eq!(o.recurring_count, 0);
    assert_eq!(o.largest_amount, 0);
    assert_eq!(o.average_amount, 0);
    assert!(o.categories.is_empty());
    assert!(o.days.is_empty());
}

#[test]
fn the_period_total_is_an_aggregate_not_a_sum_of_the_page() {
    let conn = fresh();
    for day in ["2026-03-01", "2026-03-02", "2026-03-03"] {
        spend(&conn, "SUPPLIES", 1_000, day, true, false);
    }
    let o = overview(&conn, Some("2026-03-01"), Some("2026-03-31"));

    assert_eq!(o.total_amount, 3_000);
    assert_eq!(o.expenses_count, 3);
    assert_eq!(o.cash_amount, 3_000);
    assert_eq!(o.cash_count, 3);
    assert_eq!(o.average_amount, 1_000);
    assert_eq!(o.largest_amount, 1_000);
    // The same figure the plain `total` read returns for the same window, so the
    // KPI band and the legacy total can never disagree.
    assert_eq!(
        o.total_amount,
        expenses::total(&conn, Some("2026-03-01"), Some("2026-03-31"), false).unwrap()
    );
}

#[test]
fn expenses_outside_the_period_are_excluded_from_every_section() {
    let conn = fresh();
    spend(&conn, "SUPPLIES", 5_000, "2026-02-28", true, false);
    spend(&conn, "SUPPLIES", 7_000, "2026-03-15", true, false);
    spend(&conn, "SUPPLIES", 9_000, "2026-04-01", true, false);

    let o = overview(&conn, Some("2026-03-01"), Some("2026-03-31"));
    assert_eq!(o.total_amount, 7_000);
    assert_eq!(o.expenses_count, 1);
    // The trend and the ranking are built from the SAME filter as the KPIs.
    assert_eq!(o.days.len(), 1);
    assert_eq!(o.days[0].day_date, "2026-03-15");
    assert_eq!(o.categories.len(), 1);
    assert_eq!(o.categories[0].amount, 7_000);
}

#[test]
fn an_unbounded_period_matches_the_whole_table() {
    let conn = fresh();
    spend(&conn, "SUPPLIES", 1_500, "2025-12-31", true, false);
    spend(&conn, "SALARY", 30_000, "2026-03-01", false, true);

    let o = overview(&conn, None, None);
    assert_eq!(o.total_amount, 31_500);
    assert_eq!(o.expenses_count, 2);
    assert_eq!(o.days.len(), 2);
}

#[test]
fn the_category_ranking_aggregates_by_category_with_resolved_arabic_labels() {
    let conn = fresh();
    spend(&conn, "SUPPLIES", 1_000, "2026-03-01", true, false);
    spend(&conn, "SUPPLIES", 2_000, "2026-03-02", true, false);
    spend(&conn, "SALARY", 10_000, "2026-03-01", false, true);

    let o = overview(&conn, Some("2026-03-01"), Some("2026-03-31"));
    assert_eq!(o.categories.len(), 2);
    // Largest amount first — the ranking is the report's ranking.
    assert_eq!(category_code(&o, 0), "SALARY");
    assert_eq!(o.categories[0].amount, 10_000);
    assert_eq!(o.categories[0].count, 1);
    assert_eq!(o.categories[0].share, 76); // 10_000 / 13_000
    assert_eq!(category_code(&o, 1), "SUPPLIES");
    assert_eq!(o.categories[1].amount, 3_000);
    assert_eq!(o.categories[1].count, 2);
    assert_eq!(o.categories[1].share, 23);

    // The label is read from the category TABLE, never hardcoded in the query,
    // so a rename in the database renames the chart with it.
    let expected = expenses::category_name(&conn, "SALARY").unwrap();
    assert_eq!(o.categories[0].category_name, expected);
    assert!(!expected.is_empty());
}

#[test]
fn cash_and_recurring_are_independent_subsets_of_the_total() {
    let conn = fresh();
    spend(&conn, "SUPPLIES", 4_000, "2026-03-01", true, false);
    // A row that is BOTH a drawer payment and a repeating commitment, so the two
    // slices genuinely overlap instead of merely being disjoint.
    spend(&conn, "SALARY", 20_000, "2026-03-01", true, true);

    let o = overview(&conn, Some("2026-03-01"), Some("2026-03-31"));
    assert_eq!(o.total_amount, 24_000);
    assert_eq!(o.cash_amount, 24_000);
    assert_eq!(o.cash_count, 2);
    assert_eq!(o.recurring_amount, 20_000);
    assert_eq!(o.recurring_count, 1);
    // They are independent slices, NOT a decomposition of the total: adding them
    // double-counts the overlapping row, which is exactly why the page presents
    // them as two separate readings and never as a split of the headline.
    assert!(o.cash_amount + o.recurring_amount > o.total_amount);
}

#[test]
fn the_daily_trend_is_ordered_oldest_first_for_the_time_axis() {
    let conn = fresh();
    spend(&conn, "SUPPLIES", 1_000, "2026-03-09", true, false);
    spend(&conn, "SUPPLIES", 2_000, "2026-03-01", true, false);
    spend(&conn, "SUPPLIES", 3_000, "2026-03-01", true, false);

    let o = overview(&conn, Some("2026-03-01"), Some("2026-03-31"));
    let days: Vec<&str> = o.days.iter().map(|d| d.day_date.as_str()).collect();
    assert_eq!(days, vec!["2026-03-01", "2026-03-09"]);
    assert_eq!(o.days[0].count, 2);
    assert_eq!(o.days[0].amount, 5_000);
    assert_eq!(o.days[1].count, 1);
    assert_eq!(o.days[1].amount, 1_000);
}

// ---- monthly comparison ----------------------------------------------------
//
// The monthly report is a CALENDAR series over the Dev Settings window, not a
// slice of the page's date range, so these tests drive it with an explicit
// `from`/`to` and prove the aggregation rules the chart depends on: year-aware
// month keys, one cell per month × category, quiet months kept as zero, and
// series derived from the categories the domain actually has spend for.

/// One business day, the month spine the monthly report is built on.
fn open_day(conn: &Connection, date: &str) {
    conn.execute(
        "INSERT INTO business_days (day_date, opened_at, status, opened_by)
         VALUES (?1, datetime('now'), 'CLOSED', 1)",
        [date],
    )
    .unwrap();
}

fn monthly(conn: &Connection, from: &str, to: &str) -> Vec<ExpenseMonthRow> {
    expenses::monthly(conn, from, to).unwrap()
}

#[test]
fn monthly_aggregates_by_calendar_month_and_by_category() {
    let conn = fresh();
    open_day(&conn, "2026-01-10");
    open_day(&conn, "2026-01-25");
    open_day(&conn, "2026-02-10");

    // Two January spends of DIFFERENT categories, plus one of the first.
    spend(&conn, "SALARY", 10_000, "2026-01-10", false, true);
    spend(&conn, "SUPPLIES", 4_000, "2026-01-25", true, false);
    spend(&conn, "SALARY", 12_000, "2026-02-10", false, true);

    let rows = monthly(&conn, "2026-01-01", "2026-02-28");

    // One cell per month × category, not one row per expense.
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].month, "2026-01");
    assert_eq!(rows[0].category, "SALARY");
    assert_eq!(rows[0].amount, 10_000);
    assert_eq!(rows[0].count, 1);
    // The Arabic label is resolved from the category table, never hardcoded.
    assert_eq!(rows[0].category_name, "رواتب");
    assert_eq!(rows[1].category, "SUPPLIES");
    assert_eq!(rows[1].category_name, "مشتريات");
    assert_eq!(rows[1].amount, 4_000);
    assert_eq!(rows[2].month, "2026-02");
    assert_eq!(rows[2].amount, 12_000);
}

#[test]
fn monthly_sums_repeated_spend_inside_one_month_and_category() {
    let conn = fresh();
    open_day(&conn, "2026-03-01");
    open_day(&conn, "2026-03-05");
    open_day(&conn, "2026-03-20");

    spend(&conn, "SUPPLIES", 1_000, "2026-03-01", true, false);
    spend(&conn, "SUPPLIES", 2_000, "2026-03-05", true, false);
    spend(&conn, "SUPPLIES", 3_000, "2026-03-20", true, false);

    let rows = monthly(&conn, "2026-03-01", "2026-03-31");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].amount, 6_000);
    assert_eq!(rows[0].count, 3);
}

#[test]
fn monthly_keeps_the_same_month_of_two_years_in_two_buckets() {
    let conn = fresh();
    open_day(&conn, "2025-01-15");
    open_day(&conn, "2026-01-15");

    spend(&conn, "SALARY", 3_000, "2025-01-15", false, true);
    spend(&conn, "SALARY", 7_000, "2026-01-15", false, true);

    let rows = monthly(&conn, "2025-01-01", "2026-01-31");

    // Grouping by a display name would have produced one "يناير" of 10,000.
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].month, "2025-01");
    assert_eq!(rows[0].amount, 3_000);
    assert_eq!(rows[1].month, "2026-01");
    assert_eq!(rows[1].amount, 7_000);
    // Ascending by the stable key, so the latest month is always the last row.
    assert!(rows[0].month < rows[1].month);
}

#[test]
fn a_month_with_a_business_day_but_no_spend_stays_a_zero_month() {
    let conn = fresh();
    // January is a trading month with no expense at all: a quiet month, not a gap.
    open_day(&conn, "2026-01-10");
    open_day(&conn, "2026-02-10");
    spend(&conn, "SUPPLIES", 4_000, "2026-02-10", true, false);

    let rows = monthly(&conn, "2026-01-01", "2026-02-28");

    assert_eq!(
        rows.len(),
        2,
        "a quiet month must not vanish from the series"
    );
    assert_eq!(rows[0].month, "2026-01");
    assert_eq!(rows[0].amount, 0);
    assert_eq!(rows[0].count, 0);
    // The marker row carries no category, so it can never become a series.
    assert_eq!(rows[0].category, "");
    assert_eq!(rows[1].amount, 4_000);
}

#[test]
fn a_month_with_no_business_day_is_not_a_month_of_the_series() {
    let conn = fresh();
    open_day(&conn, "2026-02-10");
    spend(&conn, "SUPPLIES", 4_000, "2026-02-10", true, false);

    let rows = monthly(&conn, "2026-01-01", "2026-03-31");

    // A month the cafe never traded in is not a month with zero spend.
    let months: Vec<&str> = rows.iter().map(|r| r.month.as_str()).collect();
    assert_eq!(months, vec!["2026-02"]);
}

#[test]
fn monthly_excludes_spend_outside_the_window() {
    let conn = fresh();
    open_day(&conn, "2026-02-28");
    open_day(&conn, "2026-03-10");
    open_day(&conn, "2026-04-01");

    spend(&conn, "SUPPLIES", 5_000, "2026-02-28", true, false);
    spend(&conn, "SUPPLIES", 7_000, "2026-03-10", true, false);
    spend(&conn, "SUPPLIES", 9_000, "2026-04-01", true, false);

    let rows = monthly(&conn, "2026-03-01", "2026-03-31");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].month, "2026-03");
    assert_eq!(rows[0].amount, 7_000);
}

#[test]
fn the_monthly_series_are_the_categories_that_actually_carried_spend() {
    let conn = fresh();
    open_day(&conn, "2026-01-10");
    open_day(&conn, "2026-02-10");

    spend(&conn, "SALARY", 10_000, "2026-01-10", false, true);
    spend(&conn, "SALARY", 20_000, "2026-02-10", false, true);
    spend(&conn, "SUPPLIES", 5_000, "2026-02-10", true, false);

    let report = expenses::monthly_report(&conn, "2026-01-01", "2026-02-28").unwrap();

    // Largest total first, so the busiest category leads the chart.
    assert_eq!(report.categories.len(), 2);
    assert_eq!(report.categories[0].code, "SALARY");
    assert_eq!(report.categories[0].name_ar, "رواتب");
    assert_eq!(report.categories[0].total, 30_000);
    assert_eq!(report.categories[1].code, "SUPPLIES");
    assert_eq!(report.categories[1].total, 5_000);
    // The report's own total must equal the sum of every category cell.
    let summed: i64 = report.months.iter().map(|row| row.amount).sum();
    assert_eq!(summed, 35_000);
}

#[test]
fn the_monthly_series_omit_a_category_with_no_spend_in_the_window() {
    let conn = fresh();
    open_day(&conn, "2026-01-10");
    spend(&conn, "SUPPLIES", 1_000, "2026-01-10", true, false);

    let report = expenses::monthly_report(&conn, "2026-01-01", "2026-01-31").unwrap();

    // The seeded domain has more categories than this window used; plotting a
    // flat zero bar for each of them would say nothing.
    assert_eq!(report.categories.len(), 1);
    assert_eq!(report.categories[0].code, "SUPPLIES");
}

#[test]
fn a_monthly_window_with_no_spend_reports_no_series_and_no_rows() {
    let conn = fresh();
    open_day(&conn, "2026-01-10");

    let report = expenses::monthly_report(&conn, "2026-01-01", "2026-01-31").unwrap();

    // The month is present as a zero marker so the axis keeps its shape, but it
    // contributes no series and no value.
    assert_eq!(report.categories.len(), 0);
    assert_eq!(report.months.len(), 1);
    assert_eq!(report.months[0].month, "2026-01");
    assert_eq!(report.months[0].amount, 0);
}
