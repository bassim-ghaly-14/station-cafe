//! Attendance domain — the rounding rule and the day-state algebra.
//!
//! # Where the rounding lives
//!
//! [`check_in_instant`] and [`check_out_instant`] are the ONLY two places an
//! attendance timestamp is rounded. They are deliberately pure functions of an
//! instant, with no database, no session and no wall-clock read, so they are
//! exhaustively testable and the React layer has no way to compute a different
//! answer than the service does.
//!
//! # The rule, stated once
//!
//! The two directions are NOT the same rule, and this is the whole point:
//!
//! ```text
//! CHECK-IN  (floor)   08:01 -> 08:00   08:09 -> 08:00   08:10 -> 08:10
//! CHECK-OUT (ceil)    16:01 -> 16:10   16:09 -> 16:10   16:10 -> 16:10
//! ```
//!
//! so the two invariants that matter are structural, not incidental:
//!
//! ```text
//! recorded_check_in_time  <= actual_action_time
//! recorded_check_out_time >= actual_action_time
//! ```
//!
//! A check-in is never moved into the future and a check-out is never moved
//! into the past, whatever the interval and whatever the seconds.
//!
//! # Why both timestamps exist
//!
//! `actual` is what the machine's clock said and is never rewritten; `effective`
//! is what payroll and worked-hours read. Keeping both means a rounding rule can
//! be tightened years later and the truth is still on disk.
//!
//! # The ONE exception: a manager override
//!
//! Everything above describes a NORMAL attendance action, where the machine's
//! clock is the only source of the time. A manager override is a different kind
//! of event: an administrative correction in which a human states the time the
//! punch SHOULD have read. It therefore
//!
//!   - does NOT pass through [`effective_instant`] at all (no rounding, and
//!     never a second rounding pass over an already-rounded value);
//!   - is written with the manager's instant as BOTH the actual and the
//!     effective timestamp, so the two columns can never disagree about what was
//!     stored, while the superseded row keeps the machine's original readings;
//!   - is filed against the business date it was given, so the day bucket never
//!     moves because of a wall-clock time.
//!
//! The rule is stated in exactly one place — [`override_instant`] — so no
//! override call site can accidentally acquire the automatic rounding.

use crate::error::{AppError, AppResult};
use crate::time::BUSINESS_TZ;
use chrono::{DateTime, Duration, LocalResult, NaiveDate, NaiveTime, TimeZone, Timelike, Utc};
use serde::{Deserialize, Serialize};

/// The attendance rounding step, in minutes. One grid for both directions, so a
/// check-in and a check-out always land on the same lattice.
///
/// # The hard business ceiling
///
/// Ten minutes is the ABSOLUTE maximum. An attendance record may never be
/// displaced from the real action by more than that, in either direction — it is
/// a payroll number, so a wider grid would silently pay (or bill) hours the
/// employee never worked.
///
/// The step is a `const` rather than a setting precisely so the rule cannot be
/// widened by a configuration value, a database row or a UI field. The
/// [`MAX_ROUNDING_STEP_MINUTES`] assertion below is a COMPILE-TIME guarantee: if a
/// future edit raises this past the ceiling, the crate fails to build instead of
/// shipping a coarser grid. The backend is therefore the only authority — there is
/// no frontend path that can produce a wider interval, because there is no
/// frontend path that can produce an interval at all.
pub const ROUNDING_STEP_MINUTES: i64 = 10;

/// The largest rounding interval Station will ever accept.
///
/// This exists so [`ROUNDING_STEP_MINUTES`] is bounded by the business rule and
/// not merely documented by it. A step must also be strictly positive, or the
/// grid would collapse and the two directions would both be no-ops.
pub const MAX_ROUNDING_STEP_MINUTES: i64 = 10;

/// Compile-time enforcement of the ceiling above. `const` items are evaluated
/// during compilation, so this is a build failure — not a runtime error and not a
/// silent clamp — if the interval is ever raised beyond the business limit.
const _: () = assert!(
    ROUNDING_STEP_MINUTES > 0 && ROUNDING_STEP_MINUTES <= MAX_ROUNDING_STEP_MINUTES,
    "attendance rounding must be a positive interval of at most 10 minutes"
);

/// Seconds in one grid step, precomputed because both directions use it.
const STEP_SECONDS: i64 = ROUNDING_STEP_MINUTES * 60;

/// Every attendance day state Station stores. Absence and leave are EXPLICIT
/// records — a day with no row is "nobody wrote anything down", which is a
/// different fact and is never reported as an absence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AttendanceState {
    #[serde(rename = "PRESENT")]
    Present,
    #[serde(rename = "ABSENT")]
    Absent,
    #[serde(rename = "LEAVE")]
    Leave,
}

impl AttendanceState {
    pub fn as_str(&self) -> &'static str {
        match self {
            AttendanceState::Present => "PRESENT",
            AttendanceState::Absent => "ABSENT",
            AttendanceState::Leave => "LEAVE",
        }
    }

    /// A day that carries a punch pair. Only these may hold check-in/out.
    pub fn is_present(&self) -> bool {
        matches!(self, AttendanceState::Present)
    }
}

/// Parse a stored state string. An unknown value is an error rather than a
/// silent default, so a corrupt row can never be reported as "not absent".
pub fn parse_state(value: &str) -> AppResult<AttendanceState> {
    match value {
        "PRESENT" => Ok(AttendanceState::Present),
        "ABSENT" => Ok(AttendanceState::Absent),
        "LEAVE" => Ok(AttendanceState::Leave),
        _ => Err(AppError::internal("attendance.unknown_state")),
    }
}

/// An attendance action as requested by a caller. The service resolves WHO may
/// perform it; this type carries only the business intent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AttendanceAction {
    /// Open a PRESENT day. The service stamps actual + effective.
    CheckIn,
    /// Close the open PRESENT day. The service stamps actual + effective.
    CheckOut,
    /// Record an explicit absence (no punch pair).
    Absent,
    /// Record an explicit leave (no punch pair).
    Leave,
}

/// Clamp a rounding interval to the range the business rule permits.
///
/// Station's attendance grid is a fixed `const`, so nothing in the running
/// application can pass an interval here today. This function exists so that the
/// ceiling remains enforceable at the DOMAIN layer if an interval ever does
/// become configurable (a `app_settings` row, a developer screen, a command
/// argument). It is the single place a caller-supplied value would be admitted,
/// and it can only ever return a value in `1..=10`:
///
///  - a non-positive interval would collapse the grid and make both directions
///    no-ops, so it is raised to one minute rather than producing NaN or a divide
///    by zero;
///  - anything above [`MAX_ROUNDING_STEP_MINUTES`] is CLAMPED DOWN to the
///    ceiling, so a too-coarse request degrades to the finest grid the business
///    allows instead of widening the rounding.
///
/// Clamping rather than rejecting is deliberate: the coarser grid is never the
/// safer answer, and the safe grid is always computable. The build-time
/// `const` assertion on [`ROUNDING_STEP_MINUTES`] remains the real guarantee for
/// the value actually in use.
pub fn clamp_rounding_minutes(minutes: i64) -> i64 {
    minutes.clamp(1, MAX_ROUNDING_STEP_MINUTES)
}

/// Seconds elapsed since local midnight, which is what the grid is measured in.
///
/// Computed in the BUSINESS wall clock, so the lattice is anchored to the time
/// the café actually reads rather than to a UTC minute that Cairo's offset has
/// shifted. Seconds are included deliberately: `08:09:59` is still before `08:10`.
fn local_seconds_of_day(instant: DateTime<Utc>) -> i64 {
    let local = instant.with_timezone(&BUSINESS_TZ);
    i64::from(local.hour()) * 3600 + i64::from(local.minute()) * 60 + i64::from(local.second())
}

/// The effective instant for a CHECK-IN: rounded BACKWARD onto the grid.
///
/// The invariant is one-directional and is enforced by construction — the
/// result is the grid point at or before the action, so
/// `check_in_instant(a) <= a` always holds, and only a whole number of seconds
/// is ever SUBTRACTED from the instant.
///
/// The exact grid point is a no-op, which is what lets the rule be stated
/// without a tie-break: an instant already on the lattice is never moved.
pub fn check_in_instant(actual: DateTime<Utc>) -> DateTime<Utc> {
    let back = local_seconds_of_day(actual) % STEP_SECONDS;
    // Rounding down never crosses midnight, so this is always a subtraction and
    // can never walk off the front of the day.
    actual - Duration::seconds(back)
}

/// The effective instant for a CHECK-OUT: rounded FORWARD onto the grid.
///
/// The mirror of [`check_in_instant`]: the result is the grid point at or after
/// the action, so `check_out_instant(a) >= a` always holds, and the exact grid
/// point is a no-op here too.
///
/// Rounding up past midnight (23:58 -> 00:00) rolls into the following day, which
/// is correct. The DAY key is always the business date of the ACTUAL instant,
/// never of the effective one, so the day bucket is decided before rounding and
/// a late shift is still filed under the day it actually happened.
pub fn check_out_instant(actual: DateTime<Utc>) -> DateTime<Utc> {
    let remainder = local_seconds_of_day(actual) % STEP_SECONDS;
    let forward = if remainder == 0 {
        0
    } else {
        STEP_SECONDS - remainder
    };
    actual + Duration::seconds(forward)
}

/// The effective instant for an arbitrary action, from the one place the
/// direction is decided.
///
/// Absent and leave carry no punch pair, so they have no effective timestamp;
/// they are routed to the check-in direction only so the function is total and
/// a future action can never fail to compile against it.
pub fn effective_instant(actual: DateTime<Utc>, action: AttendanceAction) -> DateTime<Utc> {
    match action {
        AttendanceAction::CheckOut => check_out_instant(actual),
        AttendanceAction::CheckIn | AttendanceAction::Absent | AttendanceAction::Leave => {
            check_in_instant(actual)
        }
    }
}

/// Validate a caller-supplied business date (`YYYY-MM-DD`).
pub fn validate_business_date(value: &str) -> AppResult<()> {
    chrono::NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| AppError::validation("attendance.invalid_date"))
}

// ---------------------------------------------------------------------------
// Manager override — an explicitly stated administrative time
// ---------------------------------------------------------------------------

/// Parse the wall clock a manager typed for an override: `HH:MM` or `HH:MM:SS`.
///
/// This is a strict, closed format on purpose. Unlike a normal punch — where the
/// UI sends an INTENT and the backend owns the clock entirely — an override
/// carries a value the backend cannot reconstruct, so it must be rejected rather
/// than guessed whenever it is not exactly one of these two shapes.
///
/// The SHAPE is checked before chrono sees the value, because chrono is lenient
/// about digit counts: it happily reads `8:0` as 08:00, and a correction form
/// that accepted `8:0` would be storing a time the manager did not type.
pub fn parse_override_time(value: &str) -> AppResult<NaiveTime> {
    let text = value.trim();
    let shaped = match text.len() {
        5 => text.as_bytes()[2] == b':',
        8 => text.as_bytes()[2] == b':' && text.as_bytes()[5] == b':',
        _ => false,
    } && text.chars().all(|c| c.is_ascii_digit() || c == ':');
    if !shaped {
        return Err(AppError::validation("attendance.invalid_time"));
    }
    for format in ["%H:%M", "%H:%M:%S"] {
        if let Ok(time) = NaiveTime::parse_from_str(text, format) {
            return Ok(time);
        }
    }
    Err(AppError::validation("attendance.invalid_time"))
}

/// The instant of a business-LOCAL wall clock on a business date.
///
/// This is the override's counterpart to [`effective_instant`], and the ONLY
/// conversion on the override path:
///
///  - it NEVER rounds. `08:07` stays `08:07` and `16:33` stays `16:33`, in both
///    directions, because an override is a correction and a correction that
///    silently moved by a grid step would be a second, invisible correction;
///  - the wall clock is read in [`BUSINESS_TZ`], the same zone the rounding grid
///    is anchored to, so a manager's `08:00` is the café's 08:00 and not a UTC
///    digit that happens to look like one;
///  - the instant is built ON the requested business date, so the day bucket can
///    never move: an override of 23:55 on `2026-09-27` is filed under
///    `2026-09-27` whatever the offset is.
///
/// Cairo skips 00:00 on the night its DST begins, so a midnight wall clock has no
/// single answer. The resolution is the one `time::business_day_start` already
/// uses — the earlier reading when the clock repeats, and the first wall clock
/// that actually exists when it is skipped — so an override is deterministic
/// rather than dependent on the machine it ran on, and the day never moves.
pub fn override_instant(business_date: &str, local: NaiveTime) -> AppResult<DateTime<Utc>> {
    let date = NaiveDate::parse_from_str(business_date.trim(), "%Y-%m-%d")
        .map_err(|_| AppError::validation("attendance.invalid_date"))?;
    let naive = date.and_time(local);
    match BUSINESS_TZ.from_local_datetime(&naive) {
        LocalResult::Single(exact) => Ok(exact.with_timezone(&Utc)),
        // Fall-back day: this wall clock happens twice. The earlier reading is the
        // start of it, so that is the one stored.
        LocalResult::Ambiguous(earliest, _) => Ok(earliest.with_timezone(&Utc)),
        // Spring-forward day: this wall clock does not exist. Step forward to the
        // first minute that does, so the stored instant is still the truth and
        // the requested business date still holds it.
        LocalResult::None => (1..=180)
            .map(|minutes| naive + Duration::minutes(minutes))
            .find_map(|candidate| BUSINESS_TZ.from_local_datetime(&candidate).earliest())
            .map(|resolved| resolved.with_timezone(&Utc))
            .ok_or_else(|| AppError::validation("attendance.invalid_time")),
    }
}

/// The ordering rule the resulting record must satisfy, stated once.
///
/// A check-out may never precede or equal its check-in. The rule is the SAME one
/// [`worked_minutes_of`] assumes and the normal check-out path enforces, applied
/// here to the pair an override produces. An open day (no check-out yet) is
/// always legal — half a day is a real state, not an error.
pub fn ensure_override_pair_allowed(
    check_in: Option<DateTime<Utc>>,
    check_out: Option<DateTime<Utc>>,
) -> AppResult<()> {
    if let (Some(start), Some(end)) = (check_in, check_out) {
        if end <= start {
            return Err(AppError::business("attendance.check_out_before_in"));
        }
    }
    Ok(())
}

/// The transition rules of the day-state algebra, expressed ONCE so the
/// attendance service and any future correction path cannot disagree.
///
/// A transition is rejected when:
///  - the employee is INACTIVE — an inactive employee has no attendance;
///  - the day already holds a punch, and the action is check-in (double);
///  - a check-out has nothing to close, or the day is already closed (double);
///  - an ABSENT/LEAVE day already exists (absence and leave never overwrite
///    anything, and never overwrite each other).
pub fn ensure_transition_allowed(
    employee_active: bool,
    current: Option<AttendanceState>,
    has_check_in: bool,
    has_check_out: bool,
    action: AttendanceAction,
) -> AppResult<()> {
    if !employee_active {
        return Err(AppError::business("attendance.employee_inactive"));
    }
    let current = match current {
        None => {
            // A brand new day: only the three "start a day" moves are legal.
            return match action {
                AttendanceAction::CheckIn | AttendanceAction::Absent | AttendanceAction::Leave => {
                    Ok(())
                }
                // There is nothing to close.
                AttendanceAction::CheckOut => Err(AppError::business("attendance.no_check_in")),
            };
        }
        Some(state) => state,
    };

    match action {
        AttendanceAction::CheckIn => Err(AppError::conflict("attendance.already_checked_in")),
        AttendanceAction::CheckOut => {
            if !has_check_in {
                return Err(AppError::business("attendance.no_check_in"));
            }
            if has_check_out {
                return Err(AppError::conflict("attendance.already_checked_out"));
            }
            Ok(())
        }
        // Absence and leave only ever describe a day that was never punched. They
        // can never overwrite a punch pair (a present day is not absent), and they
        // can never overwrite each other.
        AttendanceAction::Absent | AttendanceAction::Leave => {
            if has_check_in || has_check_out || current.is_present() {
                return Err(AppError::business("attendance.already_present"));
            }
            Err(AppError::conflict("attendance.day_already_recorded"))
        }
    }
}

/// Worked minutes for one closed day, measured between the EFFECTIVE punches.
///
/// An open day (checked in, not yet out) reports `None` rather than a running
/// total: a partial day is not a number the payroll snapshot may freeze.
pub fn worked_minutes_of(
    check_in_effective_at: Option<&str>,
    check_out_effective_at: Option<&str>,
) -> Option<i64> {
    let start = check_in_effective_at.and_then(crate::time::parse_timestamp)?;
    let end = check_out_effective_at.and_then(crate::time::parse_timestamp)?;
    // A defensive floor: the effective check-out can never precede the check-in
    // (the service rejects that), so a negative value can only be corrupt data
    // and must not become negative payroll hours.
    Some((end - start).num_minutes().max(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, TimeZone};

    /// A Cairo wall-clock instant, expressed the way the business reads it.
    fn cairo(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        let local = chrono::NaiveDate::from_ymd_opt(y, mo, d)
            .unwrap()
            .and_hms_opt(h, mi, 0)
            .unwrap();
        BUSINESS_TZ
            .from_local_datetime(&local)
            .earliest()
            .expect("the test wall clock exists in Cairo")
            .with_timezone(&Utc)
    }

    /// A Cairo wall-clock instant WITH seconds, so a boundary can be tested to
    /// the second without ever reading the machine's clock.
    fn cairo_at(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> DateTime<Utc> {
        let local = chrono::NaiveDate::from_ymd_opt(y, mo, d)
            .unwrap()
            .and_hms_opt(h, mi, s)
            .unwrap();
        BUSINESS_TZ
            .from_local_datetime(&local)
            .earliest()
            .expect("the test wall clock exists in Cairo")
            .with_timezone(&Utc)
    }

    /// The business wall clock of an instant, as `HH:MM`.
    fn hhmm(t: DateTime<Utc>) -> String {
        t.with_timezone(&BUSINESS_TZ).format("%H:%M").to_string()
    }

    // -------------------------------------------------------------- check-in

    #[test]
    fn a_check_in_rounds_back_onto_the_grid() {
        // Every case the specification names, in order. The expectation is the
        // grid point at or BEFORE the action, never after it.
        for (minute, expected) in [
            (0_u32, "08:00"),
            (1, "08:00"),
            (5, "08:00"),
            (9, "08:00"),
            (10, "08:10"),
            (11, "08:10"),
            (15, "08:10"),
            (19, "08:10"),
            (20, "08:20"),
        ] {
            assert_eq!(
                hhmm(check_in_instant(cairo(2026, 9, 27, 8, minute))),
                expected,
                "check-in at 08:{minute:02} must land on {expected}"
            );
        }
    }

    #[test]
    fn a_check_out_rounds_forward_onto_the_grid() {
        // The mirror image. The expectation is the grid point at or AFTER the
        // action, never before it.
        for (minute, expected) in [
            (0_u32, "16:00"),
            (1, "16:10"),
            (5, "16:10"),
            (9, "16:10"),
            (10, "16:10"),
            (11, "16:20"),
            (15, "16:20"),
            (19, "16:20"),
            (20, "16:20"),
        ] {
            assert_eq!(
                hhmm(check_out_instant(cairo(2026, 9, 27, 16, minute))),
                expected,
                "check-out at 16:{minute:02} must land on {expected}"
            );
        }
    }

    #[test]
    fn the_two_directions_never_share_a_result() {
        // The regression this rule exists to prevent: one shared half-up
        // algorithm made a check-in land in the future and a check-out in the
        // past. Sweeping the whole day — to the SECOND, not just to the minute —
        // proves both directional invariants and the ten-minute ceiling
        // structurally, so no untested corner of the grid can hide a violation.
        for second_of_day in 0..86_400 {
            let local = chrono::NaiveDate::from_ymd_opt(2026, 9, 27)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap()
                + Duration::seconds(second_of_day);
            let instant = BUSINESS_TZ
                .from_local_datetime(&local)
                .earliest()
                .expect("the Cairo day exists")
                .with_timezone(&Utc);

            let check_in = check_in_instant(instant);
            assert!(
                check_in <= instant,
                "a check-in was moved into the future at second {second_of_day}"
            );
            let check_out = check_out_instant(instant);
            assert!(
                check_out >= instant,
                "a check-out was moved into the past at second {second_of_day}"
            );

            // The ceiling, stated exactly as the business rule states it: the
            // displacement never exceeds ten minutes, in EITHER direction.
            let max = Duration::minutes(MAX_ROUNDING_STEP_MINUTES);
            assert!(
                instant - check_in <= max,
                "a check-in moved back more than 10 minutes at second {second_of_day}"
            );
            assert!(
                check_out - instant <= max,
                "a check-out moved forward more than 10 minutes at second {second_of_day}"
            );
        }
    }

    #[test]
    fn the_rounding_interval_never_exceeds_ten_minutes() {
        // The hard business ceiling, asserted against the constant itself rather
        // than only against the behaviour. The `const` assertion in this module
        // makes the same guarantee at BUILD time; this test is the one a reader
        // can point at when asking "is it really ten?".
        assert_eq!(ROUNDING_STEP_MINUTES, 10);
        assert!(ROUNDING_STEP_MINUTES <= MAX_ROUNDING_STEP_MINUTES);
    }

    #[test]
    fn a_configured_interval_is_clamped_into_the_permitted_range() {
        // `clamp_rounding_minutes` is the domain-layer guard for the day an
        // interval becomes configurable. It can only ever return 1..=10, so the
        // intervals the requirement forbids are unreachable even if a caller
        // supplies one.
        for forbidden in [15, 30, 60, 120, i64::MAX] {
            assert_eq!(
                clamp_rounding_minutes(forbidden),
                MAX_ROUNDING_STEP_MINUTES,
                "a {forbidden}-minute interval must clamp to the ceiling"
            );
        }
        // A collapsed grid is not an improvement either, so it is raised to the
        // finest legal interval rather than dividing by zero.
        assert_eq!(clamp_rounding_minutes(0), 1);
        assert_eq!(clamp_rounding_minutes(-5), 1);
        // Anything already legal is left exactly as asked.
        for legal in 1..=MAX_ROUNDING_STEP_MINUTES {
            assert_eq!(clamp_rounding_minutes(legal), legal);
        }
    }

    #[test]
    fn an_exact_grid_time_is_never_moved() {
        // Both directions are no-ops on the lattice itself, which is what makes
        // "rounds down" and "rounds up" safe to state without a tie-break rule.
        for minute in [0_u32, 10, 20, 30, 40, 50] {
            let instant = cairo(2026, 9, 27, 8, minute);
            assert_eq!(hhmm(check_in_instant(instant)), format!("08:{minute:02}"));
            assert_eq!(hhmm(check_out_instant(instant)), format!("08:{minute:02}"));
        }
    }

    #[test]
    fn seconds_never_leak_a_rounding_across_a_boundary() {
        // The last second before a grid point still belongs to the PREVIOUS one,
        // and the first second of the grid point already belongs to the new one.
        assert_eq!(
            hhmm(check_in_instant(cairo_at(2026, 9, 27, 8, 9, 59))),
            "08:00"
        );
        assert_eq!(
            hhmm(check_in_instant(cairo_at(2026, 9, 27, 8, 10, 0))),
            "08:10"
        );
        assert_eq!(
            hhmm(check_out_instant(cairo_at(2026, 9, 27, 16, 9, 59))),
            "16:10"
        );
        assert_eq!(
            hhmm(check_out_instant(cairo_at(2026, 9, 27, 16, 10, 0))),
            "16:10"
        );
    }

    #[test]
    fn the_last_minute_of_the_day_rounds_within_the_ceiling() {
        // End of day. 23:59 is the worst case for a forward rounding, and 08:09:59
        // is the worst case for a backward one. Neither may exceed the ceiling,
        // and the day bucket still comes from the actual instant.
        let last = cairo_at(2026, 9, 27, 23, 59, 59);
        let check_out = check_out_instant(last);
        let max = Duration::minutes(MAX_ROUNDING_STEP_MINUTES);
        assert!(check_out >= last, "a check-out was moved into the past");
        assert!(
            check_out - last <= max,
            "a check-out moved over the ceiling"
        );
        // Forward rounding rolls into the next day, which is correct — and the
        // day the shift is FILED under is still the day it happened.
        assert_eq!(check_out.with_timezone(&BUSINESS_TZ).day(), 28);
        assert_eq!(
            check_out
                .with_timezone(&BUSINESS_TZ)
                .format("%H:%M")
                .to_string(),
            "00:00"
        );
        assert_eq!(crate::time::business_date_of(last), "2026-09-27");

        let worst_back = cairo_at(2026, 9, 27, 8, 9, 59);
        let check_in = check_in_instant(worst_back);
        assert!(
            check_in <= worst_back,
            "a check-in was moved into the future"
        );
        assert!(
            worst_back - check_in <= max,
            "a check-in moved over the ceiling"
        );
        assert_eq!(hhmm(check_in), "08:00");
    }

    #[test]
    fn rounding_happens_once_per_punch_and_in_the_right_direction() {
        // Idempotence is a property of the lattice, and it is what proves the
        // service cannot be rounding twice: re-rounding an already-rounded
        // instant is a no-op, so a second pass could not have produced a
        // different answer. The FIRST pass must still land in the right sense.
        let actual = cairo(2026, 9, 27, 8, 7);
        let once_in = check_in_instant(actual);
        assert_eq!(check_in_instant(once_in), once_in);
        assert_eq!(hhmm(once_in), "08:00");

        let actual = cairo(2026, 9, 27, 16, 7);
        let once_out = check_out_instant(actual);
        assert_eq!(check_out_instant(once_out), once_out);
        assert_eq!(hhmm(once_out), "16:10");
    }

    #[test]
    fn a_check_out_rounds_forward_across_midnight() {
        // 23:58 has no grid point after it on that day, so the effective time is
        // 00:00 of the NEXT day. The DAY bucket still comes from the actual
        // instant, never from the effective one — otherwise a late shift would be
        // filed under tomorrow's date.
        let rounded = check_out_instant(cairo(2026, 9, 27, 23, 58));
        let local = rounded.with_timezone(&BUSINESS_TZ);
        assert_eq!(local.day(), 28);
        assert_eq!(local.format("%H:%M").to_string(), "00:00");
        assert_eq!(
            crate::time::business_date_of(cairo(2026, 9, 27, 23, 58)),
            "2026-09-27"
        );
    }

    #[test]
    fn a_check_in_never_crosses_midnight() {
        // The mirror of the case above: rounding DOWN from just after midnight
        // stays inside the same day, so the day key and the effective time can
        // never disagree about which day a punch belongs to.
        let rounded = check_in_instant(cairo(2026, 9, 28, 0, 3));
        let local = rounded.with_timezone(&BUSINESS_TZ);
        assert_eq!(local.day(), 28);
        assert_eq!(local.format("%H:%M").to_string(), "00:00");
    }

    #[test]
    fn the_action_selects_the_direction() {
        // The single dispatch point the service uses, so no call site can pick
        // the wrong direction for its own action.
        let morning = cairo(2026, 9, 27, 8, 7);
        assert_eq!(
            effective_instant(morning, AttendanceAction::CheckIn),
            check_in_instant(morning)
        );
        let evening = cairo(2026, 9, 27, 16, 7);
        assert_eq!(
            effective_instant(evening, AttendanceAction::CheckOut),
            check_out_instant(evening)
        );
    }

    #[test]
    fn the_actual_instant_is_never_modified_by_rounding() {
        let actual = cairo(2026, 9, 27, 8, 7);
        let effective = check_in_instant(actual);
        assert_ne!(actual, effective);
        // The functions take their argument by value, so the caller's instant is
        // structurally unchanged; this asserts the value it read.
        assert_eq!(hhmm(actual), "08:07");
        assert_eq!(hhmm(effective), "08:00");
    }

    #[test]
    fn a_cashier_cannot_check_in_twice_on_one_day() {
        let err = ensure_transition_allowed(
            true,
            Some(AttendanceState::Present),
            true,
            false,
            AttendanceAction::CheckIn,
        )
        .unwrap_err();
        assert!(err.to_string().contains("attendance.already_checked_in"));
    }

    #[test]
    fn a_cashier_cannot_check_out_without_a_check_in() {
        let err = ensure_transition_allowed(true, None, false, false, AttendanceAction::CheckOut)
            .unwrap_err();
        assert!(err.to_string().contains("attendance.no_check_in"));
    }

    #[test]
    fn a_cashier_cannot_check_out_twice() {
        let err = ensure_transition_allowed(
            true,
            Some(AttendanceState::Present),
            true,
            true,
            AttendanceAction::CheckOut,
        )
        .unwrap_err();
        assert!(err.to_string().contains("attendance.already_checked_out"));
    }

    #[test]
    fn absence_and_leave_never_overwrite_a_punch_pair() {
        for action in [AttendanceAction::Absent, AttendanceAction::Leave] {
            let err = ensure_transition_allowed(
                true,
                Some(AttendanceState::Present),
                true,
                false,
                action,
            )
            .unwrap_err();
            assert!(err.to_string().contains("attendance.already_present"));
        }
    }

    #[test]
    fn absence_and_leave_never_overwrite_each_other() {
        for (current, action) in [
            (AttendanceState::Absent, AttendanceAction::Leave),
            (AttendanceState::Leave, AttendanceAction::Absent),
        ] {
            let err =
                ensure_transition_allowed(true, Some(current), false, false, action).unwrap_err();
            assert!(err.to_string().contains("attendance.day_already_recorded"));
        }
    }

    #[test]
    fn a_present_day_can_be_checked_out_exactly_once() {
        assert!(ensure_transition_allowed(
            true,
            Some(AttendanceState::Present),
            true,
            false,
            AttendanceAction::CheckOut
        )
        .is_ok());
    }

    #[test]
    fn an_inactive_employee_can_never_have_attendance() {
        for action in [
            AttendanceAction::CheckIn,
            AttendanceAction::CheckOut,
            AttendanceAction::Absent,
            AttendanceAction::Leave,
        ] {
            let err = ensure_transition_allowed(false, None, false, false, action).unwrap_err();
            assert!(err.to_string().contains("attendance.employee_inactive"));
        }
    }

    #[test]
    fn an_unknown_stored_state_is_an_error_not_a_default() {
        assert!(parse_state("PRESENT").is_ok());
        assert!(parse_state("SICK").is_err());
        assert!(parse_state("").is_err());
    }

    #[test]
    fn worked_minutes_are_measured_between_effective_punches() {
        // 08:13 -> 16:24 on the ten-minute grid is 08:10 -> 16:30 = 8h20m.
        // Note the two directions: the check-in went BACK and the check-out went
        // FORWARD, which is why the span is wider than the actual one — and never
        // wider than 20 minutes, one ceiling per end.
        let start = crate::time::to_db_timestamp(check_in_instant(cairo(2026, 9, 27, 8, 13)));
        let end = crate::time::to_db_timestamp(check_out_instant(cairo(2026, 9, 27, 16, 24)));
        assert_eq!(worked_minutes_of(Some(&start), Some(&end)), Some(500));
    }

    #[test]
    fn an_open_day_has_no_worked_minutes_yet() {
        let start = crate::time::to_db_timestamp(check_in_instant(cairo(2026, 9, 27, 8, 13)));
        assert_eq!(worked_minutes_of(Some(&start), None), None);
        assert_eq!(worked_minutes_of(None, None), None);
    }

    #[test]
    fn worked_minutes_never_go_negative() {
        let late = crate::time::to_db_timestamp(check_in_instant(cairo(2026, 9, 27, 17, 0)));
        let early = crate::time::to_db_timestamp(check_in_instant(cairo(2026, 9, 27, 9, 0)));
        assert_eq!(worked_minutes_of(Some(&late), Some(&early)), Some(0));
    }

    #[test]
    fn a_malformed_business_date_is_rejected_not_guessed() {
        assert!(validate_business_date("2026-09-27").is_ok());
        assert!(validate_business_date("27/09/2026").is_err());
        assert!(validate_business_date("2026-13-01").is_err());
        assert!(validate_business_date("").is_err());
    }
}
