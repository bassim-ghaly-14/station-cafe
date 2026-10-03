/**
 * The signed-in user's own attendance — the "الحضور والانصراف" panel.
 *
 * This is the cashier's whole experience of the page, so it is mounted for EVERY
 * role rather than being a manager extra: a manager is also a person who clocks
 * in. It renders exactly three states — not checked in, checked in, checked out
 * — and in each one it states the effective time the BACKEND stored. The screen
 * never rounds a timestamp itself: the grid is a Rust rule, and a UI that
 * computed its own would eventually disagree with the payroll it is showing.
 *
 * The "check out" time and the total duration come from the backend too. While
 * the day is still open the total is deliberately absent rather than a running
 * estimate: a partial number must never be mistaken for a settled one.
 */
import { useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmployeeAvatar,
  Skeleton,
  useToast,
} from '@/components/ui'
import { DisplayTime } from '@/components/ui/display-datetime'
import { Clock, DoorClosed, DoorOpen } from '@/components/ui/icon'
import { ErrorState } from '@/components/states'
import type { BadgeVariant } from '@/lib/status-badge'
import { useErrText } from '@/lib/err'
import { attendanceAvailability, useWorkDurationFormatter } from './attendance'
import { roleLabel, roleOf } from './employee-role'
import { employeesApi } from '@/services/employeesApi'
import type { MyAttendance } from '@/services/employeesApi'

/**
 * A labelled figure in the card's horizontal band.
 *
 * A definition-style pair: the label above, the value below, both in the
 * project's existing type tokens. The value uses `tabular-nums` so two times
 * side by side keep their columns aligned, which is what makes a horizontal row
 * of figures readable rather than a row of unrelated numbers.
 */
function Figure({
  label,
  children,
}: Readonly<{ readonly label: string; children: React.ReactNode }>) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-caption text-foreground-subtle">{label}</span>
      <span className="text-body font-bold tabular-nums text-foreground-strong">{children}</span>
    </div>
  )
}

/**
 * A hairline divider between the card's logical zones.
 *
 * `self-stretch` inside a flex row is what lets one rule run the full height of
 * the band regardless of how tall the neighbouring content is, so the zones stay
 * aligned at every breakpoint without any hard-coded height.
 */
function Divider() {
  return <span aria-hidden className="hidden w-px self-stretch bg-border-subtle sm:block" />
}

/**
 * The two states that stand in for the card while there is no record to show:
 * a failed load and a load in progress. Both are only reachable when `mine` is
 * absent, so the caller decides that and this component just picks the state.
 */
function AttendancePlaceholder({
  t,
  error,
  loading,
  onRetry,
}: Readonly<{
  readonly t: TFunction
  readonly error: string | null
  readonly loading: boolean
  readonly onRetry: () => void
}>) {
  if (error) {
    return <ErrorState message={error} onRetry={onRetry} retryLabel={t('app.retry')} />
  }

  if (loading) {
    return (
      <Card aria-busy="true" className="flex flex-col gap-3 p-4">
        <Skeleton variant="text" className="h-4 w-1/3" accessibilityLabel="" />
        <Skeleton variant="rect" className="h-9 w-40" accessibilityLabel="" />
      </Card>
    )
  }

  return null
}

/**
 * The tone of today's shift on the personal card.
 *
 * This is NOT the attendance state: a present employee whose shift has already
 * closed reads as done (success), one still on the floor as live (info), and
 * anyone else — absent, on leave, or not recorded — as the in-between warning
 * that must not be mistaken for either.
 */
function shiftBadgeVariant({
  open,
  closed,
}: Readonly<{ readonly open: boolean; readonly closed: boolean }>): BadgeVariant {
  if (open) return 'info'
  if (closed) return 'success'
  return 'warning'
}

export function MyAttendanceCard({
  mine,
  loading,
  error,
  onRetry,
  onRecorded,
}: {
  readonly mine: MyAttendance | null
  readonly loading: boolean
  readonly error: string | null
  readonly onRetry: () => void
  /** Called after a successful punch, so the page can refresh the roster. */
  readonly onRecorded: () => void
}) {
  const { t } = useTranslation()
  const formatDuration = useWorkDurationFormatter()
  const errText = useErrText(t)
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  // The user's OWN punch, awaiting confirmation. Held separately from the
  // page's roster confirmations because the copy names the user themselves
  // rather than a colleague, but it is the same rule: no attendance state
  // changes from a single click.
  const [pending, setPending] = useState<'CHECK_IN' | 'CHECK_OUT' | null>(null)

  // Nothing to show yet: the load failed, it is still running, or there is no
  // record at all. The guards are unchanged, so a record that is already on
  // screen is never replaced by a placeholder.
  if (!mine && (error || loading)) {
    return <AttendancePlaceholder t={t} error={error} loading={loading} onRetry={onRetry} />
  }

  if (!mine) return null

  // An account with no employee record (a manager created before this feature)
  // has no attendance of its own, and says so rather than erroring.
  if (!mine.employee) {
    return (
      <Card className="flex flex-col gap-2 p-4">
        <h2 className="text-section">{t('employees.mine.title')}</h2>
        <p className="text-caption text-foreground-subtle">{t('employees.mine.noEmployee')}</p>
      </Card>
    )
  }

  const availability = attendanceAvailability(mine.employee.status === 'ACTIVE', mine.today, true)

  /** Opens the confirmation. It performs nothing by itself. */
  function requestRecord(action: 'CHECK_IN' | 'CHECK_OUT') {
    setPending(action)
  }

  /** The only place the personal punch is actually sent. */
  async function confirmRecord() {
    if (!pending || !mine?.employee) return
    const action = pending
    setPending(null)
    setBusy(true)
    try {
      await employeesApi.recordAttendance(mine.employee.id, action)
      toast(t('employees.mine.saved'), 'success')
      onRecorded()
    } catch (cause) {
      toast(errText(cause), 'error')
    } finally {
      setBusy(false)
    }
  }

  /**
   * The confirmation copy, derived from `pending` so the sentence and the
   * request can never disagree. The rounding hint is stated because the stored
   * time is deliberately NOT the wall clock the user sees on their own device.
   *
   * Computed inline rather than memoised: this component returns early for the
   * loading and no-record cases, and a hook placed after those returns would be
   * called a different number of times per render. The derivation is two
   * property lookups, so there is nothing to memoise anyway.
   */
  const confirmation = pending
    ? {
        title: t('employees.confirm.title'),
        body: t(
          pending === 'CHECK_IN' ? 'employees.confirm.myCheckIn' : 'employees.confirm.myCheckOut',
        ),
        detail: t('employees.confirm.roundingHint'),
      }
    : null

  const today = mine.today
  const open = today?.state === 'PRESENT' && !today.check_out_effective_at
  const closed = today?.state === 'PRESENT' && Boolean(today.check_out_effective_at)
  const shiftTone = shiftBadgeVariant({ open, closed })
  const employee = mine.employee

  /*
   * Layout
   * ------
   * The card is ONE horizontal band of four zones, not a vertical stack:
   *
   *   [ identity ] │ [ state · check-in · check-out · duration ] │ [ actions ]
   *
   * Previously each of those facts sat on its own line, which stacked four short
   * rows into the left of a full-width card and left the rest empty. Reading them
   * across instead puts related values side by side, keeps the card short, and
   * lets the actions sit at the far edge where a pointer expects them.
   *
   * The zones are separated by a hairline, not by a nested card — the card
   * itself is already the surface, and card-inside-card is the pattern this page
   * deliberately avoids elsewhere. Every colour, radius and shadow here is an
   * existing token, so the band reads as part of the Employees page rather than
   * as a new component.
   *
   * Responsive: below `sm` the dividers disappear and the zones stack, because
   * four figures plus two buttons genuinely do not fit on a phone. Above it the
   * band is one row that uses the available width. Nothing is achieved by
   * shrinking type — the labels and values keep their normal sizes at every
   * breakpoint, and the band simply wraps where it must.
   */
  return (
    <Card className="p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-6">
        {/* Zone 1 — identity. For a CASHIER this panel is the only place on the
            page where an employee record is theirs to see, so it states their
            identity as well as their day. Every value comes from the session's own
            employee row, which the backend resolves from the login. */}
        <div className="flex min-w-0 shrink-0 items-center gap-3">
          <EmployeeAvatar role={roleOf(employee)} size="lg" />
          <div className="flex min-w-0 flex-col">
            <h2 className="text-section">{t('employees.mine.title')}</h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <span className="text-body font-medium text-foreground-strong">{employee.name}</span>
              <Badge role={roleOf(employee)} size="sm" dot>
                {roleLabel(t, roleOf(employee))}
              </Badge>
              {employee.phone ? (
                <span dir="ltr" className="text-caption tabular-nums text-foreground-subtle">
                  {employee.phone}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <Divider />

        {/* Zone 2 — today's facts, side by side. The state badge leads, because
            it is the one thing readable without parsing a single time. */}
        <div className="flex flex-1 flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1">
            {today ? (
              <Badge variant={shiftTone} size="sm" dot>
                {t(`employees.state.${today.state}`)}
              </Badge>
            ) : (
              // "Not recorded" is NOT an absence. The wording says exactly that.
              <span className="text-caption text-foreground-subtle">
                {t('employees.mine.notRecorded')}
              </span>
            )}
          </div>

          {open ? (
            <Figure label={t('employees.mine.checkedInAt')}>
              <span className="flex items-center gap-1.5">
                <Clock size={14} aria-hidden className="text-foreground-subtle" />
                <DisplayTime value={today.check_in_effective_at} />
              </span>
            </Figure>
          ) : null}

          {closed ? (
            <>
              <Figure label={t('employees.mine.checkedInAt')}>
                <DisplayTime value={today.check_in_effective_at} />
              </Figure>
              <Figure label={t('employees.mine.checkedOutAt')}>
                <DisplayTime value={today.check_out_effective_at} />
              </Figure>
              {/* The settled total, and only once the day is closed: a partial
                  number must never be mistaken for a settled one. */}
              <Figure label={t('employees.mine.duration')}>
                {mine.worked_minutes_today !== null
                  ? formatDuration(mine.worked_minutes_today)
                  : '—'}
              </Figure>
            </>
          ) : null}
        </div>

        <Divider />

        {/* Zone 3 — the actions, at the far edge. Each opens a confirmation; see
            `confirmRecord`. */}
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:shrink-0 sm:flex-wrap sm:items-center sm:gap-2">
          <Button
            disabled={busy || !availability.checkIn}
            onClick={() => requestRecord('CHECK_IN')}
            className="min-w-32"
          >
            <DoorOpen size={18} aria-hidden />
            {t('employees.actions.checkIn')}
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !availability.checkOut}
            onClick={() => requestRecord('CHECK_OUT')}
            className="min-w-32"
          >
            <DoorClosed size={18} aria-hidden />
            {t('employees.actions.checkOut')}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmation !== null}
        onClose={() => setPending(null)}
        onConfirm={confirmRecord}
        title={confirmation?.title ?? ''}
        body={confirmation?.body ?? ''}
        detail={confirmation?.detail}
        busy={busy}
      />
    </Card>
  )
}
