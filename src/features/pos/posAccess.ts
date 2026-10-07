/**
 * Access to today's two daily records — فواتير اليوم and تذاكر المغسلة اليوم.
 *
 * Two questions, answered in order — which is why a manager without an open
 * shift can still reach either page while a closed day hides both:
 *
 *   1. Is there an ACTIVE business day? → the DAY (`DayShiftState['day']`).
 *      The two reads are day-scoped (`business_day_id`, with a whole-history
 *      fallback when no day is open), so without an open day there is no "today"
 *      for the buttons to mean. Historical existence ≠ active day.
 *   2. Can the user access the feature?  → the ROLE.
 *
 * A shift is deliberately NOT part of the decision: reading the day's invoices
 * or wash tickets is not selling, so a closed/missing personal shift must not
 * hide records while the day stays open. The backend agrees: both reads are
 * `authorized(..., "STAFF", ...)` and neither filters by `user_id` or requires
 * an active shift. Nothing financial is loosened — the commands behind the
 * pages remain the authority, and these predicates can only ever hide a page
 * the backend would serve, never expose one it would refuse.
 */
import { roleRank, type UserRole } from '@/lib/roles'
import type { DayShiftState } from '@/services/shiftApi'

export function canOpenDailyRecords(role: UserRole | undefined): boolean {
  return roleRank(role) >= roleRank('STAFF')
}

/**
 * Gate-screen visibility for the two daily-record entry points.
 *
 * Visible only while a business day is active AND the role permits — i.e. the
 * "Required Action State" shows history as secondary context on an open day,
 * and a clean start/open-business composition when there is no active day
 * (cold till) or after the day is closed/finalized (`day` returns to `null`).
 */
export function canShowDailyRecords(
  role: UserRole | undefined,
  day: DayShiftState['day'],
): boolean {
  return day !== null && canOpenDailyRecords(role)
}
