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
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  ListRowsSkeleton,
  MoneyDisplay,
  Select,
  DisplayTime,
  useToast,
} from '@/components/ui'
import { ArrowRight, Eye, Printer, Search } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { EmptyState, ErrorState } from '@/components/states'
import { useRouter } from '@/app/router'
import { api, type InvoiceRow } from '@/services/posApi'
import { invoiceBadgeVariant } from '@/lib/status-badge'
import { shiftApi } from '@/services/shiftApi'
import { sumAmounts } from '@/lib/utils'
import { PrintPreviewDialog } from './PrintPreviewDialog'

export function TodayInvoicesPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const { navigate } = useRouter()
  const [rows, setRows] = useState<InvoiceRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [method, setMethod] = useState('')
  const [dayId, setDayId] = useState<number | null>(null)
  // Print preview of a persisted invoice — same document as the reprint below.
  const [previewId, setPreviewId] = useState<number | null>(null)

  const load = useCallback(() => {
    setLoadError(null)
    void (async () => {
      try {
        const st = await shiftApi.state()
        setDayId(st.day?.id ?? null)
        setRows(
          await api.invoices({
            business_day_id: st.day?.id,
            query: query.trim() || undefined,
            status: status || undefined,
            method: method || undefined,
          }),
        )
      } catch (e) {
        setLoadError(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']))
        toast(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']), 'error')
      }
    })()
  }, [query, status, method, t, toast])

  useEffect(() => {
    load()
  }, [load])

  /**
   * Contextual summary of exactly the rows listed below. Derived from the rows
   * already in memory — a presentation of the list, never a second query and
   * never a second financial rule.
   */
  const summary = useMemo(() => {
    const list = rows ?? []
    return {
      count: list.length,
      total: sumAmounts(list.map((r) => r.total)),
      credit: list.filter((r) => r.status === 'CREDIT').length,
    }
  }, [rows])

  const printAgain = (id: number) =>
    api
      .printInvoice(id)
      .then((o) =>
        toast(o.duplicate_suppressed ? t('print.duplicateSuppressed') : t('print.done'), 'success'),
      )
      .catch((e) =>
        toast(
          t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']),
          'error',
        ),
      )

  const filtered = query.trim() !== '' || status !== '' || method !== ''

  return (
    <div className="flex flex-col gap-4">
      {/* Page header: identity, the day's shape, and the way back. */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-heading">{t('pos.todayInvoices')}</h1>
          <p className="text-caption mt-1">
            {rows === null
              ? t('app.loading')
              : t('invoicesPage.summary', { count: summary.count, credit: summary.credit })}
          </p>
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

      {/* Filters — the same fields the dialog had, on the shared Select. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('pos.invoiceSearchHint')}
          aria-label={t('pos.invoiceSearch')}
        />
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label={t('app.status')}
        >
          <option value="">{t('pos.allStatuses')}</option>
          {['PAID', 'PARTIALLY_PAID', 'CREDIT'].map((s) => (
            <option key={s} value={s}>
              {t(`invoice.status.${s}`)}
            </option>
          ))}
        </Select>
        <Select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          aria-label={t('pay.methodLabel')}
        >
          <option value="">{t('pos.allMethods')}</option>
          {['CASH', 'CARD', 'CREDIT'].map((m) => (
            <option key={m} value={m}>
              {t(`pay.method.${m}`)}
            </option>
          ))}
        </Select>
        <Button variant="outline" onClick={load}>
          <Search size={16} aria-hidden />
          {t('app.search')}
        </Button>
      </div>

      {/* The list grows with the page instead of scrolling inside a dialog. */}
      <Card className="p-0">
        {!rows ? (
          loadError ? (
            <div className="p-4">
              <ErrorState message={loadError} onRetry={load} retryLabel={t('app.retry')} />
            </div>
          ) : (
            <div className="p-4">
              <ListRowsSkeleton rows={8} />
            </div>
          )
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title={filtered ? t('invoicesPage.noMatches') : t('pos.noInvoices')}
              action={
                filtered ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setQuery('')
                      setStatus('')
                      setMethod('')
                    }}
                  >
                    {t('invoicesPage.clearFilters')}
                  </Button>
                ) : null
              }
            />
          </div>
        ) : (
          <ul className="flex flex-col">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-4 py-3 last:border-b-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-body font-bold">
                    #{r.invoice_no}
                    {r.order_type === 'TAKEAWAY' && typeof r.takeaway_no === 'number' ? (
                      <span className="ms-2 text-caption font-medium" dir="ltr">
                        TW-{r.takeaway_no}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-caption">
                    <span className="truncate">
                      {r.order_type === 'TAKEAWAY' ? (
                        <>{t('pos.orderType.TAKEAWAY')}</>
                      ) : (
                        <>{r.table_label ?? ''}</>
                      )}{' '}
                      {/* An invoice raised without a customer says so explicitly —
                          never a blank where the identity belongs. */}
                      · {r.customer_name ?? t('pos.noCustomer')} ·{' '}
                      <span dir="ltr">{r.car_plate ?? ''}</span>
                    </span>
                    <DisplayTime value={r.created_at} />
                  </span>
                </span>
                <Badge variant={invoiceBadgeVariant(r.status)} size="sm" dot>
                  {t(`invoice.status.${r.status}`)}
                </Badge>
                <MoneyDisplay amount={r.total} className="text-body font-medium" />
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${t('print.preview')} — #${r.invoice_no}`}
                    onClick={() => setPreviewId(r.id)}
                  >
                    <Eye size={16} aria-hidden />
                    {t('print.preview')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`${t('app.print')} — #${r.invoice_no}`}
                    onClick={() => printAgain(r.id)}
                  >
                    <Printer size={16} aria-hidden />
                    {t('app.print')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {dayId === null ? (
          <p className="border-t border-border-subtle px-4 py-2 text-caption">
            {t('pos.noDayHint')}
          </p>
        ) : null}
      </Card>

      {previewId !== null ? (
        <PrintPreviewDialog
          target={{ kind: 'invoice', invoice_id: previewId }}
          onClose={() => setPreviewId(null)}
        />
      ) : null}
    </div>
  )
}
