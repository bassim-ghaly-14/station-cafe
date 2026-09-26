/**
 * العملاء والسيارات — the customer workspace.
 *
 * One page serves two genuinely different jobs, and the difference is decided
 * by the BACKEND, not by this component:
 *
 *  - every authenticated role may list, search, add and read customer records;
 *  - a role the backend accepts for analytics additionally gets the KPI band
 *    and the details drawer.
 *
 * The page asks `list_customers` once and renders from `financial_visible`,
 * which the service derived from the same `MANAGER` gate that protects the
 * overview and drawer commands. So the reduced cashier view is not "the same
 * page with columns hidden": those columns are never built, and no financial
 * value was ever sent to that browser.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState } from '@/components/states'
import { Button, Card, ProgressBar, TableSkeleton } from '@/components/ui'
import { UserPlus, Users } from '@/components/ui/icon'
import { atLeast, useSession } from '@/features/auth/useSession'
import { CustomerDetailsDrawer } from './CustomerDetailsDrawer'
import { CustomerDialog, type CustomerDialogMode } from './CustomerDialog'
import { CustomerFilters } from './CustomerFilters'
import { CustomerKpiBand } from './CustomerKpiBand'
import { CustomerTable } from './CustomerTable'
import { useCustomerList, useCustomerOverview } from './useCustomerData'
import type { CustomerRow } from '@/services/customersApi'

const NO_RANGE = { from: '', to: '' }

export default function CustomersPage() {
  const { t } = useTranslation()
  const { user } = useSession()
  const [query, setQuery] = useState('')
  const [range, setRange] = useState(NO_RANGE)
  const [dialog, setDialog] = useState<CustomerDialogMode | null>(null)
  const [detailsId, setDetailsId] = useState<number | null>(null)
  const [detailsName, setDetailsName] = useState('')

  // The role decides which analytics are REQUESTED. The backend still refuses
  // anything unauthorized — this only avoids asking for what cannot be had.
  const canSeeAnalytics = atLeast(user?.role, 'MANAGER')
  const period = useMemo(() => ({ from: range.from, to: range.to }), [range.from, range.to])

  const list = useCustomerList(query, range.from, range.to)
  // The hook always runs (hook order must not depend on the role), but it only
  // issues its request when this role may have the analytics.
  const overview = useCustomerOverview(range.from, range.to, canSeeAnalytics)
  const customers = list.list?.customers ?? []
  // The payload's own flag is the last word on what may be rendered.
  const financialVisible = list.list?.financial_visible ?? false
  const searching = query.trim() !== ''

  function openDetails(customer: CustomerRow) {
    setDetailsName(customer.name)
    setDetailsId(customer.id)
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
            {t('nav.customers')}
          </h1>
          <p className="mt-0.5 text-caption text-foreground-subtle">{t('customers.subtitle')}</p>
        </div>
      </header>

      {/* The create action lives on the search row, not in the page header, so
          the toolbar reads as one command bar: find a customer, or add one. */}
      <CustomerFilters
        query={query}
        onQueryChange={setQuery}
        range={range}
        onRangeChange={setRange}
        showPeriod={canSeeAnalytics}
        onReset={resetFilters}
        actions={
          <Button onClick={() => setDialog({ kind: 'create' })}>
            <UserPlus size={16} aria-hidden />
            {t('customers.form.createTitle')}
          </Button>
        }
      />

      {/* The analytics band is mounted only for a role that may have it. */}
      {canSeeAnalytics ? (
        overview.error && !overview.overview ? (
          <ErrorState
            message={overview.error}
            onRetry={overview.reload}
            retryLabel={t('app.retry')}
          />
        ) : (
          <CustomerKpiBand overview={overview.overview} loading={overview.loading} />
        )
      ) : null}

      {/* Four distinct situations, four distinct presentations. */}
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} retryLabel={t('app.retry')} />
      ) : list.initialLoading ? (
        <TableSkeleton rows={6} columns={financialVisible ? 8 : 4} />
      ) : customers.length === 0 ? (
        <EmptyState
          title={searching ? t('customers.states.noResults') : t('customers.states.noData')}
          action={
            searching ? (
              <Button variant="outline" onClick={resetFilters}>
                {t('customers.filters.reset')}
              </Button>
            ) : (
              <Button onClick={() => setDialog({ kind: 'create' })}>
                <UserPlus size={16} aria-hidden />
                {t('customers.form.createTitle')}
              </Button>
            )
          }
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-2">
            <p className="text-caption tabular-nums" aria-live="polite">
              {t('customers.states.count', { count: customers.length })}
            </p>
            {/* A refresh keeps the rows on screen and marks the list busy, so
                typing in the search field never blanks the page. */}
            {list.refreshing ? <ProgressBar label={t('app.loading')} className="w-24" /> : null}
          </div>
          <CustomerTable
            customers={customers}
            financialVisible={financialVisible}
            onOpenDetails={openDetails}
            onEdit={(customer) => setDialog({ kind: 'edit', customer })}
            busy={list.refreshing}
          />
        </Card>
      )}

      <CustomerDialog
        mode={dialog}
        onClose={() => setDialog(null)}
        onSaved={() => {
          list.reload()
          overview.reload()
        }}
      />

      {/* Manager-level payload; a cashier never mounts this drawer, because it
          is never rendered from their table. */}
      {financialVisible ? (
        <CustomerDetailsDrawer
          customerId={detailsId}
          customerName={detailsName}
          period={period}
          onClose={() => setDetailsId(null)}
        />
      ) : null}
    </div>
  )
}
