/**
 * تذاكر المغسلة اليوم — the day's wash tickets PAGE.
 *
 * The twin of فواتير اليوم, and deliberately built as its sibling rather than
 * as a copy: same routed-page shape, same header, same live toolbar, same four
 * result states, same shared `PrintPreviewDialog`, same empty state, same
 * "way back". The DATA is different and comes from its own command
 * (`list_daily_wash_tickets`), because a wash ticket is the authoritative
 * record here — the page never reconstructs tickets out of invoices.
 *
 * Page composition:
 *   1. header — identity, the real shape of the listed set, the way back;
 *   2. toolbar — live search plus the order-status filter the backend answers;
 *   3. records — a dense table on wide screens, stacked records on narrow ones;
 *   4. the ticket and its related receipt, both through the SAME shared
 *      preview dialog every other preview entry point uses.
 *
 * The related receipt is reached by the id the backend resolved through the
 * persisted `invoices.order_id` relation, so opening it is the existing invoice
 * flow and never a second invoice-detail implementation.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, MoneyDisplay, ProgressBar, Skeleton } from '@/components/ui'
import { ArrowRight, Ticket } from '@/components/ui/icon'
import { ErrorState } from '@/components/states'
import { useRouter } from '@/app/router'
import { sumAmounts } from '@/lib/utils'
import type { WashTicketRow } from '@/services/posApi'
import { PrintPreviewDialog } from './PrintPreviewDialog'
import { InvoiceEmptyState } from './InvoiceEmptyState'
import { WashTicketFilters } from './WashTicketFilters'
import { WashTicketList } from './WashTicketList'
import { useWashTicketList, type WashTicketListQuery } from './useWashTicketList'

const NO_FILTERS: WashTicketListQuery = { search: '', status: '' }

export function TodayWashTicketsPage() {
  const { t } = useTranslation()
  const { navigate } = useRouter()
  const [filters, setFilters] = useState<WashTicketListQuery>(NO_FILTERS)
  // Both previews open through the ONE shared dialog: the ticket document and
  // the receipt that belongs to it.
  const [ticketPreviewOrderId, setTicketPreviewOrderId] = useState<number | null>(null)
  const [invoicePreviewId, setInvoicePreviewId] = useState<number | null>(null)

  const { rows, dayId, initialLoading, refreshing, error, reload } = useWashTicketList(filters)

  const filtered = filters.search.trim() !== '' || filters.status !== ''

  /**
   * Contextual summary of exactly the rows listed below. Derived from the rows
   * already in memory — a presentation of the list, never a second query and
   * never a second financial rule. The money is the sum of the RELATED
   * receipts only, so a ticket that has not been invoiced yet contributes
   * nothing rather than a fabricated figure.
   */
  const summary = useMemo(
    () => ({
      count: rows.length,
      linked: rows.filter((r) => r.invoice_id !== null).length,
      total: sumAmounts(rows.map((r) => r.invoice_total ?? 0)),
    }),
    [rows],
  )

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
            <Ticket size={20} />
          </span>
          <div className="min-w-0">
            <h1 className="text-heading">{t('pos.todayWashTickets')}</h1>
            <p className="text-caption mt-1" aria-live="polite">
              {initialLoading && rows.length === 0
                ? t('app.loading')
                : t('washTicketsPage.summary', {
                    count: summary.count,
                    linked: summary.linked,
                  })}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-end">
            <p className="text-caption">{t('washTicketsPage.totalSales')}</p>
            <MoneyDisplay amount={summary.total} variant="auto" className="text-money font-bold" />
          </div>
          <Button variant="outline" onClick={() => navigate('pos')}>
            <ArrowRight size={16} aria-hidden />
            {t('washTicketsPage.backToPos')}
          </Button>
        </div>
      </header>

      {/* Toolbar — live search plus the filter the backend resolves. */}
      <WashTicketFilters query={filters} onChange={setFilters} onReset={resetFilters} />

      {/* The records grow with the page instead of scrolling inside a dialog.
          Four distinct situations, four distinct presentations: first load,
          refresh over existing rows, failure, and "nothing here". */}
      <WashTicketResults
        rows={rows}
        error={error}
        initialLoading={initialLoading}
        refreshing={refreshing}
        filtered={filtered}
        onRetry={reload}
        onResetFilters={resetFilters}
        onOpenTicket={(row: WashTicketRow) => setTicketPreviewOrderId(row.order_id)}
        onOpenInvoice={setInvoicePreviewId}
        dayId={dayId}
      />

      {ticketPreviewOrderId !== null ? (
        <PrintPreviewDialog
          target={{ kind: 'wash_ticket', order_id: ticketPreviewOrderId }}
          onClose={() => setTicketPreviewOrderId(null)}
        />
      ) : null}
      {invoicePreviewId !== null ? (
        <PrintPreviewDialog
          target={{ kind: 'invoice', invoice_id: invoicePreviewId }}
          onClose={() => setInvoicePreviewId(null)}
        />
      ) : null}
    </div>
  )
}

/**
 * The result list in the four situations the page names: failure, first load,
 * nothing to show, and the records themselves.
 *
 * Failure is checked before loading, so a failed first load is reported rather
 * than spinning forever. A refresh is NOT one of these states: it keeps the
 * rows on screen and marks the list busy, so typing in the search field never
 * blanks the page. "Nothing here" distinguishes itself from "your filter hid
 * them" through the `filtered` flag — and an empty day is a normal answer,
 * never an error.
 */
function WashTicketResults({
  rows,
  error,
  initialLoading,
  refreshing,
  filtered,
  onRetry,
  onResetFilters,
  onOpenTicket,
  onOpenInvoice,
  dayId,
}: Readonly<{
  rows: readonly WashTicketRow[]
  error: string | null
  initialLoading: boolean
  refreshing: boolean
  filtered: boolean
  onRetry: () => void
  onResetFilters: () => void
  onOpenTicket: (ticket: WashTicketRow) => void
  onOpenInvoice: (invoiceId: number) => void
  dayId: number | null
}>) {
  const { t } = useTranslation()
  if (error) return <ErrorState message={error} onRetry={onRetry} retryLabel={t('app.retry')} />
  if (initialLoading) return <WashTicketRowsSkeleton />
  if (rows.length === 0) {
    return (
      <InvoiceEmptyState
        variant={filtered ? 'no-results' : 'no-data'}
        onReset={onResetFilters}
        copy="washTicketsPage"
      />
    )
  }
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-2">
        <p className="text-caption tabular-nums" aria-live="polite">
          {t('washTicketsPage.resultsCount', { count: rows.length })}
        </p>
        {/* A refresh keeps the rows on screen and marks the list busy, so
            typing in the search field never blanks the page. */}
        {refreshing ? <ProgressBar label={t('app.loading')} className="w-24" /> : null}
      </div>
      <WashTicketList
        rows={rows}
        onOpenTicket={onOpenTicket}
        onOpenInvoice={onOpenInvoice}
        busy={refreshing}
      />
      {dayId === null ? (
        <p className="border-t border-border-subtle px-3 py-2 text-caption">{t('pos.noDayHint')}</p>
      ) : null}
    </Card>
  )
}

/**
 * First-load placeholder shaped like the real record list.
 *
 * It reserves the same geometry as a ticket row — waiting number, customer
 * block, status tile and receipt — so the page does not jump when the day
 * resolves, and it is one announced status rather than a screen reader full of
 * empty regions.
 */
function WashTicketRowsSkeleton() {
  const { t } = useTranslation()
  return (
    <output aria-busy="true" aria-label={t('washTicketsPage.loadingRecords')} className="block">
      <Card className="overflow-hidden p-0">
        {Array.from({ length: 8 }, (_, index) => (
          <div
            key={index}
            className="flex items-center gap-3 border-b border-border-subtle px-3 py-3 last:border-0"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton variant="text" className="h-4 w-16" accessibilityLabel="" />
              <Skeleton variant="text" className="h-3 w-36" accessibilityLabel="" />
            </div>
            <Skeleton variant="text" className="h-5 w-24" accessibilityLabel="" />
            <Skeleton variant="text" className="h-4 w-20" accessibilityLabel="" />
          </div>
        ))}
      </Card>
      <span className="sr-only">{t('washTicketsPage.loadingRecords')}</span>
    </output>
  )
}
