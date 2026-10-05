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
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState } from '@/components/states'
import { Button, Card, ConfirmDialog, ProgressBar, TableSkeleton, useToast } from '@/components/ui'
import { UserPlus, Users } from '@/components/ui/icon'
import { atLeast, useSession } from '@/features/auth/useSession'
import { useErrText } from '@/lib/err'
import { CustomerDetailsDrawer } from './CustomerDetailsDrawer'
import { CustomerDialog, type CustomerDialogMode } from './CustomerDialog'
import { CustomerFilters } from './CustomerFilters'
import { CustomerKpiBand } from './CustomerKpiBand'
import { CustomerTable } from './CustomerTable'
import { useCustomerList, useCustomerOverview, type CustomerOverviewState } from './useCustomerData'
import { customersApi } from '@/services/customersApi'
import type { CustomerRow } from '@/services/customersApi'

const NO_RANGE = { from: '', to: '' }

/**
 * The customer a permanent delete is pending for, or `null`.
 *
 * Nothing is executed on the click that OPENS the dialog — the click only records
 * the intent, and the request is sent from the confirm handler. A customer is a
 * financial record, so no click may ever remove one.
 */
type PendingDelete = { customer: CustomerRow } | null

/**
 * The analytics band in its two states: a failed load with nothing to show, or
 * the KPI band itself.
 *
 * An error is only shown when there is genuinely nothing to fall back on. A
 * stale overview from a previous range still renders, so a failed refresh never
 * blanks figures the user was already reading.
 */
function CustomerOverviewBand({
  overview,
}: Readonly<{ readonly overview: CustomerOverviewState }>) {
  const { t } = useTranslation()
  if (overview.error && !overview.overview) {
    return (
      <ErrorState message={overview.error} onRetry={overview.reload} retryLabel={t('app.retry')} />
    )
  }
  return (
    // The order-kind card is the tenth tile INSIDE the band's grid, so it is
    // sized like the other nine rather than taking a row of its own.
    <CustomerKpiBand overview={overview.overview} loading={overview.loading} />
  )
}

/**
 * The customer list in its four states: failed, loading, empty, and the table
 * itself. Extracted so the page reads as filters, KPIs and list, and the state
 * precedence is stated once.
 */
function CustomerListSection({
  t,
  error,
  initialLoading,
  refreshing,
  customers,
  financialVisible,
  canDelete,
  searching,
  onRetry,
  onReset,
  onCreate,
  onOpenDetails,
  onEdit,
  onDelete,
}: Readonly<{
  readonly t: TFunction
  readonly error: string | null
  readonly initialLoading: boolean
  readonly refreshing: boolean
  readonly customers: CustomerRow[]
  readonly financialVisible: boolean
  readonly canDelete: boolean
  readonly searching: boolean
  readonly onRetry: () => void
  readonly onReset: () => void
  readonly onCreate: () => void
  readonly onOpenDetails: (customer: CustomerRow) => void
  readonly onEdit: (customer: CustomerRow) => void
  readonly onDelete: (customer: CustomerRow) => void
}>) {
  if (error) {
    return <ErrorState message={error} onRetry={onRetry} retryLabel={t('app.retry')} />
  }

  if (initialLoading) {
    return <TableSkeleton rows={6} columns={financialVisible ? 8 : 4} />
  }

  if (customers.length === 0) {
    return (
      <EmptyState
        title={searching ? t('customers.states.noResults') : t('customers.states.noData')}
        action={
          searching ? (
            <Button variant="outline" onClick={onReset}>
              {t('customers.filters.reset')}
            </Button>
          ) : (
            <Button onClick={onCreate}>
              <UserPlus size={16} aria-hidden />
              {t('customers.form.createTitle')}
            </Button>
          )
        }
      />
    )
  }

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-2">
        <p className="text-caption tabular-nums" aria-live="polite">
          {t('customers.states.count', { count: customers.length })}
        </p>
        {/* A refresh keeps the rows on screen and marks the list busy, so
            typing in the search field never blanks the page. */}
        {refreshing ? <ProgressBar label={t('app.loading')} className="w-24" /> : null}
      </div>
      <CustomerTable
        customers={customers}
        financialVisible={financialVisible}
        canDelete={canDelete}
        onOpenDetails={onOpenDetails}
        onEdit={onEdit}
        onDelete={onDelete}
        busy={refreshing}
      />
    </Card>
  )
}

export default function CustomersPage() {
  const { t } = useTranslation()
  const { user } = useSession()
  const errText = useErrText(t)
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [range, setRange] = useState(NO_RANGE)
  const [dialog, setDialog] = useState<CustomerDialogMode | null>(null)
  const [detailsId, setDetailsId] = useState<number | null>(null)
  const [detailsName, setDetailsName] = useState('')
  // The single pending confirmation, plus its busy state so a slow command
  // cannot be fired twice.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null)
  const [deleting, setDeleting] = useState(false)

  // The role decides which analytics are REQUESTED. The backend still refuses
  // anything unauthorized — this only avoids asking for what cannot be had.
  const canSeeAnalytics = atLeast(user?.role, 'MANAGER')
  /**
   * Delete is narrower than analytics: only an ADMIN may permanently remove a
   * customer. This hides the affordance; the REAL boundary is the backend
   * command + service, which refuse a MANAGER or CASHIER call outright.
   */
  const canDelete = user?.role === 'ADMIN'
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

  /**
   * Permanently delete a customer. ADMIN only.
   *
   * This only records the intent: the command is sent from `confirmDelete`,
   * after the dialog has been answered. A refusal from the backend — a customer
   * with invoices or a credit balance — is reported through the existing Arabic
   * error toast and never swallowed, and the customer stays exactly where it was.
   */
  function deleteCustomer(customer: CustomerRow) {
    setPendingDelete({ customer })
  }

  /**
   * The ONLY place the delete request is sent. The dialog's state is cleared
   * before the await, so a slow command cannot leave a stale confirmation on
   * screen, and `deleting` blocks a double submit while it is in flight.
   */
  async function confirmDelete() {
    if (!pendingDelete) return
    const target = pendingDelete.customer
    setPendingDelete(null)
    setDeleting(true)
    try {
      await customersApi.remove(target.id)
      toast(t('customers.confirm.deleted', { name: target.name }), 'success')
      // The removed customer leaves the list, and the KPI band's headcount and
      // active-customer count both read the same rows.
      list.reload()
      overview.reload()
    } catch (cause) {
      toast(errText(cause), 'error')
    } finally {
      setDeleting(false)
    }
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
      {canSeeAnalytics ? <CustomerOverviewBand overview={overview} /> : null}

      {/* Four distinct situations, four distinct presentations. */}
      <CustomerListSection
        t={t}
        error={list.error}
        initialLoading={list.initialLoading}
        refreshing={list.refreshing}
        customers={customers}
        financialVisible={financialVisible}
        canDelete={canDelete}
        searching={searching}
        onRetry={list.reload}
        onReset={resetFilters}
        onCreate={() => setDialog({ kind: 'create' })}
        onOpenDetails={openDetails}
        onEdit={(customer) => setDialog({ kind: 'edit', customer })}
        onDelete={deleteCustomer}
      />

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

      {/*
        The confirmation for the one irreversible action on this page.

        It is mounted only for a role that may have the delete, and it is an
        interaction affordance rather than the boundary: a caller that invokes
        `delete_customer` directly bypasses it entirely and is refused by the
        service anyway.
      */}
      {canDelete ? (
        <ConfirmDialog
          open={pendingDelete !== null}
          onClose={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
          title={t('customers.confirm.deleteTitle')}
          body={t('customers.confirm.deleteBody', { name: pendingDelete?.customer.name ?? '' })}
          detail={t('customers.confirm.deleteDetail', {
            name: pendingDelete?.customer.name ?? '',
          })}
          confirmLabel={t('customers.confirm.deleteConfirm')}
          destructive
          busy={deleting}
        />
      ) : null}
    </div>
  )
}
