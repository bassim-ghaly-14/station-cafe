/**
 * The roster and the four distinct situations it can be in.
 *
 *   failure   — the read failed; offer the retry, never an empty roster.
 *   loading   — the first read; the column count follows `managementVisible`,
 *               because a cashier's roster genuinely has fewer columns.
 *   no rows   — either the roster is empty, or a search excluded everything.
 *               Those are different sentences, and only the second one offers
 *               the "clear the filters" way back.
 *   the list  — the rows, with a progress bar that marks a REFRESH: the rows
 *               stay on screen so typing in the search field never blanks them.
 *
 * The permissions arrive as booleans the page already decided; this component
 * never re-derives authority.
 */
import { useTranslation } from 'react-i18next'

import { EmptyState, ErrorState } from '@/components/states'
import { Button, Card, ProgressBar, TableSkeleton } from '@/components/ui'
import { UserPlus } from '@/components/ui/icon'
import type { AttendanceAction, EmployeeRow } from '@/services/employeesApi'

import { EmployeeTable } from './EmployeeTable'

export function EmployeeRosterSection({
  error,
  onRetry,
  initialLoading,
  refreshing,
  employees,
  managementVisible,
  canDelete,
  canCreate,
  searching,
  onResetFilters,
  onCreate,
  onOpenDetails,
  onEdit,
  onRecord,
  onToggleStatus,
  onDelete,
}: {
  readonly error: string | null
  readonly onRetry: () => void
  readonly initialLoading: boolean
  /** A refresh in flight: the rows stay, marked busy. */
  readonly refreshing: boolean
  readonly employees: EmployeeRow[]
  /** The payload's own flag: whether this role receives the management surface. */
  readonly managementVisible: boolean
  readonly canDelete: boolean
  /** Whether the empty roster may offer the create action. */
  readonly canCreate: boolean
  readonly searching: boolean
  readonly onResetFilters: () => void
  readonly onCreate: () => void
  readonly onOpenDetails: (employee: EmployeeRow) => void
  readonly onEdit: (employee: EmployeeRow) => void
  readonly onRecord: (employee: EmployeeRow, action: AttendanceAction) => void
  readonly onToggleStatus: (employee: EmployeeRow) => void
  readonly onDelete: (employee: EmployeeRow) => void
}) {
  const { t } = useTranslation()

  // The heading and its count wrap EVERY state below, including failure and
  // loading, so the section is identified even when it has no rows to show. A
  // heading that vanishes with its rows is a heading a screen reader loses.
  const heading = (
    <div className="flex items-baseline justify-between gap-3">
      <h2 id="employee-staff-title" className="text-base font-bold text-foreground-strong">
        {t('employees.staffSection')}
      </h2>
      {/* The count is the STAFF count only — management lives in its own section
          above, so the two can never quote the same number for different sets. */}
      <p className="text-caption tabular-nums text-foreground-subtle" aria-live="polite">
        {t('employees.states.count', { count: employees.length })}
      </p>
    </div>
  )

  if (error) {
    return (
      <section aria-labelledby="employee-staff-title" className="flex flex-col gap-2">
        {heading}
        <ErrorState message={error} onRetry={onRetry} retryLabel={t('app.retry')} />
      </section>
    )
  }

  if (initialLoading) {
    return (
      <section
        aria-labelledby="employee-staff-title"
        data-testid="employee-staff-section"
        className="flex flex-col gap-2"
      >
        {heading}
        <TableSkeleton rows={6} columns={managementVisible ? 8 : 6} />
      </section>
    )
  }

  if (employees.length === 0) {
    return (
      <section
        aria-labelledby="employee-staff-title"
        data-testid="employee-staff-section"
        className="flex flex-col gap-2"
      >
        {heading}
        <EmptyState
          title={searching ? t('employees.states.noResults') : t('employees.states.noData')}
          action={
            searching ? (
              <Button variant="outline" onClick={onResetFilters}>
                {t('employees.filters.reset')}
              </Button>
            ) : canCreate ? (
              <Button onClick={onCreate}>
                <UserPlus size={18} aria-hidden />
                {t('employees.form.createTitle')}
              </Button>
            ) : null
          }
        />
      </section>
    )
  }

  return (
    <section
      aria-labelledby="employee-staff-title"
      data-testid="employee-staff-section"
      className="flex flex-col gap-2"
    >
      {heading}

      <Card className="overflow-hidden p-0">
        {/* A refresh keeps the rows on screen and marks the list busy, so typing
            in the search field never blanks the page. */}
        {refreshing ? (
          <div className="flex items-center justify-end gap-3 border-b border-border-subtle px-3 py-2">
            <ProgressBar label={t('app.loading')} className="w-24" />
          </div>
        ) : null}
        <EmployeeTable
          employees={employees}
          managementVisible={managementVisible}
          canDelete={canDelete}
          onOpenDetails={onOpenDetails}
          onEdit={onEdit}
          onRecord={onRecord}
          onToggleStatus={onToggleStatus}
          onDelete={onDelete}
          busy={refreshing}
        />
      </Card>
    </section>
  )
}
