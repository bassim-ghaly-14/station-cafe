/**
 * فواتير اليوم — the day's invoice operations PAGE.
 *
 * A first-class Station page, not a dialog: filters, a long invoice list,
 * per-row preview/print actions and loading/empty/error states were too much
 * to own inside a modal, and a dialog also trapped the cashier in a nested
 * preview window.
 *
 * It adds layout and navigation ONLY. The invoice data, the filters and the
 * per-row actions come from the same commands the POS already uses
 * (`search_invoices`, `preview_invoice`, `print_invoice`), and the preview
 * opens through the SAME shared `PrintPreviewDialog` as every other preview
 * entry point — there is no parallel implementation here.
 *
 * Page composition:
 *   1. header — identity, the real shape of the listed set, the way back;
 *   2. toolbar — LIVE search plus the two filters the backend can answer;
 *   3. records — a dense table on wide screens, stacked records on narrow ones;
 *   4. print preview, opened through the shared dialog.
 *
 * There is deliberately no "بحث" button. Search runs as the user types (see
 * `useInvoiceList`), so a submit control could only repeat a query the screen
 * has already issued.
 */
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, MoneyDisplay, ProgressBar, Skeleton, useToast } from '@/components/ui'
import { ArrowRight, Receipt } from '@/components/ui/icon'
import { ErrorState } from '@/components/states'
import { useRouter } from '@/app/router'
import { api, type InvoiceRow } from '@/services/posApi'
import { sumAmounts } from '@/lib/utils'
import { PrintPreviewDialog } from './PrintPreviewDialog'
import { InvoiceEmptyState } from './InvoiceEmptyState'
import { InvoiceFilters } from './InvoiceFilters'
import { InvoiceList } from './InvoiceList'
import { useInvoiceList, type InvoiceListQuery } from './useInvoiceList'

const NO_FILTERS: InvoiceListQuery = { search: '', status: '', method: '' }

export function TodayInvoicesPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const { navigate } = useRouter()
  const [filters, setFilters] = useState<InvoiceListQuery>(NO_FILTERS)
  // Print preview of a persisted invoice — same document as the reprint below.
  const [previewId, setPreviewId] = useState<number | null>(null)

  const { rows, dayId, initialLoading, refreshing, error, reload } = useInvoiceList(filters)

  const filtered = filters.search.trim() !== '' || filters.status !== '' || filters.method !== ''

  /**
   * Contextual summary of exactly the rows listed below. Derived from the rows
   * already in memory — a presentation of the list, never a second query and
   * never a second financial rule.
   */
  const summary = useMemo(
    () => ({
      count: rows.length,
      total: sumAmounts(rows.map((r) => r.total)),
      credit: rows.filter((r) => r.status === 'CREDIT').length,
    }),
    [rows],
  )

  const reportError = useCallback(
    (e: unknown) => t([`errors.${(e as { message?: string }).message}`, 'errors.internal_error']),
    [t],
  )

  const printAgain = useCallback(
    (id: number) =>
      api
        .printInvoice(id)
        .then((o) =>
          toast(
            o.duplicate_suppressed ? t('print.duplicateSuppressed') : t('print.done'),
            'success',
          ),
        )
        .catch((e) => toast(reportError(e), 'error')),
    [toast, t, reportError],
  )

  const openPreview = (row: InvoiceRow) => setPreviewId(row.id)
  const resetFilters = () => setFilters(NO_FILTERS)

  return (
    <div className="flex flex-col gap-4">
      {/* Page header: identity, the day's shape, and the way back. */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary"
          >
            <Receipt size={20} />
          </span>
          <div className="min-w-0">
            <h1 className="text-heading">{t('pos.todayInvoices')}</h1>
            <p className="text-caption mt-1" aria-live="polite">
              {/* Only the first load reports progress; a later refresh keeps the
                  previous summary visible instead of flickering to "loading". */}
              {initialLoading && rows.length === 0
                ? t('app.loading')
                : t('invoicesPage.summary', { count: summary.count, credit: summary.credit })}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-end">
            <p className="text-caption">{t('invoicesPage.totalSales')}</p>
            <MoneyDisplay amount={summary.total} variant="auto" className="text-money font-bold" />
          </div>
          <Button variant="outline" onClick={() => navigate('pos')}>
            <ArrowRight size={16} aria-hidden />
            {t('invoicesPage.backToPos')}
          </Button>
        </div>
      </header>

      {/* Toolbar — live search plus the two filters the backend resolves. */}
      <InvoiceFilters query={filters} onChange={setFilters} onReset={resetFilters} />

      {/* The records grow with the page instead of scrolling inside a dialog.
          Four distinct situations, four distinct presentations: first load,
          refresh over existing rows, failure, and "nothing here". */}
      {error ? (
        <ErrorState message={error} onRetry={reload} retryLabel={t('app.retry')} />
      ) : initialLoading ? (
        <InvoiceRowsSkeleton />
      ) : rows.length === 0 ? (
        <InvoiceEmptyState variant={filtered ? 'no-results' : 'no-data'} onReset={resetFilters} />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-2">
            <p className="text-caption tabular-nums" aria-live="polite">
              {t('invoicesPage.resultsCount', { count: rows.length })}
            </p>
            {/* A refresh keeps the rows on screen and marks the list busy, so
                typing in the search field never blanks the page. */}
            {refreshing ? <ProgressBar label={t('app.loading')} className="w-24" /> : null}
          </div>
          <InvoiceList
            rows={rows}
            onPreview={openPreview}
            onPrint={(row) => printAgain(row.id)}
            busy={refreshing}
          />
          {dayId === null ? (
            <p className="border-t border-border-subtle px-3 py-2 text-caption">
              {t('pos.noDayHint')}
            </p>
          ) : null}
        </Card>
      )}

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
 * First-load placeholder shaped like the real record list.
 *
 * It reserves the same geometry as an invoice row — identifier block, context
 * line, a status tile and a total — so the page does not jump when the day
 * resolves, and it is one announced status rather than a screen reader full of
 * empty regions. It is invoices-specific on purpose: a generic unrelated
 * skeleton would promise a layout this page never uses.
 */
function InvoiceRowsSkeleton() {
  const { t } = useTranslation()
  return (
    <div role="status" aria-busy="true" aria-label={t('invoicesPage.loadingRecords')}>
      <Card className="overflow-hidden p-0">
        {Array.from({ length: 8 }, (_, index) => (
          <div
            key={index}
            className="flex items-center gap-3 border-b border-border-subtle px-3 py-3 last:border-0"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton variant="text" className="h-4 w-20" accessibilityLabel="" />
              <Skeleton variant="text" className="h-3 w-32" accessibilityLabel="" />
            </div>
            <Skeleton variant="text" className="h-5 w-20" accessibilityLabel="" />
            <Skeleton variant="text" className="h-4 w-24" accessibilityLabel="" />
          </div>
        ))}
      </Card>
      <span className="sr-only">{t('invoicesPage.loadingRecords')}</span>
    </div>
  )
}
