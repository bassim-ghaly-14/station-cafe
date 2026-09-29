/**
 * Employee details drawer (MANAGER+) — one person's whole record.
 *
 * It opens BESIDE the list instead of navigating away, so the manager keeps
 * their place in the roster while reading one person's history.
 *
 * The payload is a SINGLE manager-level read: identity, the period figures, the
 * attendance timeline, the advance ledger and the payroll runs. Nothing here is
 * computed in the browser — every figure arrives already aggregated, and a
 * failed read is reported as a failure rather than shown as zeroes.
 *
 * Information architecture
 * ------------------------
 * The panel reads top to bottom as an employee profile: header (identity), the
 * period summary, the attendance timeline, the advances, the payroll periods and
 * finally the performance. Sections are separated by LABELS, spacing and
 * hairlines rather than by a bordered card around each one — no card inside
 * card inside card.
 *
 * Attendance timeline
 * -------------------
 * Each day shows its state, its EFFECTIVE check-in and check-out, and the
 * duration between them. The actual clock readings are deliberately NOT shown
 * here: they are preserved in the database for audit, and the effective pair is
 * the business fact. The recorder's name IS shown, because for a wash worker
 * that is the only trace of who marked them in.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/states'
import {
  Badge,
  Button,
  Drawer,
  EmployeeAvatar,
  MoneyDisplay,
  ProgressBar,
  Skeleton,
} from '@/components/ui'
import { DisplayDate, DisplayTime } from '@/components/ui/display-datetime'
import { Coffee, Droplets, ArrowLeft, CalendarClock } from '@/components/ui/icon'
import { useErrText } from '@/lib/err'
import type { EmployeeRole } from '@/lib/roles'
import { roleHintKey, roleLabel, roleOf } from './employee-role'
import { formatWorkedDuration } from './attendance'
import { AttendanceOverrideDialog } from './AttendanceOverrideDialog'
import { employeesApi } from '@/services/employeesApi'
import type {
  Advance,
  AttendanceDay,
  Employee,
  EmployeeDetails,
  EmployeePeriod,
  EmployeeRow,
  PayrollRun,
} from '@/services/employeesApi'

/** A compact premium stat block: a quiet label over a strong figure. */
function StatBlock({
  label,
  children,
}: Readonly<{ readonly label: string; children: React.ReactNode }>) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md bg-surface-muted px-3 py-2.5">
      <span className="truncate text-caption">{label}</span>
      <span className="truncate text-body font-bold tabular-nums text-foreground-strong">
        {children}
      </span>
    </div>
  )
}

/** A titled band inside the drawer: a label, whitespace and a hairline. */
function Section({
  title,
  children,
}: Readonly<{ readonly title: string; children: React.ReactNode }>) {
  return (
    <section className="mt-5 border-t border-border-subtle pt-4">
      <h3 className="mb-2.5 text-caption font-bold text-foreground-muted">{title}</h3>
      {children}
    </section>
  )
}

/** A `<dl>` row for the quieter ledger figures. */
function LedgerRow({
  label,
  children,
}: Readonly<{ readonly label: string; children: React.ReactNode }>) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border-subtle py-1.5 last:border-0">
      <dt className="min-w-0 truncate text-caption">{label}</dt>
      <dd className="shrink-0 text-body font-bold tabular-nums">{children}</dd>
    </div>
  )
}

/**
 * The profile header: identity, the presented role, the status and the phone.
 *
 * The role is the SAME derivation the table uses, passed down already resolved,
 * so the drawer can never show a different role for the same person than the row
 * it was opened from.
 */
function EmployeeHeader({ employee, role }: Readonly<{ employee: Employee; role: EmployeeRole }>) {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 items-start gap-3.5">
      <EmployeeAvatar role={role} size="lg" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-heading">{employee.name}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {/* The REAL role, never the employee type. */}
          <Badge role={role} size="sm" dot>
            {roleLabel(t, role)}
          </Badge>
          <Badge variant={employee.status === 'ACTIVE' ? 'success' : 'neutral'} size="sm" dot>
            {t(`employees.status.${employee.status}`)}
          </Badge>
          {employee.phone ? (
            <span dir="ltr" className="text-caption tabular-nums">
              {employee.phone}
            </span>
          ) : null}
        </div>
        <p className="mt-1.5 text-caption text-foreground-subtle">{t(roleHintKey(role))}</p>
      </div>
    </div>
  )
}

/** The period summary — the same figures the table row showed. */
function PeriodSummary({ row }: Readonly<{ row: EmployeeRow | null }>) {
  const { t } = useTranslation()
  return (
    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <StatBlock label={t('employees.drawer.attendance')}>{row?.attendance_days ?? 0}</StatBlock>
      <StatBlock label={t('employees.drawer.hours')}>
        {formatWorkedDuration(row?.worked_minutes ?? 0, t)}
      </StatBlock>
      <StatBlock label={t('employees.drawer.absence')}>{row?.absence_days ?? 0}</StatBlock>
      <StatBlock label={t('employees.drawer.leave')}>{row?.leave_days ?? 0}</StatBlock>
    </div>
  )
}

/** The payroll runs recorded for the employee. */
function PayrollList({ runs }: Readonly<{ runs: readonly PayrollRun[] }>) {
  const { t } = useTranslation()
  if (runs.length === 0) {
    return <p className="text-caption text-foreground-subtle">{t('employees.drawer.noPayroll')}</p>
  }
  return (
    <ul className="flex flex-col gap-2">
      {runs.map((run) => (
        <li
          key={run.id}
          className="flex flex-col gap-1.5 rounded-md border border-border-subtle p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-body font-bold tabular-nums">{run.period}</span>
            <Badge variant={run.status === 'FINALIZED' ? 'success' : 'info'} size="sm" dot>
              {t(`employees.payroll.${run.status}`)}
            </Badge>
          </div>
          <dl>
            <LedgerRow label={t('employees.drawer.baseSalary')}>
              <MoneyDisplay amount={run.base_salary} variant="auto" />
            </LedgerRow>
            <LedgerRow label={t('employees.drawer.advances')}>
              <MoneyDisplay amount={run.advances} variant="auto" />
            </LedgerRow>
            <LedgerRow label={t('employees.drawer.deductions')}>
              <MoneyDisplay amount={run.deductions} variant="auto" />
            </LedgerRow>
            <LedgerRow label={t('employees.drawer.netSalary')}>
              <MoneyDisplay amount={run.net_salary} variant="auto" />
            </LedgerRow>
          </dl>
        </li>
      ))}
    </ul>
  )
}

/**
 * The performance band.
 *
 * A CASHIER is measured on the shifts they opened and the cafe money booked to
 * them. A wash worker is not, and there is deliberately no wash revenue here: the
 * department's money belongs to the department, so a figure under one worker's
 * name would be a fabrication. Attendance, salary and advances above are how a
 * wash worker is actually managed.
 */
function PerformanceSection({
  employee,
  row,
}: Readonly<{ employee: Employee; row: EmployeeRow | null }>) {
  const { t } = useTranslation()
  if (employee.employee_type !== 'CASHIER') {
    return (
      <p className="flex items-center gap-1.5 text-caption text-foreground-subtle">
        <Droplets size={14} aria-hidden />
        {t('employees.drawer.departmentRevenueNote')}
      </p>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      <StatBlock label={t('employees.drawer.shifts')}>
        <span className="flex items-center gap-1.5">
          <Coffee size={14} aria-hidden />
          {row?.shifts_count ?? 0}
        </span>
      </StatBlock>
      <StatBlock label={t('employees.drawer.cafeRevenue')}>
        <MoneyDisplay amount={row?.cafe_revenue ?? 0} variant="auto" />
      </StatBlock>
    </div>
  )
}

/**
 * The whole record, once it has resolved.
 *
 * The panel reads top to bottom as an employee profile: header (identity), the
 * period summary, the attendance timeline, the advances, the payroll periods and
 * finally the performance. Sections are separated by LABELS, spacing and
 * hairlines rather than by a bordered card around each one — no card inside
 * card inside card.
 *
 * A RELOAD behind an override dims the record and shows a progress bar rather
 * than replacing it: the figures are still true while they are being refreshed,
 * and the correction dialog has just closed on top of them.
 */
function EmployeeRecord({
  details,
  canOverride,
  loading,
  onOverride,
}: Readonly<{
  details: EmployeeDetails
  canOverride: boolean
  loading: boolean
  onOverride: (day: AttendanceDay) => void
}>) {
  const { t } = useTranslation()
  const { employee } = details
  const row = details.period_row ?? null

  return (
    <div className={loading ? 'opacity-70' : undefined}>
      <EmployeeHeader employee={employee} role={roleOf(employee)} />

      <PeriodSummary row={row} />

      <Section title={t('employees.drawer.salary')}>
        <dl>
          <LedgerRow label={t('employees.drawer.baseSalary')}>
            <MoneyDisplay amount={employee.base_salary} variant="auto" />
          </LedgerRow>
        </dl>
      </Section>

      <Section title={t('employees.drawer.attendanceTimeline')}>
        <AttendanceTimeline
          days={details.attendance}
          employeeName={employee.name}
          canOverride={canOverride}
          onOverride={onOverride}
        />
      </Section>

      <Section title={t('employees.drawer.advances')}>
        <AdvanceList advances={details.advances} />
      </Section>

      <Section title={t('employees.drawer.payroll')}>
        <PayrollList runs={details.payroll} />
      </Section>

      <Section title={t('employees.drawer.performance')}>
        <PerformanceSection employee={employee} row={row} />
      </Section>

      {loading ? <ProgressBar label={t('app.loading')} className="mt-4 w-24" /> : null}
    </div>
  )
}

export function EmployeeDetailsDrawer({
  employeeId,
  employeeName,
  period,
  canOverride,
  onClose,
  onOverridden,
}: {
  readonly employeeId: number | null
  /** The name is only for the panel's accessible title before the load lands. */
  readonly employeeName: string
  readonly period: EmployeePeriod
  /**
   * Whether this session may ADMINISTRATIVELY override a day.
   *
   * The drawer is manager-level already, but the override is the one action here
   * that rewrites a recorded time, so it is gated explicitly and separately
   * rather than being inherited by accident. Hiding the button is an affordance:
   * the service refuses a STAFF session regardless of what is rendered.
   */
  readonly canOverride: boolean
  readonly onClose: () => void
  /** Called after an override is accepted, so the page's own queries refresh. */
  readonly onOverridden: () => void
}) {
  const { t } = useTranslation()
  const errText = useErrText(t)
  const [details, setDetails] = useState<EmployeeDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The single day being corrected, or null when no override is open. Mounting
  // the dialog from this value is what keeps its draft pinned to ONE day.
  const [overriding, setOverriding] = useState<AttendanceDay | null>(null)

  // `period` is memoized by the page (see EmployeesPage), so depending on the
  // object is the same trigger as depending on its two bounds, and it cannot
  // re-issue the read on an unrelated render.
  const load = useCallback(() => {
    if (employeeId === null) return
    let active = true
    setLoading(true)
    employeesApi
      .details(employeeId, period)
      .then((result) => {
        if (!active) return
        setDetails(result)
        setError(null)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(errText(cause))
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [employeeId, period, errText])

  useEffect(load, [load])

  const employee = details?.employee

  return (
    <>
      <Drawer
        open={employeeId !== null}
        onClose={onClose}
        title={employee?.name ?? employeeName}
        width="lg"
      >
        {error && !details ? (
          <ErrorState message={error} onRetry={load} retryLabel={t('app.retry')} />
        ) : loading && !details ? (
          <EmployeeDetailsSkeleton />
        ) : details && employee ? (
          <EmployeeRecord
            details={details}
            canOverride={canOverride}
            loading={loading}
            onOverride={setOverriding}
          />
        ) : null}
      </Drawer>
      {/* The override is a SIBLING of the drawer, not a child of it: nesting a
          dialog inside the panel would make Escape and the backdrop close both
          surfaces at once, and would leave the correction trapped in a panel the
          user can no longer see. It is mounted only while a day is being
          corrected, so its draft is always seeded from the day on screen, and it
          re-reads the payload afterwards — the corrected pair AND the period
          figures that depend on it (worked hours, attendance days) all change
          together. */}
      {overriding ? (
        <AttendanceOverrideDialog
          day={overriding}
          onClose={() => setOverriding(null)}
          onSaved={() => {
            load()
            onOverridden()
          }}
        />
      ) : null}
    </>
  )
}

/**
 * The day-by-day attendance record.
 *
 * A PRESENT day is a punch pair and a worked duration; anything else is just
 * its state, and saying so is more honest than showing an empty shift. An open
 * day — present, not yet checked out — has no duration yet, so it says "open"
 * rather than showing zero, which would read as a day nobody worked.
 *
 * The correction is offered only where it can apply: a PRESENT day is the only
 * one with a punch pair to correct, so an absence or a leave never shows it.
 */
function AttendanceTimeline({
  days,
  employeeName,
  canOverride,
  onOverride,
}: Readonly<{
  days: readonly AttendanceDay[]
  employeeName: string
  canOverride: boolean
  onOverride: (day: AttendanceDay) => void
}>) {
  const { t } = useTranslation()
  if (days.length === 0) {
    return (
      <p className="text-caption text-foreground-subtle">{t('employees.drawer.noAttendance')}</p>
    )
  }
  return (
    <ul className="flex flex-col">
      {days.map((day) => (
        <li
          key={day.id}
          className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border-subtle py-2 last:border-0"
        >
          <div className="flex min-w-0 flex-col">
            <DisplayDate value={day.business_date} />
            {/* The recorder's name is the point for a wash worker: they have no
                login, so this is the only trace of who marked them in. */}
            <span className="text-caption text-foreground-subtle">
              {t('employees.drawer.recordedBy', { name: day.recorded_by_name })}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {day.state !== 'PRESENT' ? (
              <Badge variant="warning" size="sm" dot>
                {t(`employees.state.${day.state}`)}
              </Badge>
            ) : (
              <>
                <span className="flex items-center gap-1 text-caption tabular-nums text-foreground-muted">
                  <DisplayTime value={day.check_in_effective_at} />
                  <ArrowLeft aria-hidden="true" className="size-3.5 shrink-0" />
                  {day.check_out_effective_at ? (
                    <DisplayTime value={day.check_out_effective_at} />
                  ) : (
                    <span className="text-foreground-faint">—</span>
                  )}
                </span>
                <span className="text-body font-bold tabular-nums text-foreground-strong">
                  {day.worked_minutes !== null
                    ? formatWorkedDuration(day.worked_minutes, t)
                    : t('employees.drawer.openDay')}
                </span>
              </>
            )}
            {canOverride && day.state === 'PRESENT' ? (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => onOverride(day)}
                aria-label={t('employees.override.action', {
                  name: employeeName,
                  date: day.business_date,
                })}
                title={t('employees.override.title')}
              >
                <CalendarClock size={16} aria-hidden />
                {t('employees.override.actionLabel')}
              </Button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * The advance history.
 *
 * A REVERSED advance keeps its amount on the record — the money left the
 * employee's balance and the ledger should still say so — and the badge is what
 * states that it no longer counts. Removing the row instead would make a
 * reversed advance indistinguishable from one that never happened.
 */
function AdvanceList({ advances }: Readonly<{ readonly advances: readonly Advance[] }>) {
  const { t } = useTranslation()
  if (advances.length === 0) {
    return <p className="text-caption text-foreground-subtle">{t('employees.drawer.noAdvances')}</p>
  }
  return (
    <ul className="flex flex-col">
      {advances.map((item) => (
        <li
          key={item.id}
          className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border-subtle py-2 last:border-0"
        >
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-body">{item.reason}</span>
            <span className="text-caption text-foreground-subtle">
              <DisplayDate value={item.advance_date} />
              {' · '}
              {t('employees.drawer.recordedBy', { name: item.created_by_name })}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {item.status === 'REVERSED' ? (
              <Badge variant="neutral" size="sm" dot>
                {t('employees.advance.reversed')}
              </Badge>
            ) : null}
            <MoneyDisplay amount={item.amount} variant="auto" />
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * The drawer's first-load placeholder.
 *
 * It reserves the geometry of the real record — a header block, a line, then the
 * taller attendance block — so the drawer does not jump when the employee
 * resolves, and it is announced as busy rather than read as empty content.
 */
function EmployeeDetailsSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      <Skeleton variant="rect" className="h-16 w-full" accessibilityLabel="" />
      <Skeleton variant="text" className="h-4 w-1/2" accessibilityLabel="" />
      <Skeleton variant="rect" className="h-32 w-full" accessibilityLabel="" />
    </div>
  )
}
