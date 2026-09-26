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
import { Button, Card, ProgressBar, TableSkeleton } from '@/components/ui'
import { HandCoins } from '@/components/ui/icon'
import { PrintPreviewDialog } from '@/features/pos/PrintPreviewDialog'
import { todayIso } from '@/lib/date'
import {
  salesApi,
  type SalesCashier,
  type SalesFilter,
  type SalesInvoiceRow,
  type SalesItemSort,
} from '@/services/salesApi'
import { SalesBreakdown } from './SalesBreakdown'
import { SalesFilters } from './SalesFilters'
import { SalesInvoiceTable } from './SalesInvoiceTable'
import { SalesKpiBand } from './SalesKpiBand'
import { SalesTrendChart } from './SalesTrendChart'
import { TopItemsTable } from './TopItemsTable'
import { useSalesData } from './useSalesData'

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
  const summary = data.overview?.summary ?? null
  const trend = useMemo(() => data.overview?.trend ?? [], [data.overview])
  const items = useMemo(() => data.overview?.items ?? [], [data.overview])

  const narrowed =
    (filter.method ?? '') !== '' ||
    (filter.status ?? '') !== '' ||
    filter.user_id != null ||
    (filter.customer ?? '') !== ''

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
        onRefresh={data.reload}
        onReset={resetFilters}
      />

      {data.initialLoading ? (
        <TableSkeleton rows={6} columns={5} />
      ) : data.error && !data.overview ? (
        <ErrorState message={data.error} onRetry={data.reload} retryLabel={t('app.retry')} />
      ) : (
        <>
          <SalesKpiBand summary={summary} loading={data.refreshing} />

          {/* A re-fetch keeps the previous numbers on screen and marks the
              surfaces busy, so changing the period is not a full-page flash. */}
          {data.refreshing ? <ProgressBar label={t('app.loading')} /> : null}

          {summary && summary.invoices_count === 0 ? (
            <Card className="p-4">
              <EmptyState
                title={narrowed ? t('sales.states.noResults') : t('sales.states.noSales')}
                action={
                  narrowed ? (
                    <Button variant="outline" onClick={resetFilters}>
                      {t('sales.filters.reset')}
                    </Button>
                  ) : null
                }
              />
            </Card>
          ) : (
            <>
              <SalesTrendChart trend={trend} />
              {summary ? <SalesBreakdown summary={summary} /> : null}
              <TopItemsTable items={items} sort={sort} onSortChange={setSort} />
            </>
          )}

          {/* The evidence behind the numbers, always reachable. */}
          <Card className="overflow-hidden p-0">
            <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
              <div>
                <h2 className="text-section text-foreground-strong">{t('sales.invoices.title')}</h2>
                <p className="mt-0.5 text-caption text-foreground-subtle">
                  {t('sales.invoices.hint')}
                </p>
              </div>
              {data.refreshing ? <ProgressBar label={t('app.loading')} className="w-24" /> : null}
            </div>
            {data.invoices.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  title={narrowed ? t('sales.invoices.noMatch') : t('sales.invoices.empty')}
                />
              </div>
            ) : (
              <SalesInvoiceTable
                invoices={data.invoices}
                onOpen={openInvoice}
                busy={data.refreshing}
              />
            )}
          </Card>
        </>
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
