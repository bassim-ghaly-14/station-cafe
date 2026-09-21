/** Today's invoices: fast lookup by number / table / customer / phone / plate. */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Dialog, MoneyDisplay } from '@/components/ui'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui'
import { api, type InvoiceRow } from '@/services/posApi'
import { shiftApi } from '@/services/shiftApi'

export function TodayInvoices({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [rows, setRows] = useState<InvoiceRow[] | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [method, setMethod] = useState('')
  const [dayId, setDayId] = useState<number | null>(null)

  const load = useCallback(() => {
    void shiftApi.state().then((st) => {
      setDayId(st.day?.id ?? null)
      return api
        .invoices({
          business_day_id: st.day?.id,
          query: query.trim() || undefined,
          status: status || undefined,
          method: method || undefined,
        })
        .then(setRows)
        .catch((e) =>
          toast(
            t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']),
            'error',
          ),
        )
    })
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
          className="h-10 rounded-md border border-brand-300 bg-surface-raised px-2 text-sm"
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
          className="h-10 rounded-md border border-brand-300 bg-surface-raised px-2 text-sm"
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
          {t('app.search')}
        </Button>
      </div>
      {!rows ? (
        <p>{t('app.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-brand-500">{t('pos.noInvoices')}</p>
      ) : (
        <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-2 rounded border border-brand-100 p-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">#{r.invoice_no}</span>
                <span className="block truncate text-xs text-brand-600">
                  {r.table_label ?? ''} · {r.customer_name ?? ''} ·{' '}
                  <span dir="ltr">{r.car_plate ?? ''}</span>
                </span>
              </span>
              <Badge
                tone={r.status === 'PAID' ? 'success' : r.status === 'CREDIT' ? 'warning' : 'info'}
              >
                {t(`invoice.status.${r.status}`)}
              </Badge>
              <MoneyDisplay amount={r.total} className="text-sm font-medium" />
              <Button size="sm" variant="ghost" onClick={() => printAgain(r.id)}>
                {t('app.print')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {dayId === null ? <p className="mt-2 text-xs text-brand-500">{t('pos.noDayHint')}</p> : null}
    </Dialog>
  )
}
