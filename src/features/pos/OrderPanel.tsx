/** Live order panel: lines, product pad, discount, customer/car, wash ticket. */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Card, MoneyDisplay, useToast } from '@/components/ui'
import { ArrowRight, ShoppingBag, Trash2, User } from '@/components/ui/icon'
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
  onBack,
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
  /**
   * Leave the order workspace and go back to the tables overview.
   *
   * This is PRESENTATION ONLY: it moves the view, it never touches the order.
   * The order stays loaded and persisted, so coming back — through the table's
   * own "open order" action or the takeaway list — restores it exactly as it
   * was. That is what makes the workspace safe to step out of mid-sale.
   */
  readonly onBack?: () => void
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
    // The panel's initial read of the product pad. External async init, started
    // after the first commit; deriving it during render would fetch from render.
    // oxlint-disable-next-line react/set-state-in-effect -- external async init.
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

  const washTicketAction = washTicketHandler(hasWash, ticketBusy, issueTicket)

  return (
    <Card
      aria-label={t('pos.orderWorkspace')}
      className="flex min-h-0 flex-col lg:h-[calc(100dvh-12rem)] lg:overflow-hidden"
    >
      {/* The order header: what this order is, and the way back to the tables. */}
      <OrderHeader
        order={order}
        customer={customer}
        onBack={onBack}
        actions={
          <DiscardAction
            cancelBlocked={cancelBlocked}
            discarding={discarding}
            onDiscard={onDiscard}
          />
        }
      />

      {/*
        The workspace body: the product pad takes the WIDER column at the
        inline-start and the running order the narrower one at the inline-end.
        The order column is capped and scrolls INSIDE itself on a desktop, so
        the totals and the pay action stay reachable no matter how long the
        product list is. Below `lg` the two stack in source order — pad first —
        and the page scrolls, which keeps the phone free of nested scrollers.
      */}
      <div
        className="grid min-h-0 gap-4 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_26rem]"
        data-testid="order-workspace-body"
      >
        <div className="flex min-h-0 min-w-0 flex-col lg:overflow-y-auto lg:pe-1">
          {prodErr ? (
            <ErrorState message={prodErr} onRetry={loadProducts} retryLabel={t('app.retry')} />
          ) : (
            <ProductBrowser
              products={products ?? []}
              qty={qty}
              onQtyChange={setQty}
              onAdd={addItem}
            />
          )}
        </div>

        <div className="flex min-w-0 flex-col lg:min-h-0 lg:overflow-y-auto">
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
            onTicketPreview={
              ticketPreviewTarget ? () => setPreviewTarget(ticketPreviewTarget) : null
            }
          />
        </div>
      </div>

      {previewTarget ? (
        <PrintPreviewDialog target={previewTarget} onClose={() => setPreviewTarget(null)} />
      ) : null}
      <OrderDialogs
        orderId={order.id}
        discountOpen={discountOpen}
        onDiscountClose={() => setDiscountOpen(false)}
        discount={discount}
        subtotal={preview?.subtotal ?? 0}
        discountOptions={discountOptions}
        onDiscountApply={(d, refreshed) => {
          setDiscountOpen(false)
          onDiscountChange(d)
          if (refreshed) onChange(refreshed)
        }}
        customerOpen={customerOpen}
        onCustomerClose={() => setCustomerOpen(false)}
        onCustomerAttached={(o) => {
          setCustomerOpen(false)
          onChange(o)
        }}
      />
    </Card>
  )
}

/**
 * The panel's two order-scoped dialogs.
 *
 * They are opened from the checkout summary and dismissed by their own
 * callback, so the panel passes the open flag and the exact handlers instead
 * of owning a second copy of either dialog's lifecycle.
 */
function OrderDialogs({
  orderId,
  discountOpen,
  onDiscountClose,
  discount,
  subtotal,
  discountOptions,
  onDiscountApply,
  customerOpen,
  onCustomerClose,
  onCustomerAttached,
}: {
  readonly orderId: number
  readonly discountOpen: boolean
  readonly onDiscountClose: () => void
  readonly discount: DiscountSel
  readonly subtotal: number
  readonly discountOptions: number[]
  readonly onDiscountApply: (d: DiscountSel, refreshed?: PosOrder) => void
  readonly customerOpen: boolean
  readonly onCustomerClose: () => void
  readonly onCustomerAttached: (o: PosOrder) => void
}) {
  if (!discountOpen && !customerOpen) return null

  return (
    <>
      {discountOpen ? (
        <DiscountDialog
          initial={discount}
          orderId={orderId}
          subtotal={subtotal}
          amounts={discountOptions}
          onClose={onDiscountClose}
          onApply={onDiscountApply}
        />
      ) : null}
      {customerOpen ? (
        <CustomerPicker
          orderId={orderId}
          onClose={onCustomerClose}
          onAttached={onCustomerAttached}
        />
      ) : null}
    </>
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
          // - the product's NAME takes the whole first line and WRAPS rather than
          //   truncating. An unreadable product name on a till is a real
          //   operational problem, not a cosmetic one: the cashier cannot ring up
          //   what they cannot read. It wraps on desktop too, for the same
          //   reason — the width is there, so there is nothing to gain by
          //   cutting the name short;
          // - the stepper, the remove control and the line total share the
          //   second line at the inline end, which is where the hand is and
          //   where the money already was.
          className="flex flex-col gap-1.5 rounded border border-border-subtle px-2 py-1.5 sm:flex-row sm:items-start sm:gap-2"
        >
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
              <span className="min-w-0 wrap-break-word">{l.product_name}</span>

              <DeptBadge dept={l.department as 'CAFE' | 'WASH'} />
            </span>

            <span className="text-xs text-foreground-subtle">
              <MoneyDisplay amount={l.unit_price} /> × {l.quantity}
            </span>
          </span>
          <span className="flex shrink-0 items-center justify-end gap-1 sm:items-center sm:gap-2">
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
              className="w-20 text-left text-sm font-bold sm:text-end"
            />
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The order workspace header: WHERE this order is, WHICH order it is, and the
 * one action that leaves the workspace.
 *
 * Three compact bands rather than one dashboard row:
 *
 *   1. the way back, with the order-scoped action at the far end;
 *   2. the IDENTITY — the table (or the takeaway type) at the reading-start and
 *      the order number at the reading-end, both at heading weight so neither
 *      can be missed or read as a footnote;
 *   3. the facts that qualify it (state, customer, external takeaway number) at
 *      caption weight.
 *
 * A takeaway has NO table, and the header says so with the existing
 * order-type wording rather than an empty or zeroed table field: a blank table
 * label beside a real order reads as a bug, not as information. The badge also
 * carries the icon and the words, so the type never depends on colour alone.
 *
 * Both identities come from the AUTHORITATIVE order row (the backend join),
 * never from a UI selection, so the header can never claim a table the order
 * does not belong to. Every number is wrapped in `dir="ltr"` so a mixed
 * Arabic+numeric run keeps its digits in reading order under RTL.
 *
 * The back arrow is a logical-direction glyph rather than a mirrored one: the
 * app renders `dir="rtl"` at the shell, and "back" is toward the reading-start
 * side, which is what `ArrowRight` already points at here — so no `rtl:`
 * override is needed and both directions stay correct.
 */
function OrderHeader({
  order,
  customer,
  onBack,
  actions,
}: {
  readonly order: PosOrder
  readonly customer: OrderCustomer | null
  readonly onBack?: () => void
  readonly actions?: ReactNode
}) {
  const { t } = useTranslation()

  const isTakeaway = order.order_type === 'TAKEAWAY'
  const state = t('pos.state.' + order.status)

  return (
    <div className="mb-4 border-b border-border-subtle pb-3">
      {/* 1 — the way out, and the one order-scoped action. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {onBack ? (
          <Button variant="outline" size="sm" onClick={onBack} data-testid="order-back">
            <ArrowRight size={16} aria-hidden />
            {t('pos.backToTables')}
          </Button>
        ) : (
          <span />
        )}

        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>

      {/* 2 — the identity. Heading weight, two ends of the same line. */}
      <div className="mt-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          {isTakeaway ? (
            <Badge
              variant="info"
              size="md"
              icon={ShoppingBag}
              dot
              data-testid="order-identity-takeaway"
            >
              {t('pos.takeaway')}
            </Badge>
          ) : (
            <>
              <p className="text-caption text-foreground-subtle">{t('pos.orderType.TABLE')}</p>

              <p
                className="truncate text-heading font-bold text-foreground-strong"
                data-testid="order-identity-table"
              >
                {order.table_label}
              </p>
            </>
          )}
        </div>

        <div className="text-end">
          <p className="text-caption text-foreground-subtle">{t('pos.order')}</p>

          <p
            className="text-heading font-bold tabular-nums text-foreground-strong"
            data-testid="order-identity-number"
          >
            {/*
              `#` and the digits are one LTR run: an isolated `#9` inside an
              RTL line otherwise reorders the sign to the far side of the
              number, which is exactly the kind of near-miss that makes a
              cashier read the wrong ticket.
            */}
            <span dir="ltr">#{order.id}</span>
          </p>
        </div>
      </div>

      {/* 3 — the qualifying facts. */}
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
        <span>{state}</span>

        <span aria-hidden className="text-foreground-faint">
          ·
        </span>

        {/* "بدون عميل" is a real, recorded identity — not a blank field. */}
        <span className="inline-flex items-center gap-1">
          <User size={13} aria-hidden />
          {customer ? customer.name : t('pos.noCustomer')}
        </span>

        {/* The external number the customer is called by, when there is one. */}
        {isTakeaway && typeof order.takeaway_no === 'number' ? (
          <>
            <span aria-hidden className="text-foreground-faint">
              ·
            </span>

            <span className="inline-flex items-center gap-1">
              <ShoppingBag size={13} aria-hidden />
              {t('pos.takeawayNo')}: <span dir="ltr">#{order.takeaway_no}</span>
            </span>
          </>
        ) : null}
      </p>
    </div>
  )
}

/**
 * The wash-ticket control offered by the checkout summary.
 *
 * Three states, not two. `null` means this order has no wash line at all, so no
 * ticket is offered. A handler that does nothing means there IS a wash line but
 * a ticket is already being issued — the control stays visible and inert rather
 * than disappearing under the cashier's finger mid-print.
 */
function washTicketHandler(
  hasWash: boolean,
  ticketBusy: boolean,
  issueTicket: () => void,
): (() => void) | null {
  if (!hasWash) return null
  if (ticketBusy) return () => {}
  return issueTicket
}

/**
 * The panel's discard slot.
 *
 * The panel is the LAST place the cancellation rule can be honoured, so it
 * decides for itself: even if a parent hands down a handler, a ticketed order
 * is never rendered with an executable cancellation.
 */
function DiscardAction({
  cancelBlocked,
  discarding,
  onDiscard,
}: {
  readonly cancelBlocked: boolean
  readonly discarding?: boolean
  readonly onDiscard?: () => void
}) {
  const { t } = useTranslation()

  if (onDiscard && !cancelBlocked) {
    return (
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
    )
  }

  // The action is gone because the rule forbids it, so the reason is stated
  // rather than left to be guessed at.
  if (cancelBlocked) {
    return (
      <span className="max-w-56 text-end text-caption text-foreground-subtle">
        {t('pos.cancelBlockedByTicket')}
      </span>
    )
  }

  return null
}
