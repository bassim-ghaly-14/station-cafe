/**
 * Access to today's two daily records — فواتير اليوم and تذاكر المغسلة اليوم.
 *
 * Three questions that used to be answered as one, which is why a manager
 * without an open shift could not reach either page:
 *
 *   1. Can the user access the feature?  → the ROLE.
 *   2. Does the user have an open shift?  → the SHIFT, which gates selling.
 *   3. Does the record belong to this user? → the OWNER, which the two pages
 *      never ask about.
 *
 * Only question 1 decides visibility here. The backend agrees: both reads are
 * `authorized(..., "STAFF", ...)` and neither filters by `user_id` or requires
 * an active shift, so a cashier can look up a colleague's invoice or ticket,
 * and a manager can read the day without opening a till. Nothing financial is
 * loosened by showing the entry points — the commands behind them remain the
 * authority, and this predicate can only ever hide a page the backend would
 * serve, never expose one it would refuse.
 */
import { roleRank, type UserRole } from '@/lib/roles'

export function canOpenDailyRecords(role: UserRole | undefined): boolean {
  return roleRank(role) >= roleRank('STAFF')
}
