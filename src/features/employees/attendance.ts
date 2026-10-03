/**
 * The attendance state machine, mirrored for the UI.
 *
 * The backend is the authority — `record_attendance` re-checks every one of
 * these rules and rejects anything invalid even if this helper were wrong. This
 * exists so a cashier is not offered a button that is guaranteed to fail.
 *
 * It is deliberately a PURE function of what the backend already sent: the
 * employee's status and today's live row. No business rule is invented here, and
 * no timestamp is computed — the rounding lives in Rust alone, so the screen can
 * never show an effective time the service would not have stored.
 */
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { businessWallClockToDate } from '@/lib/date'
import { useWorkDurationSettings, type WorkDurationDisplay } from '@/lib/formatting'
import type { AttendanceAction, AttendanceState } from '@/services/employeesApi'

export type AttendanceAvailability = {
  /** Whether the caller may record anything at all for this employee. */
  canRecord: boolean
  /** The two primary punch actions, always offered first. */
  checkIn: boolean
  checkOut: boolean
  /** The absence and leave actions, filed through the same operation. */
  absent: boolean
  leave: boolean
}

/**
 * The only facts about a day the state machine reads. Both the drawer's full
 * `AttendanceDay` and the list row's lighter projection satisfy it, so the same
 * rules apply to the personal card, the table row and the timeline.
 */
export type TodayFacts = {
  state: AttendanceState
  check_in_effective_at: string | null
  check_out_effective_at: string | null
}

/**
 * Which actions are legal right now.
 *
 * @param employeeActive An INACTIVE employee can never take attendance.
 * @param today           The employee's live row for the current business day.
 * @param canOperate      May the caller record attendance for OTHER people? Every
 *                        authenticated role may — the roster a CASHIER sees is an
 *                        attendance-operation table, and taking a punch is the
 *                        operation it exists for. This is a hint derived from the
 *                        session, never the boundary: the service re-checks it.
 */
export function attendanceAvailability(
  employeeActive: boolean,
  today: TodayFacts | null,
  canOperate: boolean,
): AttendanceAvailability {
  if (!employeeActive) {
    return { canRecord: false, checkIn: false, checkOut: false, absent: false, leave: false }
  }

  const hasPunch = today?.state === 'PRESENT'
  const checkedIn = hasPunch && !today?.check_out_effective_at
  const markedAbsent = today?.state === 'ABSENT'
  const markedLeave = today?.state === 'LEAVE'
  // A day that was never punched, and carries no absence or leave already.
  const untouched = !hasPunch && !markedAbsent && !markedLeave

  // All four actions go through the same operation and the same authorization, so
  // `canRecord` is one fact. What separates them is only the day's own state.
  const canRecord = canOperate

  return {
    canRecord,
    // Check-in needs no prior record; check-out needs an open PRESENT day.
    checkIn: canRecord && untouched,
    checkOut: canRecord && checkedIn,
    // Absence and leave describe a day that was never punched, and — like the
    // punches — can never overwrite one that was.
    absent: canRecord && untouched,
    leave: canRecord && untouched,
  }
}

/** The action a single attendance button dispatches. */
export const ATTENDANCE_ACTION: Record<
  'checkIn' | 'checkOut' | 'absent' | 'leave',
  AttendanceAction
> = {
  checkIn: 'CHECK_IN',
  checkOut: 'CHECK_OUT',
  absent: 'ABSENT',
  leave: 'LEAVE',
}

/**
 * Project a list row into the "today" shape the state machine reads.
 *
 * The list query already carries today's live state, so this is a projection of
 * data the backend sent — not a second source of truth and not a guess.
 */
export function todayOf(employee: {
  today_state: AttendanceState | null
  today_check_in_effective_at: string | null
  today_check_out_effective_at: string | null
}): TodayFacts | null {
  if (!employee.today_state) return null
  return {
    state: employee.today_state,
    check_in_effective_at: employee.today_check_in_effective_at,
    check_out_effective_at: employee.today_check_out_effective_at,
  }
}

/**
 * Worked minutes → the on-screen form of a worked duration.
 *
 * This is a PURE FORMATTER and the ONLY one in the application. The employee
 * KPI, the roster's hours column, the details-drawer totals, the per-day
 * attendance timeline and the personal attendance card all call it, so a change
 * to the Dev Settings display mode reaches every one of them at once and no
 * consumer can quietly keep its own idea of how a duration reads.
 *
 * # The mode is presentation only
 *
 * The minutes are already the canonical value: the backend computed them
 * between the EFFECTIVE punches and the payroll, the reports and every
 * calculation keep reading that same number. Nothing here rounds, rescales or
 * rewrites what was stored — `hours` divides for DISPLAY and renders one
 * decimal, and the stored 485 is still 485 everywhere else.
 *
 * `hours` is deliberately an APPROXIMATE figure (`8.1 س`) and never `8س 06د`:
 * the point of the mode is a single glance-readable number, so the minute
 * remainder is dropped rather than appended. `toFixed(1)` is what guarantees
 * that shape, and it is also what keeps the value a fixed-width string so the
 * column stays visually aligned down a column of figures.
 *
 * An open attendance day has no total yet, so the caller renders the running
 * state (`—`) instead of calling this with a placeholder.
 */
export function formatWorkDuration(
  minutes: number,
  display: WorkDurationDisplay,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  // A negative or non-finite total is not a duration the UI should invent a
  // reading for; zero is the honest floor and matches what the backend can
  // store (a same-instant punch pair).
  const total = Number.isFinite(minutes) ? Math.max(0, Math.trunc(minutes)) : 0

  if (display === 'hours') {
    return translate('employees.duration.hoursOnly', {
      hours: (total / 60).toFixed(1),
    })
  }
  return translate('employees.duration.minutesOnly', { minutes: total })
}

/**
 * A worked duration bound to the current display setting.
 *
 * The hook every consumer uses, so none of them has to thread the mode through
 * by hand or re-derive it. It re-renders its caller the moment the setting
 * changes, which is what makes a Dev Settings edit visible immediately on an
 * already-mounted page.
 */
export function useWorkDurationFormatter(): (minutes: number) => string {
  const { display } = useWorkDurationSettings()
  const { t } = useTranslation()
  return useCallback((minutes: number) => formatWorkDuration(minutes, display, t), [display, t])
}

// ---------------------------------------------------------------------------
// Manager override — the draft the correction dialog edits
// ---------------------------------------------------------------------------

/**
 * A stored instant as the `HH:MM` a time input needs.
 *
 * The same Station business wall clock the rest of the screen renders, produced
 * by the shared date helper rather than by `Date#getHours` — the browser's own
 * timezone is never the business one, and a form pre-filled with the browser's
 * reading of an instant would submit a time the manager never chose.
 *
 * An absent value is an EMPTY string, not a zero: an open day has no check-out,
 * and "00:00" would be a real (and wrong) statement about the punch.
 */
export function toTimeInputValue(value: string | null | undefined): string {
  if (!value) return ''
  const wallClock = businessWallClockToDate(value)
  if (!wallClock) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${pad(wallClock.getUTCHours())}:${pad(wallClock.getUTCMinutes())}`
}

/** The override form state for one attendance day. */
export type OverrideDraft = {
  /** `HH:MM` in the business wall clock, or empty for "not stated". */
  checkIn: string
  checkOut: string
}

/**
 * The draft a manager starts from: the day as it stands today.
 *
 * Pre-filling with the CURRENT values is deliberate — the correction is a
 * statement about what is wrong, so the untouched side is already correct and
 * sending it back unchanged is a no-op the backend treats as "keep it".
 */
export function overrideDraftOf(day: {
  check_in_effective_at: string | null
  check_out_effective_at: string | null
}): OverrideDraft {
  return {
    checkIn: toTimeInputValue(day.check_in_effective_at),
    checkOut: toTimeInputValue(day.check_out_effective_at),
  }
}

/** Why a draft cannot be sent, as an i18n key suffix. `null` means it can. */
export type OverrideDraftError = 'required' | 'invalidPair' | 'unchanged'

/**
 * What is wrong with the draft, if anything.
 *
 * The ordering rule is the same one the service enforces — a check-out may not
 * precede or equal its check-in — and the comparison is a plain string compare
 * because `HH:MM` from a time input is zero-padded, so it sorts exactly as the
 * instants do. `original` is the draft the dialog opened with, so "unchanged" is
 * a statement about the edit rather than a tautology.
 *
 * This is a convenience that keeps the manager from being told "no" by the
 * backend for something visible on the form; the service re-checks all of it
 * regardless of what this returns.
 */
export function overrideDraftError(
  draft: OverrideDraft,
  original: OverrideDraft,
): OverrideDraftError | null {
  // A present day must keep a check-in: clearing it is not an adjustment.
  if (!draft.checkIn) return 'required'
  if (draft.checkOut && draft.checkOut <= draft.checkIn) return 'invalidPair'
  if (draft.checkIn === original.checkIn && draft.checkOut === original.checkOut) return 'unchanged'
  return null
}

/**
 * The pair an override draft states, ready for the API — ONLY the sides that
 * actually moved.
 *
 * An untouched side is sent as `null`, which the backend reads as "leave this
 * one as it is" and carries over value for value. That is the safe direction: a
 * correction must never be able to rewrite a punch the manager did not mention,
 * even if the screen was showing a stale copy of it. A blank field is likewise
 * `null` — a present day keeps its check-in.
 */
export function overrideTimesOf(
  draft: OverrideDraft,
  original: OverrideDraft,
): { check_in: string | null; check_out: string | null } {
  const checkIn = draft.checkIn && draft.checkIn !== original.checkIn ? draft.checkIn : null
  const checkOut = draft.checkOut && draft.checkOut !== original.checkOut ? draft.checkOut : null
  return { check_in: checkIn, check_out: checkOut }
}
