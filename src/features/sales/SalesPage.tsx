/**
 * المبيعات — the sales management page.
 *
 * This page REPLACES the two sales tabs Reports used to carry ("مبيعات اليوم"
 * and "مبيعات الأصناف"). It is the single source of truth for the manager's
 * sales overview, and it owns no business logic of its own:
 *
 *  - every number is an aggregate the backend computed in SQL
 *    (`sales_overview`), so the KPIs, the trend, the item analysis and the
 *    invoice list always describe the SAME set of invoices;
 *  - the one period control at the top scopes the entire page — there is no
 *    second date filter hiding inside a section;
 *  - the drill-down reuses the shared `PrintPreviewDialog`, so there is no
 *    second invoice-detail implementation.
 *
 * Reading order is deliberate: the headline revenue first, then its shape over
 * time, then how it was taken and where it came from, then the transactions
 * behind it. Money, movement, composition, evidence.
 *
 * Authorization: the navigation entry is MANAGER+ and every command behind this
 * page enforces the same `MANAGER` gate in the service layer. Hiding the route
 * is presentation, not the control.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState } from '@/components/states'
import { Button, Card, ProgressBar, Skeleton, TableSkeleton } from '@/components/ui'
import { HandCoins } from '@/components/ui/icon'
import { PrintPreviewDialog } from '@/features/pos/PrintPreviewDialog'
import { formatDate, todayIso } from '@/lib/date'
import {
  salesApi,
  type SalesCashier,
  type SalesDayRow,
  type SalesFilter,
  type SalesInvoiceRow,
  type SalesItemRow,
  type SalesItemSort,
  type SalesSummary,
} from '@/services/salesApi'
import { SalesBreakdown } from './SalesBreakdown'
import { SalesFilters } from './SalesFilters'
import { SalesInvoiceTable } from './SalesInvoiceTable'
import { SalesKpiBand } from './SalesKpiBand'
import { SalesDailyChart } from './SalesDailyChart'
import { SalesTargetProgress } from './SalesTargetProgress'
import { TopItemsTable } from './TopItemsTable'
import { useSalesData, type SalesDataState } from './useSalesData'
import { useTargetProgress, type TargetProgressState } from './useTargetProgress'

const RANGE_KEY = 'station.sales.dateRange'

/**
 * The default period. Management opens this page to answer "how are we doing",
 * so it opens on TODAY — the same business day the POS and the closing screens
 * talk about — and remembers the last explicit choice, like the reports page.
 */
function initialFilter(): SalesFilter {
  const today = todayIso()
  try {
    const stored = localStorage.getItem(RANGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as { from?: unknown; to?: unknown }
      return {
        from: typeof parsed.from === 'string' ? parsed.from : today,
        to: typeof parsed.to === 'string' ? parsed.to : today,
        method: '',
        status: '',
        user_id: null,
        customer: '',
      }
    }
  } catch {
    /* fall back to today */
  }
  return { from: today, to: today, method: '', status: '', user_id: null, customer: '' }
}

export default function SalesPage() {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<SalesFilter>(initialFilter)
  const [sort, setSort] = useState<SalesItemSort>('revenue')
  const [cashiers, setCashiers] = useState<SalesCashier[]>([])
  const [previewId, setPreviewId] = useState<number | null>(null)

  // Only the PERIOD is remembered; the narrowing controls are per-visit.
  useEffect(() => {
    localStorage.setItem(RANGE_KEY, JSON.stringify({ from: filter.from, to: filter.to }))
  }, [filter.from, filter.to])

  // The cashier options are a one-off read for the filter panel, not part of
  // the dataset: they do not change when the period does.
  useEffect(() => {
    let active = true
    salesApi
      .cashiers()
      .then((rows) => {
        if (active) setCashiers(rows)
      })
      .catch(() => {
        /* The filter still works without the names; the id is what matters. */
      })
    return () => {
      active = false
    }
  }, [])

  const data = useSalesData(filter, sort)
  // The target section is deliberately a SEPARATE read: a monthly target is a
  // statement about the month being traded in, so it follows the backend clock
  // and is never sliced by the page's date picker. `data.revision`-style
  // refreshing is not reused here — the hook re-reads on its own explicit reload,
  // which the Sales refresh button drives.
  const targets = useTargetProgress()
  // The two reload callbacks are destructured so the refresh handler depends on
  // the FUNCTIONS rather than on the state objects that change identity on every
  // render.
  const { reload: reloadSales } = data
  const { reload: reloadTargets } = targets
  const summary = data.overview?.summary ?? null
  const trend = useMemo(() => data.overview?.trend ?? [], [data.overview])
  const items = useMemo(() => data.overview?.items ?? [], [data.overview])

  const narrowed =
    (filter.method ?? '') !== '' ||
    (filter.status ?? '') !== '' ||
    filter.user_id != null ||
    (filter.customer ?? '') !== ''
  // The period the chart states on its card and prints in its export: the SAME
  // `from`/`to` the overview was read with, formatted by the central formatter, so
  // the chart can never describe a different window than the KPIs above it.
  const period = `${formatDate(filter.from)} — ${formatDate(filter.to)}`

  // One refresh drives BOTH reads. The target progress follows the backend's
  // current month rather than the picker, but it must still move when a sale is
  // recorded — so the page's single refresh button re-reads it alongside the
  // filtered data, rather than leaving a stale month on screen.
  const refresh = useCallback(() => {
    reloadSales()
    reloadTargets()
  }, [reloadSales, reloadTargets])

  const resetFilters = useCallback(() => {
    setFilter((current) => ({ ...current, method: '', status: '', user_id: null, customer: '' }))
  }, [])

  const openInvoice = useCallback((invoice: SalesInvoiceRow) => setPreviewId(invoice.id), [])

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-heading flex items-center gap-2">
            <HandCoins size={22} aria-hidden />
            {t('nav.sales')}
          </h1>
          <p className="mt-0.5 text-caption text-foreground-subtle">{t('sales.subtitle')}</p>
        </div>
      </header>

      {/* The period scopes the whole page; the narrowing controls are opt-in. */}
      <SalesFilters
        filter={filter}
        onChange={setFilter}
        cashiers={cashiers}
        refreshing={data.refreshing}
        onRefresh={refresh}
        onReset={resetFilters}
      />

      {data.initialLoading ? (
        <TableSkeleton rows={6} columns={5} />
      ) : data.error && !data.overview ? (
        <ErrorState message={data.error} onRetry={data.reload} retryLabel={t('app.retry')} />
      ) : (
        <SalesResults
          data={data}
          summary={summary}
          trend={trend}
          items={items}
          sort={sort}
          onSortChange={setSort}
          period={period}
          narrowed={narrowed}
          onResetFilters={resetFilters}
          onOpenInvoice={openInvoice}
          targets={targets}
          onRefreshTargets={targets.reload}
        />
      )}

      {/* The EXISTING preview mechanism — same dialog as the POS and Reports. */}
      {previewId !== null ? (
        <PrintPreviewDialog
          target={{ kind: 'invoice', invoice_id: previewId }}
          onClose={() => setPreviewId(null)}
        />
      ) : null}
    </div>
  )
}

/**
 * Everything below the filters, once the page has data to show.
 *
 * Two independent things live here and are deliberately not confused:
 *
 *  - the ANALYSIS (KPIs, trend, breakdown, top items) collapses to a single
 *    empty state when the period contains no invoices at all, offering a reset
 *    ONLY when the user narrowed the page — "there were no sales" and "your
 *    filter hid them" must not read the same;
 *  - the EVIDENCE (the invoice list) is always reachable, and has its own empty
 *    state for the same reason.
 *
 * A refresh is neither: it keeps the previous numbers on screen and marks the
 * surfaces busy, so changing the period is never a full-page flash.
 */
function SalesResults({
  data,
  summary,
  trend,
  items,
  sort,
  onSortChange,
  period,
  narrowed,
  onResetFilters,
  onOpenInvoice,
  targets,
  onRefreshTargets,
}: Readonly<{
  data: SalesDataState
  summary: SalesSummary | null
  trend: SalesDayRow[]
  items: SalesItemRow[]
  sort: SalesItemSort
  onSortChange: (sort: SalesItemSort) => void
  period: string
  narrowed: boolean
  onResetFilters: () => void
  onOpenInvoice: (invoice: SalesInvoiceRow) => void
  /** The month-at-a-glance target section: its own read, its own refresh. */
  targets: TargetProgressState
  onRefreshTargets: () => void
}>) {
  const { t } = useTranslation()

  return (
    <>
      {/* The month's target progress comes FIRST: it is the question the owner
          opens this page with, and it is about the whole month rather than the
          period the filters above happen to be showing. */}
      <SalesTargetSection targets={targets} onRefresh={onRefreshTargets} />

      <SalesKpiBand summary={summary} loading={data.refreshing} />

      {data.refreshing ? <ProgressBar label={t('app.loading')} /> : null}

      <SalesContentSection
        summary={summary}
        trend={trend}
        items={items}
        sort={sort}
        onSortChange={onSortChange}
        period={period}
        narrowed={narrowed}
        onResetFilters={onResetFilters}
      />

      {/* The evidence behind the numbers, always reachable. */}
      <SalesInvoicesSection
        invoices={data.invoices}
        refreshing={data.refreshing}
        narrowed={narrowed}
        onOpen={onOpenInvoice}
      />
    </>
  )
}

/**
 * The month-at-a-glance target block, in strict priority order: a failure with
 * nothing to show retries, a first read shows a skeleton, a read that produced a
 * figure shows the progress card, and a read that produced neither shows nothing
 * at all rather than an empty frame.
 */
function SalesTargetSection({
  targets,
  onRefresh,
}: Readonly<{ targets: TargetProgressState; onRefresh: () => void }>) {
  const { t } = useTranslation()

  if (targets.error && !targets.progress) {
    return (
      <Card className="p-4">
        <ErrorState message={targets.error} onRetry={onRefresh} retryLabel={t('app.retry')} />
      </Card>
    )
  }
  if (targets.initialLoading) {
    return (
      <Card>
        <Skeleton variant="text" className="h-4 w-48" accessibilityLabel="" />
      </Card>
    )
  }
  if (targets.progress) return <SalesTargetProgress progress={targets.progress} />
  return null
}

/**
 * The ANALYSIS: the trend, the optional breakdown and the top items — or the one
 * empty state that stands in for all of them, offering a reset ONLY when the
 * user narrowed the page, because "there were no sales" and "your filter hid
 * them" must not read the same.
 */
function SalesContentSection({
  summary,
  trend,
  items,
  sort,
  onSortChange,
  period,
  narrowed,
  onResetFilters,
}: Readonly<{
  summary: SalesSummary | null
  trend: SalesDayRow[]
  items: SalesItemRow[]
  sort: SalesItemSort
  onSortChange: (sort: SalesItemSort) => void
  period: string
  narrowed: boolean
  onResetFilters: () => void
}>) {
  const { t } = useTranslation()

  if (summary?.invoices_count === 0) {
    return (
      <Card className="p-4">
        <EmptyState
          title={narrowed ? t('sales.states.noResults') : t('sales.states.noSales')}
          action={
            narrowed ? (
              <Button variant="outline" onClick={onResetFilters}>
                {t('sales.filters.reset')}
              </Button>
            ) : null
          }
        />
      </Card>
    )
  }
  return (
    <>
      <SalesDailyChart trend={trend} period={period} />
      {summary ? <SalesBreakdown summary={summary} /> : null}
      <TopItemsTable items={items} sort={sort} onSortChange={onSortChange} />
    </>
  )
}

/**
 * The EVIDENCE: the invoice list behind every figure above, with its own header
 * and its own empty state, so a period with no invoices still explains itself.
 */
function SalesInvoicesSection({
  invoices,
  refreshing,
  narrowed,
  onOpen,
}: Readonly<{
  invoices: SalesInvoiceRow[]
  refreshing: boolean
  narrowed: boolean
  onOpen: (invoice: SalesInvoiceRow) => void
}>) {
  const { t } = useTranslation()

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <div>
          <h2 className="text-section text-foreground-strong">{t('sales.invoices.title')}</h2>
          <p className="mt-0.5 text-caption text-foreground-subtle">{t('sales.invoices.hint')}</p>
        </div>
        {refreshing ? <ProgressBar label={t('app.loading')} className="w-24" /> : null}
      </div>
      {invoices.length === 0 ? (
        <div className="p-4">
          <EmptyState title={narrowed ? t('sales.invoices.noMatch') : t('sales.invoices.empty')} />
        </div>
      ) : (
        <SalesInvoiceTable invoices={invoices} onOpen={onOpen} busy={refreshing} />
      )}
    </Card>
  )
}
