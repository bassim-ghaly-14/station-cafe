/** Live order panel: lines, product pad, discount, customer/car, wash ticket. */
import { useCallback, useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Button, Card, CardHeader, MoneyDisplay, useToast } from '@/components/ui'
import { Trash2 } from '@/components/ui/icon'
import { ErrorState } from '@/components/states'
import {
  api,
  settingsApi,
  type DiscountSel,
  type OrderCustomer,
  type OrderPreview,
  type PosOrder,
  type Product,
} from '@/services/posApi'
import { discountLabelFor } from './orderDiscountLabel'
import { CustomerPicker } from './CustomerPicker'
import { DiscountDialog } from './DiscountDialog'
import { PrintPreviewDialog, type PrintPreviewTarget } from './PrintPreviewDialog'
import { ProductBrowser } from './ProductBrowser'
import { QtyStepper } from './QtyStepper'
import { DeptBadge } from './DeptBadge'
import { CheckoutSummary } from './CheckoutSummary'

export function OrderPanel({
  order,
  preview,
  discount,
  serviceCharge,
  serviceChargeOptions,
  onServiceChargeChange,
  onDiscountChange,
  onChange,
  onRefreshTables,
  onPay,
  onDiscard,
  discarding,
}: {
  readonly order: PosOrder
  readonly preview: OrderPreview | null
  readonly discount: DiscountSel
  readonly serviceCharge: number
  readonly serviceChargeOptions: number[]
  readonly onServiceChargeChange: (amount: number) => void
  readonly onDiscountChange: (d: DiscountSel) => void
  readonly onChange: (o: PosOrder) => void
  readonly onRefreshTables: () => void
  readonly onPay: () => void
  readonly onDiscard?: () => void
  readonly discarding?: boolean
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [products, setProducts] = useState<Product[] | null>(null)
  const [prodErr, setProdErr] = useState<string | null>(null)
  const [qty, setQty] = useState(1)
  const [discountOptions, setDiscountOptions] = useState<number[]>([])
  const [discountOpen, setDiscountOpen] = useState(false)
  const [customerOpen, setCustomerOpen] = useState(false)
  const [customer, setCustomer] = useState<OrderCustomer | null>(null)
  const [detaching, setDetaching] = useState(false)
  const [ticketBusy, setTicketBusy] = useState(false)
  // The ONE preview system: whichever trigger was used, this single state opens
  // the same shared dialog.
  const [previewTarget, setPreviewTarget] = useState<PrintPreviewTarget | null>(null)

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

  // Discount quick-picks come from admin configuration (Dev Settings). They are
  // SHORTCUTS, not a limit: the cashier can always type any amount the order
  // can carry.
  useEffect(() => {
    settingsApi
      .discountOptions()
      .then((config) => setDiscountOptions(config.amounts))
      .catch(() => setDiscountOptions([]))
  }, [])

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
  const hasWash = shown?.has_wash ?? order.lines.some((l) => l.department === 'WASH')
  const ticketIssued = hasWash && typeof order.waiting_no === 'number'
  /*
   * The cancellation rule, mirrored in the UI. `waiting_no` is written in the
   * SAME transaction as the ticket row, so it states the same fact the service
   * reads from `wash_tickets` — it is not an independent guess, and it stays
   * true even after the wash lines are gone. Hiding the action is a courtesy:
   * the backend rejects the cancellation either way.
   */
  const cancelBlocked = typeof order.waiting_no === 'number'
  // TWO documents, TWO triggers, ONE preview system.
  //
  // The invoice preview always addresses the live order (the backend selects
  // CAFE/WASH/HYBRID/TAKEAWAY from it without finalizing anything), and an
  // issued wash ticket gets its own compact trigger beside it. Both open the
  // SAME `PrintPreviewDialog` — only the trigger presentation differs, so the
  // preview behaviour can never fork.
  const orderPreviewTarget: PrintPreviewTarget = {
    kind: 'order',
    order_id: order.id,
    discount_mode: discount.mode,
    discount_value: discount.value,
    service_charge_minor: serviceCharge,
  }
  const ticketPreviewTarget: PrintPreviewTarget | null = ticketIssued
    ? { kind: 'wash_ticket', order_id: order.id }
    : null
  // A fixed discount is labelled with the money it actually removes; a legacy
  // percentage selection is rendered as a number only (read-only), never as an
  // editable control.
  const discountLabel = discountLabelFor(discount)

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

  // Three states, not two. `null` means this order has no wash line at all, so
  // no ticket is offered. A handler that does nothing means there IS a wash
  // line but a ticket is already being issued — the control stays visible and
  // inert rather than disappearing under the cashier's finger mid-print.
  const washTicketAction = !hasWash ? null : ticketBusy ? () => {} : issueTicket

  return (
    <Card>
      <CardHeader
        title={orderPanelTitle(order, t)}
        subtitle={
          // Table identity comes from the authoritative order row (backend
          // join) — never from a UI selection. Takeaways show no fake table.
          order.order_type === 'TABLE' && order.table_label
            ? `${order.table_label} · ${t('pos.state.' + order.status)}`
            : t('pos.state.' + order.status)
        }
        actions={
          // The panel is the LAST place the rule can be honoured, so it decides
          // for itself: even if a parent hands down a handler, a ticketed order
          // is never rendered with an executable cancellation.
          onDiscard && !cancelBlocked ? (
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
          ) : cancelBlocked ? (
            // The action is gone because the rule forbids it, so the reason is
            // stated rather than left to be guessed at.
            <span className="max-w-56 text-end text-caption text-foreground-subtle">
              {t('pos.cancelBlockedByTicket')}
            </span>
          ) : null
        }
      />
      <LineList order={order} onChange={onChange} onRefreshTables={onRefreshTables} />
      <CheckoutSummary
        order={order}
        shown={shown}
        customer={customer}
        discountLabel={discountLabel}
        serviceCharge={serviceCharge}
        serviceChargeOptions={serviceChargeOptions}
        onServiceCharge={onServiceChargeChange}
        onDiscount={() => setDiscountOpen(true)}
        onCustomer={() => setCustomerOpen(true)}
        onDetachCustomer={detach}
        detaching={detaching}
        onTicket={washTicketAction}
        onReviewPay={onPay}
        onPrintPreview={() => setPreviewTarget(orderPreviewTarget)}
        onTicketPreview={ticketPreviewTarget ? () => setPreviewTarget(ticketPreviewTarget) : null}
      />
      {previewTarget ? (
        <PrintPreviewDialog target={previewTarget} onClose={() => setPreviewTarget(null)} />
      ) : null}
      {prodErr ? (
        <ErrorState message={prodErr} onRetry={loadProducts} retryLabel={t('app.retry')} />
      ) : (
        <ProductBrowser products={products ?? []} qty={qty} onQtyChange={setQty} onAdd={addItem} />
      )}
      {discountOpen ? (
        <DiscountDialog
          initial={discount}
          orderId={order.id}
          subtotal={preview?.subtotal ?? 0}
          amounts={discountOptions}
          onClose={() => setDiscountOpen(false)}
          onApply={(d, refreshed) => {
            setDiscountOpen(false)
            onDiscountChange(d)
            if (refreshed) onChange(refreshed)
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
  readonly order: PosOrder
  readonly onChange: (o: PosOrder) => void
  readonly onRefreshTables: () => void
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
          // The phone layout of one order line, and it is a deliberate
          // restructure rather than a wrap:
          //
          // - the product's NAME takes the whole first line. Beside a qty
          //   stepper, a delete button and a right-aligned amount, a name that
          //   truncates is unreadable — and an unreadable product name on a
          //   till is a real operational problem, not a cosmetic one;
          // - the stepper, the remove control and the line total share the
          //   second line at the inline end, which is where the hand is and
          //   where the money already was.
          //
          // `sm:flex-row` restores the original single line exactly, so the
          // desktop order panel is byte-for-byte unchanged.
          className="flex flex-col gap-1.5 rounded border border-border-subtle px-2 py-1.5 sm:flex-row sm:items-center sm:gap-2"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {l.product_name} <DeptBadge dept={l.department as 'CAFE' | 'WASH'} />
            </span>
            <span className="text-xs text-foreground-subtle">
              <MoneyDisplay amount={l.unit_price} /> × {l.quantity}
            </span>
          </span>
          <span className="flex shrink-0 items-center justify-end gap-1 sm:gap-2">
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
            <MoneyDisplay
              amount={l.line_total}
              className="w-20 text-left text-sm font-medium sm:text-end"
            />
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The panel title: what kind of order this is, and the ticket number.
 *
 * A takeaway leads with its external `TW-` number when the backend sent one,
 * because that is the number the customer will be called by; without one it
 * still says it is a takeaway. A table order has no external number at all, so
 * the title is the ticket alone.
 */
function orderPanelTitle(order: PosOrder, t: TFunction): string {
  if (order.order_type !== 'TAKEAWAY') return `${t('pos.order')} ${order.id}`
  if (typeof order.takeaway_no !== 'number')
    return `${t('pos.takeaway')} · ${t('pos.order')} ${order.id}`
  return `${t('pos.takeaway')} #${order.takeaway_no} · ${t('pos.order')} ${order.id}`
}
