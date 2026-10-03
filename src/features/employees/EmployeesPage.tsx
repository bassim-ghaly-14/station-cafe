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
import { Button, ConfirmDialog } from '@/components/ui'
import { UserPlus, Users } from '@/components/ui/icon'
import { atLeast, useSession } from '@/features/auth/useSession'
import type { EmployeeRow } from '@/services/employeesApi'
import { EmployeeDetailsDrawer } from './EmployeeDetailsDrawer'
import { EmployeeDialog, type EmployeeDialogMode } from './EmployeeDialog'
import { EmployeeFilters } from './EmployeeFilters'
import { EmployeeManagementSection } from './EmployeeManagementSection'
import { EmployeeOverviewSection } from './EmployeeOverviewSection'
import { partitionByManagement } from './employee-role'
import { EmployeeRosterSection } from './EmployeeRosterSection'
import { MyAttendanceCard } from './MyAttendanceCard'
import { useEmployeeList, useEmployeeOverview, useMyAttendance } from './useEmployeeData'
import { usePendingEmployeeAction } from './usePendingEmployeeAction'

const NO_RANGE = { from: '', to: '' }

export default function EmployeesPage() {
  const { t } = useTranslation()
  const { user } = useSession()

  const [query, setQuery] = useState('')
  const [range, setRange] = useState(NO_RANGE)
  const [includeInactive, setIncludeInactive] = useState(false)
  const [dialog, setDialog] = useState<EmployeeDialogMode>(null)
  const [detailsId, setDetailsId] = useState<number | null>(null)
  const [detailsName, setDetailsName] = useState('')

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

  // The one list, memoized ONCE. `list.list?.employees ?? []` builds a NEW array
  // on every render while the list is still loading, and a fresh array here
  // would re-run the split below on every render and hand the table a new
  // `employees` prop — losing row identity and defeating its memoization.
  const employees = useMemo(() => list.list?.employees ?? [], [list.list])
  // The payload's own flag is the last word on what may be rendered.
  const managementVisible = list.list?.management_visible ?? false
  const searching = query.trim() !== ''

  /**
   * The ONE list, split into the two sections the page now has.
   *
   * The split is a PRESENTATION decision over data the backend already sent —
   * no second query, no second roster, and no way for the two sections to
   * disagree about who is in them. It happens BEFORE the roster is handed down,
   * so `EmployeeRosterSection` can only ever receive STAFF and WASH_WORKER rows
   * and cannot accidentally re-admit a manager.
   *
   * A cashier's list is not split: that payload carries no role information at
   * all, and hiding a section a caller may not read would be a filter rather
   * than a separation. They see the operational roster, which is the whole of
   * what they are allowed.
   */
  const { management, staff } = useMemo(
    () =>
      managementVisible ? partitionByManagement(employees) : { management: [], staff: employees },
    [employees, managementVisible],
  )

  /**
   * Every state-changing action on this page funnels through ONE confirmation,
   * so the page itself only records the intent and never sends a command.
   */
  const pendingAction = usePendingEmployeeAction({
    t,
    reloadList: list.reload,
    reloadOverview: overview.reload,
    reloadMine: mine.reload,
  })

  function openDetails(employee: EmployeeRow) {
    setDetailsName(employee.name)
    setDetailsId(employee.id)
  }

  function resetFilters() {
    setQuery('')
    setRange(NO_RANGE)
  }

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

      <EmployeeOverviewSection
        visible={canManage}
        error={overview.error}
        onRetry={overview.reload}
        overview={overview.overview}
        loading={overview.loading}
      />

      {/* Management — ADMIN and MANAGER, separated from the operational roster.
          Rendered only where the payload carries the role information to decide
          it, so this can never be a section of invented membership. */}
      {managementVisible ? (
        <EmployeeManagementSection
          employees={management}
          canDelete={canDelete}
          searching={searching}
          onOpenDetails={openDetails}
          onEdit={(employee) => setDialog({ kind: 'edit', employee })}
          onRecord={pendingAction.record}
          onToggleStatus={pendingAction.toggleStatus}
          onDelete={pendingAction.deleteEmployee}
        />
      ) : null}

      <EmployeeRosterSection
        error={list.error}
        onRetry={list.reload}
        initialLoading={list.initialLoading}
        refreshing={list.refreshing}
        employees={staff}
        managementVisible={managementVisible}
        canDelete={canDelete}
        canCreate={canManage}
        searching={searching}
        onResetFilters={resetFilters}
        onCreate={() => setDialog({ kind: 'create' })}
        onOpenDetails={openDetails}
        onEdit={(employee) => setDialog({ kind: 'edit', employee })}
        onRecord={pendingAction.record}
        onToggleStatus={pendingAction.toggleStatus}
        onDelete={pendingAction.deleteEmployee}
      />

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
        open={pendingAction.confirmation !== null}
        onClose={pendingAction.closePending}
        onConfirm={pendingAction.confirmPending}
        title={pendingAction.confirmation?.title ?? ''}
        body={pendingAction.confirmation?.body ?? ''}
        detail={pendingAction.confirmation?.detail}
        destructive={pendingAction.confirmation?.destructive ?? false}
        confirmLabel={pendingAction.confirmation?.confirmLabel}
        busy={pendingAction.pendingBusy}
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
          canDeduct={canManage}
          onClose={() => setDetailsId(null)}
          onOverridden={() => {
            // The roster's today-column, the KPI band and the manager's own
            // panel all read attendance, so a correction refreshes all three.
            list.reload()
            overview.reload()
            mine.reload()
          }}
          onDeducted={() => {
            // A deduction changes the employee's salary figures only. The expense
            // pages are deliberately NOT reloaded: a deduction is not an expense.
            list.reload()
            overview.reload()
          }}
        />
      ) : null}
    </div>
  )
}
