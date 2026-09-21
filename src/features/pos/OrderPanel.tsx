/** Live order panel: lines, product pad, discount, customer/car, wash ticket. */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, CardHeader, MoneyDisplay } from '@/components/ui'
import { useToast } from '@/components/ui'
import { api, type OrderPreview, type PosOrder, type Product } from '@/services/posApi'
import { ActionRow } from './ActionRow'
import { CustomerPicker } from './CustomerPicker'
import { DiscountDialog } from './DiscountDialog'
import { ProductPad } from './ProductPad'
import { QtyStepper } from './QtyStepper'
import { DeptBadge } from './DeptBadge'

export interface DiscountSel {
  mode: string | null
  value: number | null
}

export function OrderPanel({
  order,
  preview,
  onChange,
  onRefreshTables,
  onPay,
}: {
  order: PosOrder
  preview: OrderPreview | null
  onChange: (o: PosOrder) => void
  onRefreshTables: () => void
  onPay: (discountSel: DiscountSel) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [products, setProducts] = useState<Product[] | null>(null)
  const [dept, setDept] = useState<'CAFE' | 'WASH'>('CAFE')
  const [query, setQuery] = useState('')
  const [qty, setQty] = useState(1)
  const [discountOpen, setDiscountOpen] = useState(false)
  const [customerOpen, setCustomerOpen] = useState(false)
  const [localPreview, setLocalPreview] = useState<OrderPreview | null>(null)
  const discountRef = useRef<DiscountSel>({ mode: null, value: null })

  useEffect(() => {
    api
      .products()
      .then(setProducts)
      .catch((e) =>
        toast(
          t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']),
          'error',
        ),
      )
  }, [t, toast])

  useEffect(() => {
    setLocalPreview(null)
    discountRef.current = { mode: null, value: null }
  }, [order.id])

  const report = (e: unknown) =>
    toast(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']), 'error')

  const shown = preview ?? localPreview
  const filtered = (products ?? []).filter(
    (p) => p.department === dept && p.name.includes(query.trim()),
  )

  const refreshPreview = (d: DiscountSel) => {
    discountRef.current = d
    api.preview(order.id, d.mode, d.value).then(setLocalPreview).catch(report)
  }

  const addItem = (p: Product) =>
    api
      .addLine(order.id, p.id, qty)
      .then((o) => {
        onChange(o)
        onRefreshTables()
        const d = discountRef.current
        if (d.mode) void api.preview(order.id, d.mode, d.value).then(setLocalPreview)
      })
      .catch(report)

  const markReady = () =>
    api
      .readyToPay(order.id)
      .then(() => api.getOrder(order.id))
      .then((o) => {
        onChange(o)
        onRefreshTables()
        onPay(discountRef.current)
      })
      .catch(report)

  return (
    <Card>
      <CardHeader
        title={`${t('pos.order')} ${order.id}`}
        subtitle={t(`pos.state.${order.status}`)}
        actions={
          <Button
            size="sm"
            onClick={() => onPay(discountRef.current)}
            disabled={order.lines.length === 0}
          >
            {t('pos.pay')}
          </Button>
        }
      />
      <LineList order={order} onChange={onChange} onRefreshTables={onRefreshTables} />
      {shown ? <TotalsBlock shown={shown} /> : <LineTotals order={order} />}
      <ActionRow
        order={order}
        hasWash={shown?.has_wash ?? order.lines.some((l) => l.department === 'WASH')}
        onDiscount={() => setDiscountOpen(true)}
        onCustomer={() => setCustomerOpen(true)}
        onReady={markReady}
        onRefresh={(o) => {
          onChange(o)
          onRefreshTables()
        }}
      />
      <ProductPad
        dept={dept}
        setDept={setDept}
        query={query}
        setQuery={setQuery}
        qty={qty}
        setQty={setQty}
        items={filtered}
        onAdd={addItem}
      />
      {discountOpen ? (
        <DiscountDialog
          onClose={() => setDiscountOpen(false)}
          onApply={(d) => {
            setDiscountOpen(false)
            refreshPreview(d)
          }}
        />
      ) : null}
      {customerOpen ? (
        <CustomerPicker
          orderId={order.id}
          onClose={() => setCustomerOpen(false)}
          onAttached={(o) => {
            setCustomerOpen(false)
            onChange(o)
          }}
        />
      ) : null}
    </Card>
  )
}

function LineList({
  order,
  onChange,
  onRefreshTables,
}: {
  order: PosOrder
  onChange: (o: PosOrder) => void
  onRefreshTables: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const report = (e: unknown) =>
    toast(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']), 'error')

  if (order.lines.length === 0) {
    return <p className="py-4 text-center text-sm text-brand-500">{t('pos.emptyOrder')}</p>
  }
  return (
    <ul className="mb-3 flex flex-col gap-1">
      {order.lines.map((l) => (
        <li
          key={l.id}
          className="flex items-center justify-between gap-2 rounded border border-brand-100 px-2 py-1.5"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {l.product_name} <DeptBadge dept={l.department as 'CAFE' | 'WASH'} />
            </span>
            <span className="text-xs text-brand-500">
              <MoneyDisplay amount={l.unit_price} /> × {l.quantity}
            </span>
          </span>
          <QtyStepper
            qty={l.quantity}
            onChange={(q) =>
              api
                .setQty(order.id, l.id, q)
                .then((o) => {
                  onChange(o)
                  onRefreshTables()
                })
                .catch(report)
            }
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('pos.removeLine')}
            onClick={() =>
              api
                .removeLine(order.id, l.id)
                .then((o) => {
                  onChange(o)
                  onRefreshTables()
                })
                .catch(report)
            }
          >
            ✕
          </Button>
          <MoneyDisplay amount={l.line_total} className="w-20 text-left text-sm font-medium" />
        </li>
      ))}
    </ul>
  )
}

export function LineTotals({ order }: { order: PosOrder }) {
  const { t } = useTranslation()
  const subtotal = order.lines.reduce((a, l) => a + l.line_total, 0)
  return (
    <div className="mb-3 flex justify-between rounded bg-brand-50 p-2 text-sm font-medium">
      <span>{t('pos.subtotal')}</span>
      <MoneyDisplay amount={subtotal} />
    </div>
  )
}

export function TotalsBlock({ shown }: { shown: OrderPreview }) {
  const { t } = useTranslation()
  return (
    <div className="mb-3 flex flex-col gap-1 rounded bg-brand-50 p-2 text-sm">
      <div className="flex justify-between">
        <span>{t('pos.subtotal')}</span>
        <MoneyDisplay amount={shown.subtotal} />
      </div>
      <div className="flex justify-between">
        <span>{t('pos.discount')}</span>
        <MoneyDisplay amount={shown.discount_minor} />
      </div>
      <div className="flex justify-between">
        <span>{t('pos.serviceCharge')}</span>
        <MoneyDisplay amount={shown.service_charge_minor} />
      </div>
      <div className="flex justify-between text-base font-bold">
        <span>{t('pos.total')}</span>
        <MoneyDisplay amount={shown.total} />
      </div>
    </div>
  )
}
