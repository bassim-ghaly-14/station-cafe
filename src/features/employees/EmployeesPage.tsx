/**
 * الموظفون — the employees workspace.
 *
 * One page serves two genuinely different jobs, and the difference is decided by
 * the BACKEND, not by this component:
 *
 *  - every authenticated role gets their OWN record and the roster, because a
 *    cashier genuinely needs the roster: to punch their own attendance and to
 *    take a colleague's. The roster a cashier receives is an ATTENDANCE OPERATION
 *    table — identity, phone, status, today's state and the four actions — with
 *    no salary, notes, login role, period analytics, revenue or performance in
 *    the payload at all;
 *  - a role the backend accepts for management additionally gets the KPI band,
 *    the salary column, the details drawer and the create/edit/status actions.
 *
 * The page asks `list_employees` once and renders from `management_visible`,
 * which the service derived from the same `MANAGER` gate that protects the
 * overview and drawer commands. So the reduced cashier view is not "the same page
 * with columns hidden": those cells are never built, and no restricted figure was
 * ever sent to that browser.
 *
 * The cashier's own attendance is mounted for EVERY role, above the roster,
 * because attendance is a property of the person and not of the permission.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState } from '@/components/states'
import { Button, Card, ConfirmDialog, ProgressBar, TableSkeleton, useToast } from '@/components/ui'
import { UserPlus, Users } from '@/components/ui/icon'
import { atLeast, useSession } from '@/features/auth/useSession'
import { useErrText } from '@/lib/err'
import { employeesApi } from '@/services/employeesApi'
import type { AttendanceAction, EmployeeRow } from '@/services/employeesApi'
import { EmployeeDetailsDrawer } from './EmployeeDetailsDrawer'
import { EmployeeDialog, type EmployeeDialogMode } from './EmployeeDialog'
import { EmployeeFilters } from './EmployeeFilters'
import { EmployeeKpiBand } from './EmployeeKpiBand'
import { EmployeeTable } from './EmployeeTable'
import { MyAttendanceCard } from './MyAttendanceCard'
import { useEmployeeList, useEmployeeOverview, useMyAttendance } from './useEmployeeData'

const NO_RANGE = { from: '', to: '' }

/**
 * The action a confirmation is pending for, or `null` when nothing is pending.
 *
 * Nothing is executed on the click that OPENS the dialog — the click only records
 * the intent, and the request is sent from the confirm handler. That is the whole
 * point: an attendance day and an employment status are both facts other people
 * are paid from, so neither may change from a single click.
 */
type PendingAction =
  | { kind: 'attendance'; employee: EmployeeRow; action: AttendanceAction }
  | { kind: 'status'; employee: EmployeeRow; next: 'ACTIVE' | 'INACTIVE' }
  | { kind: 'delete'; employee: EmployeeRow }
  | null

export default function EmployeesPage() {
  const { t } = useTranslation()
  const { user } = useSession()
  const errText = useErrText(t)
  const toast = useToast()

  const [query, setQuery] = useState('')
  const [range, setRange] = useState(NO_RANGE)
  const [includeInactive, setIncludeInactive] = useState(false)
  const [dialog, setDialog] = useState<EmployeeDialogMode>(null)
  const [detailsId, setDetailsId] = useState<number | null>(null)
  const [detailsName, setDetailsName] = useState('')
  // The single pending confirmation. While it is set, no other action may start.
  const [pending, setPending] = useState<PendingAction>(null)
  const [pendingBusy, setPendingBusy] = useState(false)

  // The role decides which analytics are REQUESTED. The backend still refuses
  // anything unauthorized — this only avoids asking for what cannot be had.
  const canManage = atLeast(user?.role, 'MANAGER')
  /**
   * Delete is narrower than manage: only an ADMIN may permanently remove an
   * employee. This hides the affordance; the REAL boundary is the backend
   * command + service, which reject a MANAGER or CASHIER call with an
   * authorization error even if the button were somehow triggered.
   */
  const canDelete = user?.role === 'ADMIN'
  const period = useMemo(() => ({ from: range.from, to: range.to }), [range.from, range.to])

  const list = useEmployeeList(query, range.from, range.to, includeInactive)
  // The hook always runs (hook order must not depend on the role), but it only
  // issues its request when this role may have the analytics.
  const overview = useEmployeeOverview(range.from, range.to, canManage)
  const mine = useMyAttendance()

  const employees = list.list?.employees ?? []
  // The payload's own flag is the last word on what may be rendered.
  const managementVisible = list.list?.management_visible ?? false
  const searching = query.trim() !== ''

  function openDetails(employee: EmployeeRow) {
    setDetailsName(employee.name)
    setDetailsId(employee.id)
  }

  function resetFilters() {
    setQuery('')
    setRange(NO_RANGE)
  }

  /**
   * One punch from a table row.
   *
   * This now only RECORDS the intent. The command is sent from `confirmPending`,
   * after the user has answered the dialog — an attendance day is a fact other
   * people are paid from, so it never changes from a single click.
   */
  function record(employee: EmployeeRow, action: AttendanceAction) {
    setPending({ kind: 'attendance', employee, action })
  }

  /**
   * Permanently delete an employee. ADMIN only.
   *
   * Like every other action here this only RECORDS the intent: the request is
   * sent from `confirmPending`, after the confirmation has been answered. The
   * confirmation states that the action is permanent, because it is — the
   * backend removes the row rather than archiving it, and refuses outright for
   * anyone whose attendance, advances or payroll history would be destroyed.
   */
  function deleteEmployee(employee: EmployeeRow) {
    setPending({ kind: 'delete', employee })
  }

  /**
   * Stop or restart an employee. This is the deactivated / reactivated action
   * the old staff screen offered, restored on the canonical surface: the record
   * and its whole history are kept, and the backend suspends the person's login
   * in the same transaction so a stopped employee can no longer sign in.
   *
   * This is the REVERSIBLE answer and remains the right one for anybody with
   * history: the record and everything it references are kept. Permanent
   * deletion (ADMIN only, above) is reserved for a record with no history at
   * all — a duplicate or a mistyped entry that was never used — and is refused
   * by the backend whenever removing the person would cost a historical row.
   */
  function toggleStatus(employee: EmployeeRow) {
    setPending({
      kind: 'status',
      employee,
      next: employee.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
    })
  }

  /**
   * The ONLY place a pending action is actually executed.
   *
   * Ordering matters: the dialog closes first and the dialog's state is cleared
   * before the await, so a slow command cannot leave a stale confirmation on
   * screen. A refusal is reported through the existing toast and never swallowed.
   */
  async function confirmPending() {
    if (!pending) return
    const target = pending
    setPending(null)
    setPendingBusy(true)
    try {
      if (target.kind === 'attendance') {
        await employeesApi.recordAttendance(target.employee.id, target.action)
        toast(t('employees.attendance.saved'), 'success')
        // Both the roster and the personal panel change on a punch.
        list.reload()
        mine.reload()
      } else if (target.kind === 'delete') {
        await employeesApi.remove(target.employee.id)
        toast(t('employees.status.deleted', { name: target.employee.name }), 'success')
        // The roster, the KPI band's headcount and the personal attendance panel
        // all read employees, so all three are refreshed.
        list.reload()
        overview.reload()
        mine.reload()
      } else {
        await employeesApi.setStatus(target.employee.id, target.next)
        toast(t(`employees.status.saved.${target.next}`), 'success')
        list.reload()
      }
    } catch (cause) {
      toast(errText(cause), 'error')
    } finally {
      setPendingBusy(false)
    }
  }

  /**
   * The confirmation COPY for the pending action, derived rather than stored.
   *
   * Deriving it means a pending action can never show one sentence and execute
   * another: the body, the consequence line and the request all come from the
   * same `pending` value.
   */
  const confirmation = useMemo(() => {
    if (!pending) return null
    if (pending.kind === 'delete') {
      // The most dangerous action on the page, so it gets its own title, an
      // explicit "permanent" warning, and the only confirm label that says so.
      return {
        title: t('employees.confirm.deleteTitle'),
        body: t('employees.confirm.deleteBody', { name: pending.employee.name }),
        detail: t('employees.confirm.deleteDetail', { name: pending.employee.name }),
        confirmLabel: t('employees.confirm.deleteConfirm'),
        destructive: true,
      }
    }
    if (pending.kind === 'status') {
      const stopping = pending.next === 'INACTIVE'
      return {
        title: t('employees.confirm.title'),
        body: t(stopping ? 'employees.confirm.deactivate' : 'employees.confirm.activate', {
          name: pending.employee.name,
        }),
        // A stop is the sensitive direction, so it states the consequence and is
        // the only one rendered with a destructive confirm button.
        detail: t(
          stopping ? 'employees.confirm.deactivateDetail' : 'employees.confirm.activateDetail',
          { name: pending.employee.name },
        ),
        destructive: stopping,
      }
    }
    const { employee, action } = pending
    const key = {
      CHECK_IN: 'checkIn',
      CHECK_OUT: 'checkOut',
      ABSENT: 'absent',
      LEAVE: 'leave',
    }[action] as 'checkIn' | 'checkOut' | 'absent' | 'leave'
    return {
      title: t('employees.confirm.title'),
      body: t(`employees.confirm.${key}`, { name: employee.name }),
      // The two punches are a moment and need no warning; absence and leave
      // close the whole day, which is the irreversible half of this surface.
      detail:
        action === 'ABSENT'
          ? t('employees.confirm.absentDetail')
          : action === 'LEAVE'
            ? t('employees.confirm.leaveDetail')
            : t('employees.confirm.roundingHint'),
      destructive: false,
    }
  }, [pending, t])

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-heading flex items-center gap-2">
            <Users size={22} aria-hidden />
            {t('nav.employees')}
          </h1>
          <p className="mt-0.5 text-caption text-foreground-subtle">{t('employees.subtitle')}</p>
        </div>
      </header>

      {/* The cashier's own attendance: the page's reason to exist for a STAFF. */}
      <MyAttendanceCard
        mine={mine.mine}
        loading={mine.loading}
        error={mine.error}
        onRetry={mine.reload}
        onRecorded={() => {
          list.reload()
          mine.reload()
        }}
      />

      {/* The create action lives on the search row, not in the page header, so
          the toolbar reads as one command bar: find an employee, or add one. */}
      <EmployeeFilters
        query={query}
        onQueryChange={setQuery}
        range={range}
        onRangeChange={setRange}
        includeInactive={includeInactive}
        onIncludeInactiveChange={setIncludeInactive}
        onReset={resetFilters}
        actions={
          canManage ? (
            <Button onClick={() => setDialog({ kind: 'create' })}>
              <UserPlus size={18} aria-hidden />
              {t('employees.form.createTitle')}
            </Button>
          ) : null
        }
      />

      {/* The analytics band is mounted only for a role that may have it. */}
      {canManage ? (
        overview.error && !overview.overview ? (
          <ErrorState
            message={overview.error}
            onRetry={overview.reload}
            retryLabel={t('app.retry')}
          />
        ) : (
          <EmployeeKpiBand overview={overview.overview} loading={overview.loading} />
        )
      ) : null}

      {/* Four distinct situations, four distinct presentations. */}
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} retryLabel={t('app.retry')} />
      ) : list.initialLoading ? (
        <TableSkeleton rows={6} columns={managementVisible ? 8 : 6} />
      ) : employees.length === 0 ? (
        <EmptyState
          title={searching ? t('employees.states.noResults') : t('employees.states.noData')}
          action={
            searching ? (
              <Button variant="outline" onClick={resetFilters}>
                {t('employees.filters.reset')}
              </Button>
            ) : canManage ? (
              <Button onClick={() => setDialog({ kind: 'create' })}>
                <UserPlus size={18} aria-hidden />
                {t('employees.form.createTitle')}
              </Button>
            ) : null
          }
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-2">
            <p className="text-caption tabular-nums" aria-live="polite">
              {t('employees.states.count', { count: employees.length })}
            </p>
            {/* A refresh keeps the rows on screen and marks the list busy, so
                typing in the search field never blanks the page. */}
            {list.refreshing ? <ProgressBar label={t('app.loading')} className="w-24" /> : null}
          </div>
          <EmployeeTable
            employees={employees}
            managementVisible={managementVisible}
            canDelete={canDelete}
            onOpenDetails={openDetails}
            onEdit={(employee) => setDialog({ kind: 'edit', employee })}
            onRecord={record}
            onToggleStatus={toggleStatus}
            onDelete={deleteEmployee}
            busy={list.refreshing}
          />
        </Card>
      )}

      <EmployeeDialog
        mode={dialog}
        onClose={() => setDialog(null)}
        onSaved={() => {
          list.reload()
          overview.reload()
        }}
      />

      {/*
        The single gate for every state-changing action on this page.

        It is mounted for every role ON PURPOSE: a cashier is offered exactly the
        attendance operations they are allowed, and each of those is confirmed
        with the same dialog. This is an interaction affordance only — the
        service re-checks authority on every command, and invoking
        `record_attendance` directly bypasses this dialog completely, which is
        exactly why the backend check is the real boundary.
      */}
      <ConfirmDialog
        open={confirmation !== null}
        onClose={() => setPending(null)}
        onConfirm={confirmPending}
        title={confirmation?.title ?? ''}
        body={confirmation?.body ?? ''}
        detail={confirmation?.detail}
        destructive={confirmation?.destructive ?? false}
        confirmLabel={confirmation?.confirmLabel}
        busy={pendingBusy}
      />

      {/* Manager-level payload; a cashier never mounts this drawer, because it is
          never rendered from their table. */}
      {managementVisible ? (
        <EmployeeDetailsDrawer
          employeeId={detailsId}
          employeeName={detailsName}
          period={period}
          // The override rewrites a recorded time, so it follows the SESSION's
          // role rather than the payload's flag. The backend enforces the same
          // rule on every command regardless of what this decides.
          canOverride={canManage}
          onClose={() => setDetailsId(null)}
          onOverridden={() => {
            // The roster's today-column, the KPI band and the manager's own
            // panel all read attendance, so a correction refreshes all three.
            list.reload()
            overview.reload()
            mine.reload()
          }}
        />
      ) : null}
    </div>
  )
}
