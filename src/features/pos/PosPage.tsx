/** The main POS screen: table grid + live order panel + payment. */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Card, CardHeader, MoneyDisplay } from '@/components/ui'
import { Receipt } from '@/components/ui/icon'
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
    <div className="grid gap-4 lg:grid-cols-[720px_1fr]">
      <Card>
        <CardHeader
          title={t('pos.tables')}
          actions={
            <Button variant="outline" size="sm" onClick={() => setInvoicesOpen(true)}>
              <Receipt size={16} aria-hidden />
              {t('pos.todayInvoices')}
            </Button>
          }
        />

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-3">
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
            <p className="text-center text-sm text-foreground-subtle">{t('pos.selectTable')}</p>
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
      className={`group flex min-h-44 flex-col gap-4 rounded-lg border p-4 text-start transition-all ${
        active
          ? 'border-primary bg-accent shadow-sm hover:bg-accent-hover active:bg-accent-hover'
          : 'border-border-strong bg-transparent hover:border-border-accent-hover hover:bg-accent active:border-border-accent-hover active:bg-accent-hover'
      }`}
    >
      {/* Header */}
      <div className="flex w-full items-start justify-between gap-3">
        <p className="truncate text-lg font-bold leading-tight text-foreground-strong">{tv.label}</p>

        <span
          aria-hidden="true"
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border text-base font-bold ${
            active
              ? 'border-border-accent bg-surface text-foreground-muted'
              : 'border-border-strong bg-accent text-foreground-muted'
          }`}
        >
          {icon}
        </span>
      </div>

      {/* Status */}
      <div className="flex w-full">
        <Badge tone={tone}>{t(`pos.state.${tv.status}`)}</Badge>
      </div>

      {/* Metrics */}
      <div className="mt-auto grid w-full grid-cols-[72px_minmax(0,1fr)] items-stretch gap-2">
        <div className="min-w-0 overflow-hidden border border-border-subtle bg-surface-muted px-2 py-2.5 text-start">
          <p className="truncate whitespace-nowrap text-[11px] font-medium text-foreground-subtle">
            {t('pos.items')}
          </p>

          <p className="mt-0.5 truncate whitespace-nowrap text-base font-bold text-foreground-strong">
            {tv.items_count}
          </p>
        </div>

        <div className="min-w-0 overflow-hidden border border-border-subtle bg-surface-muted px-3 py-2.5 text-start">
          <p className="truncate whitespace-nowrap text-[11px] font-medium text-foreground-subtle">
            {t('pos.total')}
          </p>

          <p className="mt-0.5 min-w-0 truncate whitespace-nowrap text-sm font-bold text-foreground-strong">
            <MoneyDisplay amount={tv.total_minor} />
          </p>
        </div>
      </div>
    </button>
  )
}
