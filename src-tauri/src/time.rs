//! Canonical time model for Station.
//!
//! Station is an offline single-machine POS, so the only clock is the operating
//! system clock (`SystemTime`). This module is the ONE place that reads it, and
//! the one place that knows Station's business timezone.
//!
//! # The three distinct concepts (never interchangeable)
//!
//! 1. **Instant** — a point on the timeline. Stored and transported as an
//!    explicit UTC instant: `2026-09-25 14:30:00Z`. Unambiguous, and sorts and
//!    compares correctly as text.
//! 2. **Business date** — a calendar day in Station's business timezone
//!    (`Africa/Cairo`), as a plain `YYYY-MM-DD` string. It is NOT an instant
//!    and must never become a timestamp in transit.
//! 3. **Business-local wall clock** — the human time of day shown in the UI and
//!    printed on paper. Derived from an instant by converting it to the
//!    business timezone.
//!
//! # Why an IANA zone and not `+03:00`
//!
//! `Africa/Cairo` is used so Egypt's DST rule (EEST/EET) is honored by the tz
//! database. A hardcoded offset would silently go stale and would make 23:30 in
//! winter group into the wrong business day.
//!
//! # Storage format
//!
//! Historically timestamps were written by SQLite's `datetime('now')`, which
//! produces `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker. That value is a
//! correct instant but an ambiguous *string*. Migration 19 rewrites those
//! values to the explicit `...Z` form without changing any instant.

use chrono::{DateTime, Datelike, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;

/// Station's business timezone. The single source of truth for "what day and
/// what time is it at the café". Used by every business-date derivation.
pub const BUSINESS_TZ: Tz = chrono_tz::Africa::Cairo;

/// The business date (Station-local calendar day) of an instant.
pub fn business_date_of(instant: DateTime<Utc>) -> String {
    instant.with_timezone(&BUSINESS_TZ).date_naive().to_string()
}

/// The current instant, read from the operating system clock.
pub fn now_utc() -> DateTime<Utc> {
    Utc::now()
}

/// Today's business date in Station's timezone.
pub fn today_business_date() -> String {
    business_date_of(now_utc())
}

/// The canonical database/transport representation: an explicit UTC instant.
///
/// Deliberately keeps the `YYYY-MM-DD HH:MM:SS` shape (so existing lexical
/// comparisons keep working) and appends the `Z` that makes it unambiguously

/// The canonical database/transport representation: an explicit UTC instant.
///
/// Deliberately keeps the `YYYY-MM-DD HH:MM:SS` shape (so existing lexical
/// comparisons keep working) and appends the `Z` that makes it unambiguously
/// UTC.
pub fn to_db_timestamp(instant: DateTime<Utc>) -> String {
    instant.format("%Y-%m-%d %H:%M:%SZ").to_string()
}

/// The current instant, formatted for storage.
pub fn now_db_timestamp() -> String {
    to_db_timestamp(now_utc())
}

/// Parse any timestamp this application has ever written or may receive.
///
/// Accepts the legacy unmarked form (`2026-09-25 14:30:00`), the canonical
/// marked form, and ISO-8601 with `T` and an optional offset. A value with no
/// zone information is interpreted as UTC, which is exactly what the legacy
/// `datetime('now')` writer meant. Returns `None` for anything else rather
/// than guessing.
pub fn parse_timestamp(value: &str) -> Option<DateTime<Utc>> {
    let text = value.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(parsed) = DateTime::parse_from_rfc3339(text) {
        return Some(parsed.with_timezone(&Utc));
    }
    // Legacy / canonical SQLite shape, zone-less.
    for format in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(text, format) {
            return Some(Utc.from_utc_datetime(&naive));
        }
    }
    None
}

/// The business-local wall clock of an instant, as shown and printed.
///
/// The same shape is used everywhere in the UI and on paper, so a receipt can
/// never disagree with the screen.
pub fn format_business_datetime(instant: DateTime<Utc>) -> String {
    instant
        .with_timezone(&BUSINESS_TZ)
        .format("%Y-%m-%d %H:%M")
        .to_string()
}

/// First business date of the month `months_back` months before today.
///
/// Used by reports that state their OWN period instead of being narrowed by a
/// caller filter — the monthly sales comparison, which is a calendar series and
/// must not follow the Sales page's date picker. The arithmetic is pure
/// calendar work on a `NaiveDate`, so it never touches an instant and never
/// drifts across a DST boundary.
pub fn business_date_months_ago(months_back: i64) -> String {
    let today = now_utc().with_timezone(&BUSINESS_TZ).date_naive();
    // `month0` makes the arithmetic a plain linear index over months, so
    // December - 1 and January + 1 both cross the year boundary correctly.
    let index = today.year() as i64 * 12 + today.month0() as i64 - months_back;
    let (year, month0) = (index.div_euclid(12), index.rem_euclid(12));
    NaiveDate::from_ymd_opt(year as i32, month0 as u32 + 1, 1)
        .map(|date| date.to_string())
        .unwrap_or_default()
}

/// Format an already-stored timestamp for display/print, in business time.
pub fn to_business_datetime(value: &str) -> String {
    match parse_timestamp(value) {
        Some(instant) => format_business_datetime(instant),
        None => value.to_string(),
    }
}

/// Start of a business day (local midnight) as a UTC instant.
///
/// Egypt's DST transition happens *at midnight*, so on the spring-forward day
/// local `00:00` does not exist at all. Resolving midnight alone would make
/// that entire business day unrangable, so when midnight is skipped we step
/// forward to the first wall clock that actually exists. That instant is the
/// true start of the business day — nothing local can precede it.
pub fn business_day_start(day: &str) -> Option<DateTime<Utc>> {
    let date = NaiveDate::parse_from_str(day.trim(), "%Y-%m-%d").ok()?;
    let midnight = date.and_hms_opt(0, 0, 0)?;
    match BUSINESS_TZ.from_local_datetime(&midnight) {
        // Fall-back day: midnight happens twice. The earlier one is the start.
        LocalResult::Single(local) => return Some(local.with_timezone(&Utc)),
        LocalResult::Ambiguous(earliest, _) => return Some(earliest.with_timezone(&Utc)),
        // Spring-forward day: 00:00 is skipped, so use the first real moment.
        LocalResult::None => {}
    }
    (1..=180)
        .map(|minutes| midnight + chrono::Duration::minutes(minutes))
        .find_map(|candidate| BUSINESS_TZ.from_local_datetime(&candidate).earliest())
        .map(|local| local.with_timezone(&Utc))
}

/// A half-open business-day range `[start, end)` in canonical UTC instants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BusinessDayRange {
    /// Inclusive lower bound, canonical UTC instant.
    pub start_inclusive: String,
    /// Exclusive upper bound, canonical UTC instant.
    pub end_exclusive: String,
}

/// The half-open UTC range covering one Station business day.
pub fn business_day_range(day: &str) -> Option<BusinessDayRange> {
    let start = business_day_start(day)?;
    // Add one *calendar* day in the business timezone, not 24 hours, so a DST
    // transition inside the day still yields the correct next local midnight.
    let next_day = start.with_timezone(&BUSINESS_TZ).date_naive().succ_opt()?;
    Some(BusinessDayRange {
        start_inclusive: to_db_timestamp(start),
        // Reuse the same total resolution, so a day whose midnight is skipped
        // still ends at the next day's real first instant.
        end_exclusive: to_db_timestamp(business_day_start(&next_day.to_string())?),
    })
}

/// A business-date filter resolved to canonical UTC instants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BusinessDateSpan {
    /// Inclusive lower bound. Empty string means "unbounded".
    pub start_inclusive: String,
    /// Exclusive upper bound. `None` means "unbounded".
    pub end_exclusive: Option<String>,
}

/// The half-open UTC range covering an inclusive span of business dates.
///
/// `from` is the first business day and `to` the last (both inclusive), so a
/// `25/09/2026 → 25/09/2026` filter resolves to the complete Egyptian day
/// rather than a zero-width UTC instant. Returns `None` if a supplied bound is
/// not a valid business date.
pub fn business_date_span(from: Option<&str>, to: Option<&str>) -> Option<BusinessDateSpan> {
    let start = match from.map(str::trim).filter(|v| !v.is_empty()) {
        Some(day) => business_day_range(day)?.start_inclusive,
        None => String::new(),
    };
    let end_exclusive = match to.map(str::trim).filter(|v| !v.is_empty()) {
        // `business_day_range` already ends on the next day's true first
        // instant, which is exactly the exclusive bound we need.
        Some(day) => Some(business_day_range(day)?.end_exclusive),
        None => None,
    };
    Some(BusinessDateSpan {
        start_inclusive: start,
        end_exclusive,
    })
}

/// `datetime(x)` applied to the business timezone, for use inside SQL.
///
/// Generated from the single `BUSINESS_TZ` constant, so grouping by day in a
/// report is always Station-local, never UTC.
pub fn sql_business_datetime(column: &str) -> String {
    format!("datetime({}, '{}')", column, BUSINESS_TZ.name())
}

/// The business date of a column as SQL, for `GROUP BY`.
pub fn sql_business_date(column: &str) -> String {
    format!("date({}, '{}')", column, BUSINESS_TZ.name())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a UTC instant from explicit components.
    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, s).unwrap()
    }

    #[test]
    fn a_month_offset_lands_on_the_first_day_of_that_month() {
        // Offset zero is the month the café is in right now, and every offset is
        // the FIRST day of a month, so a monthly report can bound itself with it.
        let current = business_date_months_ago(0);
        assert!(current.ends_with("-01"));
        assert_eq!(
            current[..7],
            today_business_date()[..7],
            "offset zero must be the current business month"
        );

        // Consecutive offsets step back exactly one calendar month, in order.
        let mut previous = current;
        for back in 1..=14 {
            let value = business_date_months_ago(back);
            assert!(
                value.ends_with("-01"),
                "{value} is not a first day of a month"
            );
            assert!(
                value < previous,
                "offset {back} ({value}) did not step back from {previous}"
            );
            previous = value;
        }
    }

    #[test]
    fn a_month_offset_ignores_the_day_of_the_month() {
        // Two offsets one year apart land in the same month NUMBER of the
        // neighbouring years — the year boundary is carried, not dropped.
        let this_month = business_date_months_ago(0);
        let last_year = business_date_months_ago(12);
        assert_eq!(this_month[5..7], last_year[5..7]);
        assert_ne!(this_month[..4], last_year[..4]);
    }

    #[test]
    fn a_month_offset_is_a_business_date_not_an_instant() {
        let value = business_date_months_ago(3);
        assert_eq!(value.len(), 10);
        assert!(!value.contains('T') && !value.ends_with('Z'));
        assert!(parse_timestamp(&format!("{value} 12:00:00")).is_some());
    }

    #[test]
    fn canonical_storage_is_explicit_utc() {
        assert_eq!(
            to_db_timestamp(utc(2026, 9, 25, 14, 30, 0)),
            "2026-09-25 14:30:00Z"
        );
    }

    #[test]
    fn parsing_is_backward_compatible_and_unambiguous() {
        // The legacy unmarked form must keep meaning the same instant.
        let legacy = parse_timestamp("2026-09-25 14:30:00").unwrap();
        assert_eq!(legacy, parse_timestamp("2026-09-25 14:30:00Z").unwrap());
        assert_eq!(legacy, parse_timestamp("2026-09-25T14:30:00Z").unwrap());
        // An explicit offset is honored, not assumed to be UTC.
        assert_eq!(
            legacy,
            parse_timestamp("2026-09-25T17:30:00+03:00").unwrap()
        );
        assert!(parse_timestamp("").is_none());
        assert!(parse_timestamp("not a date").is_none());
    }

    #[test]
    fn egypt_summer_time_renders_three_hours_ahead_of_utc() {
        // Cairo is UTC+3 in September (EEST).
        let instant = utc(2026, 9, 25, 14, 30, 0);
        assert_eq!(format_business_datetime(instant), "2026-09-25 17:30");
    }

    #[test]
    fn egypt_winter_time_renders_two_hours_ahead_of_utc() {
        // Cairo is UTC+2 in January (EET) — a hardcoded +03:00 would be wrong.
        let instant = utc(2026, 1, 15, 14, 30, 0);
        assert_eq!(format_business_datetime(instant), "2026-01-15 16:30");
    }

    #[test]
    fn business_date_follows_cairo_not_utc() {
        // 21:30 UTC is already the next calendar day in Cairo, so a 23:30
        // Cairo transaction must be filed under the 26th, not the 25th.
        assert_eq!(business_date_of(utc(2026, 9, 25, 21, 30, 0)), "2026-09-26");
        // 20:30 UTC is 23:30 Cairo on the same day.
        assert_eq!(business_date_of(utc(2026, 9, 25, 20, 30, 0)), "2026-09-25");
        // Just after local midnight on the 25th.
        assert_eq!(business_date_of(utc(2026, 9, 24, 21, 30, 0)), "2026-09-25");
    }

    #[test]
    fn day_range_is_half_open_and_covers_the_whole_local_day() {
        let range = business_day_range("2026-09-25").unwrap();
        // 2026-09-25 is EEST (UTC+3), so Cairo midnight is 21:00 UTC on the
        // 24th. Verified against the tz database, not a hardcoded offset.
        assert_eq!(range.start_inclusive, "2026-09-24 21:00:00Z");
        assert_eq!(range.end_exclusive, "2026-09-25 21:00:00Z");
    }

    #[test]
    fn day_range_is_half_open_in_winter_when_egypt_is_on_eet() {
        // In January Cairo is UTC+2, so the same wall-clock day starts an hour
        // later in UTC. A hardcoded +03:00 would break this.
        let range = business_day_range("2026-01-15").unwrap();
        assert_eq!(range.start_inclusive, "2026-01-14 22:00:00Z");
        assert_eq!(range.end_exclusive, "2026-01-15 22:00:00Z");
    }

    #[test]
    fn day_range_includes_the_last_second_of_the_business_day() {
        let range = business_day_range("2026-09-25").unwrap();
        let start = parse_timestamp(&range.start_inclusive).unwrap();
        let end = parse_timestamp(&range.end_exclusive).unwrap();
        // 23:59:59 in Cairo is still inside the range.
        assert!((start..end).contains(&utc(2026, 9, 25, 20, 59, 59)));
        // The next Cairo midnight is the exclusive bound, so it is excluded.
        assert!(utc(2026, 9, 25, 21, 0, 0) >= end);
    }

    #[test]
    fn day_range_respects_dst_transitions() {
        // Egypt's clocks change AT MIDNIGHT. On 2026-04-24 local 00:00 never
        // happens, so that business day is only 23 hours long — and must still
        // be fully and correctly rangeable.
        let range = business_day_range("2026-04-24").unwrap();
        let start = parse_timestamp(&range.start_inclusive).unwrap();
        let end = parse_timestamp(&range.end_exclusive).unwrap();
        let hours = (end - start).num_hours();
        assert_eq!(hours, 23, "the spring-forward day is 23 hours long");
        // And it still begins at the first instant that really exists locally.
        assert_eq!(range.start_inclusive, "2026-04-23 22:00:00Z");
    }

    #[test]
    fn day_range_handles_the_fall_back_day() {
        // On 2026-10-29 local midnight happens twice. The earlier one is the
        // start of the business day, giving a 25-hour range.
        let range = business_day_range("2026-10-29").unwrap();
        let start = parse_timestamp(&range.start_inclusive).unwrap();
        let end = parse_timestamp(&range.end_exclusive).unwrap();
        assert_eq!((end - start).num_hours(), 25);
    }

    #[test]
    fn same_day_filter_is_not_empty() {
        // The classic bug: an inclusive range collapsed to a zero-width
        // instant. A 25th-to-25th filter must cover the whole Egyptian day.
        let range = business_day_range("2026-09-25").unwrap();
        assert!(range.start_inclusive < range.end_exclusive);
    }

    #[test]
    fn adjacent_day_ranges_tile_without_gap_or_overlap() {
        let first = business_day_range("2026-09-25").unwrap();
        let second = business_day_range("2026-09-26").unwrap();
        assert_eq!(first.end_exclusive, second.start_inclusive);
    }

    #[test]
    fn multi_day_range_spans_both_days() {
        let first =
            parse_timestamp(&business_day_range("2026-09-25").unwrap().start_inclusive).unwrap();
        let last =
            parse_timestamp(&business_day_range("2026-09-26").unwrap().end_exclusive).unwrap();
        assert!((first..last).contains(&utc(2026, 9, 25, 20, 30, 0)));
        assert!((first..last).contains(&utc(2026, 9, 25, 21, 30, 0)));
    }

    #[test]
    fn round_trip_instant_survives_storage_and_transport() {
        // The Rust side of the instant -> storage -> transport chain: the
        // instant survives formatting, storage, and re-parsing unchanged.
        let original = utc(2026, 9, 25, 14, 30, 45);
        let recovered = parse_timestamp(&to_db_timestamp(original)).unwrap();
        assert_eq!(original, recovered);
        // And what the UI shows is Cairo wall clock, not the stored digits.
        assert_eq!(format_business_datetime(recovered), "2026-09-25 17:30");
    }

    #[test]
    fn sql_grouping_uses_the_business_timezone() {
        assert_eq!(
            sql_business_date("i.created_at"),
            "date(i.created_at, 'Africa/Cairo')"
        );
        assert_eq!(
            sql_business_datetime("i.created_at"),
            "datetime(i.created_at, 'Africa/Cairo')"
        );
    }

    #[test]
    fn seconds_are_preserved_for_ordering() {
        assert!(
            to_db_timestamp(utc(2026, 9, 25, 14, 30, 1))
                < to_db_timestamp(utc(2026, 9, 25, 14, 30, 2))
        );
    }

    #[test]
    fn invalid_business_dates_are_rejected_not_guessed() {
        assert!(business_day_range("25/09/2026").is_none());
        assert!(business_day_range("2026-13-01").is_none());
        assert!(business_day_range("").is_none());
    }

    #[test]
    fn span_resolves_an_inclusive_filter_to_a_real_range() {
        // A same-day filter must be a full day wide, not a single instant.
        let span = business_date_span(Some("2026-09-25"), Some("2026-09-25")).unwrap();
        assert_eq!(span.start_inclusive, "2026-09-24 21:00:00Z");
        assert_eq!(span.end_exclusive.as_deref(), Some("2026-09-25 21:00:00Z"));
        let start = parse_timestamp(&span.start_inclusive).unwrap();
        let end = parse_timestamp(span.end_exclusive.as_deref().unwrap()).unwrap();
        assert!((start..end).contains(&utc(2026, 9, 25, 20, 59, 59)));
    }

    #[test]
    fn span_is_unbounded_when_a_bound_is_absent() {
        let open_start = business_date_span(Some("2026-09-25"), None).unwrap();
        assert_eq!(open_start.start_inclusive, "2026-09-24 21:00:00Z");
        assert_eq!(open_start.end_exclusive, None);

        let open_end = business_date_span(None, Some("2026-09-25")).unwrap();
        assert_eq!(open_end.start_inclusive, "");
        assert!(open_end.end_exclusive.is_some());

        // Empty strings mean "unset" in the UI, not "the epoch".
        let empty = business_date_span(Some(""), Some("")).unwrap();
        assert_eq!(empty.start_inclusive, "");
        assert_eq!(empty.end_exclusive, None);
    }

    #[test]
    fn span_rejects_a_malformed_bound() {
        assert!(business_date_span(Some("not-a-date"), None).is_none());
        assert!(business_date_span(None, Some("2026-02-30")).is_none());
    }
}
