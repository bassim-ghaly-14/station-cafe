/** The main POS screen: table grid + live order panel + payment. */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Card, CardHeader, MoneyDisplay } from '@/components/ui'
import { ErrorState } from '@/components/states'
import { useToast } from '@/components/ui'
import { api, type OrderPreview, type PosOrder, type TableView } from '@/services/posApi'
import { shiftApi } from '@/services/shiftApi'
import { OrderPanel } from './OrderPanel'
import { PaymentDialog } from './PaymentDialog'
import { ShiftGate } from './ShiftGate'
import { TodayInvoices } from './TodayInvoices'

export default function PosPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const [tables, setTables] = useState<TableView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeOrder, setActiveOrder] = useState<PosOrder | null>(null)
  const [dayReady, setDayReady] = useState(false)
  const [payOpen, setPayOpen] = useState(false)
  const [preview, setPreview] = useState<OrderPreview | null>(null)
  const [invoicesOpen, setInvoicesOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [tv, st] = await Promise.all([api.tables(), shiftApi.state()])
      setTables(tv)
      setDayReady(st.day !== null && st.my_shift !== null)
      setError(null)
    } catch (e) {
      setError(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']))
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (activeOrder) {
      api
        .preview(activeOrder.id, null, null)
        .then(setPreview)
        .catch(() => setPreview(null))
    } else {
      setPreview(null)
    }
  }, [activeOrder])

  if (error)
    return <ErrorState message={error} onRetry={() => void refresh()} retryLabel={t('app.retry')} />
  if (!tables) return <p>{t('app.loading')}</p>

  if (!dayReady) return <ShiftGate onReady={() => void refresh()} />

  const report = (e: unknown) =>
    toast(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']), 'error')

  const selectTable = (tv: TableView) => {
    if (tv.order_id) {
      api.getOrder(tv.order_id).then(setActiveOrder).catch(report)
    } else {
      api
        .openTable(tv.id)
        .then((orderId) => api.getOrder(orderId))
        .then((o) => {
          setActiveOrder(o)
          void refresh()
        })
        .catch(report)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
      <Card>
        <CardHeader
          title={t('pos.tables')}
          actions={
            <Button variant="outline" size="sm" onClick={() => setInvoicesOpen(true)}>
              {t('pos.todayInvoices')}
            </Button>
          }
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {tables.map((tv) => (
            <TableCard
              key={tv.id}
              tv={tv}
              active={activeOrder?.id === tv.order_id}
              onClick={() => selectTable(tv)}
            />
          ))}
        </div>
      </Card>
      <div>
        {activeOrder ? (
          <OrderPanel
            order={activeOrder}
            preview={preview}
            onChange={setActiveOrder}
            onRefreshTables={() => void refresh()}
            onPay={() => setPayOpen(true)}
          />
        ) : (
          <Card>
            <p className="text-center text-sm text-brand-600">{t('pos.selectTable')}</p>
          </Card>
        )}
      </div>
      {activeOrder && payOpen ? (
        <PaymentDialog
          orderId={activeOrder.id}
          onClose={() => setPayOpen(false)}
          onDone={(invoiceId, outcome) => {
            setPayOpen(false)
            setActiveOrder(null)
            void refresh()
            if (outcome?.duplicate_suppressed) {
              toast(t('print.duplicateSuppressed'), 'info')
            } else {
              toast(t('pos.paidMessage', { no: invoiceId }), 'success')
            }
          }}
        />
      ) : null}
      {invoicesOpen ? <TodayInvoices onClose={() => setInvoicesOpen(false)} /> : null}
    </div>
  )
}

export function TableCard({
  tv,
  active,
  onClick,
}: {
  tv: TableView
  active: boolean
  onClick: () => void
}) {
  const { t } = useTranslation()
  const tone = tv.status === 'EMPTY' ? 'neutral' : tv.status === 'OPEN' ? 'info' : 'warning'
  // Status is NEVER color-only: always an icon + an Arabic label.
  const icon = tv.status === 'EMPTY' ? '○' : tv.status === 'OPEN' ? '◉' : '✔'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${tv.label} — ${t(`pos.state.${tv.status}`)}`}
      className={`flex min-h-24 flex-col items-start gap-1 rounded-lg border p-3 text-right transition-colors ${
        active
          ? 'border-brand-700 bg-brand-50'
          : 'border-brand-200 bg-surface-raised hover:bg-brand-50'
      }`}
    >
      <span className="flex w-full items-center justify-between">
        <span className="font-bold text-brand-900">{tv.label}</span>
        <span aria-hidden="true">{icon}</span>
      </span>
      <Badge tone={tone}>{t(`pos.state.${tv.status}`)}</Badge>
      <span className="text-xs text-brand-600">
        {tv.items_count} {t('pos.items')} · <MoneyDisplay amount={tv.total_minor} />
      </span>
    </button>
  )
}
