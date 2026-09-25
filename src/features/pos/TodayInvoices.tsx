/** Today's invoices: fast lookup by number / table / customer / phone / plate. */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Dialog, MoneyDisplay } from '@/components/ui'
import { Eye, Printer, Search } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { ErrorState } from '@/components/states'
import { ListRowsSkeleton } from '@/components/ui'
import { useToast } from '@/components/ui'
import { api, type InvoiceRow } from '@/services/posApi'
import { invoiceBadgeVariant } from '@/lib/status-badge'
import { shiftApi } from '@/services/shiftApi'
import { PrintPreviewDialog } from './PrintPreviewDialog'

export function TodayInvoices({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
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

  return (
    <Dialog open onClose={onClose} title={t('pos.todayInvoices')} wide>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('pos.invoiceSearchHint')}
          aria-label={t('pos.invoiceSearch')}
        />
        <select
          className="h-10 rounded-md border border-border-strong bg-surface-input px-2 text-sm"
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
        </select>
        <select
          className="h-10 rounded-md border border-border-strong bg-surface-input px-2 text-sm"
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
        </select>
        <Button variant="outline" onClick={load}>
          <Search size={16} aria-hidden />
          {t('app.search')}
        </Button>
      </div>
      {!rows ? (
        loadError ? (
          <ErrorState message={loadError} onRetry={load} retryLabel={t('app.retry')} />
        ) : (
          <ListRowsSkeleton rows={5} />
        )
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-foreground-subtle">{t('pos.noInvoices')}</p>
      ) : (
        <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-2 rounded border border-border-subtle p-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">
                  #{r.invoice_no}
                  {r.order_type === 'TAKEAWAY' && typeof r.takeaway_no === 'number' ? (
                    <span className="ms-2 text-xs font-medium text-foreground-subtle" dir="ltr">
                      TW-{r.takeaway_no}
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-xs text-foreground-subtle">
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
              </span>
              <Badge variant={invoiceBadgeVariant(r.status)} size="sm" dot>
                {t(`invoice.status.${r.status}`)}
              </Badge>
              <MoneyDisplay amount={r.total} className="text-sm font-medium" />
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
                variant="ghost"
                aria-label={`${t('app.print')} — #${r.invoice_no}`}
                onClick={() => printAgain(r.id)}
              >
                <Printer size={16} aria-hidden />
                {t('app.print')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {dayId === null ? (
        <p className="mt-2 text-xs text-foreground-subtle">{t('pos.noDayHint')}</p>
      ) : null}
      {previewId !== null ? (
        <PrintPreviewDialog
          target={{ kind: 'invoice', invoice_id: previewId }}
          onClose={() => setPreviewId(null)}
        />
      ) : null}
    </Dialog>
  )
}
