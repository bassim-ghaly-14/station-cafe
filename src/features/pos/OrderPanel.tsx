/** Live order panel: lines, product pad, discount, customer/car, wash ticket. */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, CardHeader, MoneyDisplay } from '@/components/ui'
import { Trash2 } from '@/components/ui/icon'
import { ErrorState } from '@/components/states'
import { useToast } from '@/components/ui'
import {
  api,
  type DiscountSel,
  type OrderCustomer,
  type OrderPreview,
  type PosOrder,
  type Product,
} from '@/services/posApi'
import { CustomerPicker } from './CustomerPicker'
import { DiscountDialog } from './DiscountDialog'
import { DiscountLimitDialog } from './DiscountLimitDialog'
import { PrintPreviewDialog, type PrintPreviewTarget } from './PrintPreviewDialog'
import { ProductPad } from './ProductPad'
import { QtyStepper } from './QtyStepper'
import { DeptBadge } from './DeptBadge'
import { CheckoutSummary } from './CheckoutSummary'
import { useSession } from '@/features/auth/useSession'

export function OrderPanel({
  order,
  preview,
  discount,
  onDiscountChange,
  onChange,
  onRefreshTables,
  onPay,
  onDiscard,
  discarding,
}: {
  order: PosOrder
  preview: OrderPreview | null
  discount: DiscountSel
  onDiscountChange: (d: DiscountSel) => void
  onChange: (o: PosOrder) => void
  onRefreshTables: () => void
  onPay: () => void
  onDiscard?: () => void
  discarding?: boolean
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const { user } = useSession()
  const canManageLimits = user?.role === 'MANAGER' || user?.role === 'ADMIN'
  const [products, setProducts] = useState<Product[] | null>(null)
  const [prodErr, setProdErr] = useState<string | null>(null)
  const [dept, setDept] = useState<'CAFE' | 'WASH'>('CAFE')
  const [query, setQuery] = useState('')
  const [qty, setQty] = useState(1)
  const [discountOpen, setDiscountOpen] = useState(false)
  const [limitOpen, setLimitOpen] = useState(false)
  const [customerOpen, setCustomerOpen] = useState(false)
  const [customer, setCustomer] = useState<OrderCustomer | null>(null)
  const [detaching, setDetaching] = useState(false)
  const [ticketBusy, setTicketBusy] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)

  const loadProducts = useCallback(() => {
    setProdErr(null)
    api
      .products()
      .then(setProducts)
      .catch((e) => {
        setProdErr(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']))
      })
  }, [t])

  useEffect(() => {
    loadProducts()
  }, [loadProducts])

  // Attached-customer display: refresh when the order's customer link changes.
  useEffect(() => {
    api
      .orderCustomer(order.id)
      .then(setCustomer)
      .catch(() => setCustomer(null))
  }, [order.customer_id, order.id])

  const report = (e: unknown) =>
    toast(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']), 'error')

  // Parent owns the preview/discount (single backend fetch); panel is display.
  const shown = preview
  const filtered = (products ?? []).filter(
    (p) => p.department === dept && p.name.includes(query.trim()),
  )
  const hasWash = shown?.has_wash ?? order.lines.some((l) => l.department === 'WASH')
  // Current orders always have a read-only preview document. An issued wash
  // ticket keeps its operational document identity; otherwise the backend
  // selects CAFE/WASH/HYBRID/TAKEAWAY from the live order without finalizing it.
  const previewTarget: PrintPreviewTarget =
    hasWash && typeof order.waiting_no === 'number'
      ? { kind: 'wash_ticket', order_id: order.id }
      : {
          kind: 'order',
          order_id: order.id,
          discount_mode: discount.mode,
          discount_value: discount.value,
        }
  const discountLabel = discount.mode
    ? discount.mode === 'PERCENT'
      ? `${(discount.value ?? 0) / 1000}%`
      : null
    : null

  const addItem = (p: Product) =>
    api
      .addLine(order.id, p.id, qty)
      .then((o) => {
        onChange(o)
        onRefreshTables()
      })
      .catch(report)

  const detach = () => {
    setDetaching(true)
    api
      .detachCustomer(order.id)
      .then(() => api.getOrder(order.id))
      .then((o) => {
        onChange(o)
        setCustomer(null)
      })
      .catch(report)
      .finally(() => setDetaching(false))
  }

  const issueTicket = () => {
    setTicketBusy(true)
    api
      .ticket(order.id)
      .then((tk) => {
        toast(t('pos.ticketIssued', { no: tk.waiting_no }), 'success')
        return api.getOrder(order.id)
      })
      .then((o) => {
        onChange(o)
        onRefreshTables()
      })
      .catch(report)
      .finally(() => setTicketBusy(false))
  }

  return (
    <Card>
      <CardHeader
        title={
          order.order_type === 'TAKEAWAY' && typeof order.takeaway_no === 'number'
            ? `${t('pos.takeaway')} #${order.takeaway_no} · ${t('pos.order')} ${order.id}`
            : order.order_type === 'TAKEAWAY'
              ? `${t('pos.takeaway')} · ${t('pos.order')} ${order.id}`
              : `${t('pos.order')} ${order.id}`
        }
        subtitle={
          // Table identity comes from the authoritative order row (backend
          // join) — never from a UI selection. Takeaways show no fake table.
          order.order_type === 'TABLE' && order.table_label
            ? `${order.table_label} · ${t(`pos.state.${order.status}`)}`
            : t(`pos.state.${order.status}`)
        }
        actions={
          onDiscard ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={onDiscard}
              disabled={discarding}
              loading={discarding}
              aria-label={t('pos.discardOrder')}
            >
              <Trash2 size={16} aria-hidden />
              {t('pos.discardOrder')}
            </Button>
          ) : null
        }
      />
      <LineList order={order} onChange={onChange} onRefreshTables={onRefreshTables} />
      <CheckoutSummary
        order={order}
        shown={shown}
        customer={customer}
        discountLabel={discountLabel}
        onDiscount={() => setDiscountOpen(true)}
        onLimit={() => setLimitOpen(true)}
        canManageLimits={canManageLimits}
        onCustomer={() => setCustomerOpen(true)}
        onDetachCustomer={detach}
        detaching={detaching}
        onTicket={hasWash && !ticketBusy ? issueTicket : hasWash ? () => {} : null}
        onReviewPay={onPay}
        onPrintPreview={() => setPreviewOpen(true)}
      />
      {previewOpen ? (
        <PrintPreviewDialog target={previewTarget} onClose={() => setPreviewOpen(false)} />
      ) : null}
      {prodErr ? (
        <ErrorState message={prodErr} onRetry={loadProducts} retryLabel={t('app.retry')} />
      ) : (
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
      )}
      {discountOpen ? (
        <DiscountDialog
          initial={discount}
          orderId={order.id}
          onClose={() => setDiscountOpen(false)}
          onApply={(d, refreshed) => {
            setDiscountOpen(false)
            onDiscountChange(d)
            if (refreshed) onChange(refreshed)
          }}
        />
      ) : null}
      {limitOpen && canManageLimits ? (
        <DiscountLimitDialog onClose={() => setLimitOpen(false)} />
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
    return <p className="py-4 text-center text-sm text-foreground-subtle">{t('pos.emptyOrder')}</p>
  }
  return (
    <ul className="mb-3 flex flex-col gap-1">
      {order.lines.map((l) => (
        <li
          key={l.id}
          className="flex items-center justify-between gap-2 rounded border border-border-subtle px-2 py-1.5"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {l.product_name} <DeptBadge dept={l.department as 'CAFE' | 'WASH'} />
            </span>
            <span className="text-xs text-foreground-subtle">
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
            variant="destructiveGhost"
            size="icon-sm"
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
            <Trash2 size={16} aria-hidden />
          </Button>
          <MoneyDisplay amount={l.line_total} className="w-20 text-left text-sm font-medium" />
        </li>
      ))}
    </ul>
  )
}
