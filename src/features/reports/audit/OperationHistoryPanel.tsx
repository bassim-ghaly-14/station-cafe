import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/states'
import { Card, ProgressBar, Skeleton } from '@/components/ui'
import { useOptionalSession } from '@/features/auth/useSession'
import type { AuditEntry } from '@/services/opsApi'
import { OperationDetails } from './OperationDetails'
import { OperationEmptyState } from './OperationEmptyState'
import { OperationHistoryFilters } from './OperationHistoryFilters'
import { OperationHistoryTable } from './OperationHistoryTable'
import { canViewTechnicalDetails } from './operationPresentation'
import {
  AUDIT_WINDOW,
  filterOperations,
  NO_FILTERS,
  useOperationHistory,
  type OperationFilters,
} from './useOperationHistory'

/**
 * OperationHistoryPanel — the operations log, end to end.
 *
 * State handling is the point of this component. The log distinguishes six
 * situations that a naive list renders identically:
 *
 *   1. first load          → shaped row skeletons
 *   2. reload in flight    → existing rows stay, dimmed, with a progress hairline
 *   3. request failed      → an error with a retry, never an empty list
 *   4. log is empty        → "no operations yet"
 *   5. filters exclude all → "no matching results" with a direct reset
 *   6. populated           → the table
 *
 * (4) and (5) are the ones that matter: telling a manager "there are no
 * operations" when the truth is "your filter hid them" is how an operations
 * screen loses trust, so they are different components with different copy and
 * different actions.
 */
export function OperationHistoryPanel() {
  const { t } = useTranslation()
  const { rows, initialLoading, refreshing, error, reload } = useOperationHistory()
  const [filters, setFilters] = useState<OperationFilters>(NO_FILTERS)
  const [selected, setSelected] = useState<AuditEntry | null>(null)

  // The role decides the PRESENTATION only. `list_audit` stays MANAGER-level on
  // the backend, and the technical section is ADMIN-only here — resolved through
  // the optional session so an unresolved session renders the safe (manager)
  // form instead of flashing technical data.
  const session = useOptionalSession()
  const canViewTechnical = canViewTechnicalDetails(session?.user?.role)

  const visible = useMemo(() => filterOperations(rows, filters, t), [rows, filters, t])

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-section">{t('audit.title')}</h2>
          <p className="max-w-2xl text-pretty text-sm leading-relaxed text-foreground-muted">
            {t('audit.description')}
          </p>
        </div>
        <p className="shrink-0 text-caption tabular-nums">
          {t('audit.window', { count: AUDIT_WINDOW })}
        </p>
      </header>

      {/* The toolbar only exists once there is a log to filter. Offering search
          and type controls over an empty or failed result is clutter that
          implies the controls can do something. */}
      {!initialLoading && !error && rows.length > 0 ? (
        <OperationHistoryFilters rows={rows} filters={filters} onChange={setFilters} />
      ) : null}

      {initialLoading ? (
        <OperationRowsSkeleton />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} retryLabel={t('app.retry')} />
      ) : rows.length === 0 ? (
        <OperationEmptyState variant="no-data" />
      ) : visible.length === 0 ? (
        <OperationEmptyState
          variant="no-results"
          total={rows.length}
          onReset={() => setFilters(NO_FILTERS)}
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-2">
            <p className="text-caption tabular-nums" aria-live="polite">
              {t('audit.filters.summary', { shown: visible.length, total: rows.length })}
            </p>
            {refreshing ? <ProgressBar label={t('app.loading')} className="w-24" /> : null}
          </div>
          <OperationHistoryTable
            rows={visible}
            onOpen={setSelected}
            busy={refreshing}
            canViewTechnical={canViewTechnical}
          />
        </Card>
      )}

      {selected ? (
        <OperationDetails
          entry={selected}
          onClose={() => setSelected(null)}
          canViewTechnical={canViewTechnical}
        />
      ) : null}
    </section>
  )
}

/**
 * Row-shaped loading placeholder.
 *
 * It reserves the same geometry as the real table — a leading text column, a
 * type tile, a trailing timestamp — so the list does not jump when the log
 * resolves, and it is a single announced status rather than a screen reader
 * full of empty regions.
 */
function OperationRowsSkeleton() {
  const { t } = useTranslation()
  return (
    <div role="status" aria-busy="true" aria-label={t('app.loading')}>
      <div className="flex flex-col">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="flex items-center gap-3 border-b border-border-subtle px-3 py-3 last:border-0"
          >
            <Skeleton variant="text" className="h-4 w-2/5" accessibilityLabel="" />
            <Skeleton variant="rect" className="size-7" accessibilityLabel="" />
            <Skeleton variant="text" className="h-4 w-24" accessibilityLabel="" />
            <span className="ms-auto">
              <Skeleton variant="text" className="h-3 w-20" accessibilityLabel="" />
            </span>
          </div>
        ))}
      </div>
      <span className="sr-only">{t('app.loading')}</span>
    </div>
  )
}
