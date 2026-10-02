/** Compact checkout summary: totals + optional customer + single pay action. */
import { useTranslation } from 'react-i18next'
import { Button, MoneyDisplay } from '@/components/ui'
import { Eye, HandCoins, Tag, Ticket, User, UserPlus, Wallet, X } from '@/components/ui/icon'
import { formatMinorMoney } from '@/lib/money'
import type { OrderCustomer, OrderPreview, PosOrder } from '@/services/posApi'

export function CheckoutSummary({
  order,
  shown,
  customer,
  discountLabel,
  serviceCharge,
  serviceChargeOptions,
  onServiceCharge,
  onDiscount,
  onCustomer,
  onDetachCustomer,
  detaching,
  onTicket,
  onReviewPay,
  onPrintPreview,
  onTicketPreview,
}: {
  readonly order: PosOrder
  readonly shown: OrderPreview | null
  readonly customer: OrderCustomer | null
  readonly discountLabel: string | null
  readonly serviceCharge: number
  readonly serviceChargeOptions: number[]
  readonly onServiceCharge: (amount: number) => void
  readonly onDiscount: () => void
  readonly onCustomer: () => void
  readonly onDetachCustomer: () => void
  readonly detaching: boolean
  readonly onTicket: (() => void) | null
  readonly onReviewPay: () => void
  /** Print preview of the order's printable invoice document; null when none exists yet. */
  readonly onPrintPreview: (() => void) | null
  /**
   * Print preview of an ISSUED wash ticket, when one exists. Rendered as a
   * compact trigger and opening the same shared preview dialog as the invoice —
   * only the button differs.
   */
  readonly onTicketPreview?: (() => void) | null
}) {
  const { t } = useTranslation()
  const subtotal = shown?.subtotal ?? order.lines.reduce((a, l) => a + l.line_total, 0)
  return (
    <section
      aria-label={t('pos.checkoutSummary')}
      className="mb-3 rounded-md border border-border bg-surface-muted"
    >
      <div className="flex flex-col gap-0.5 px-3 py-2 text-sm">
        <div className="flex items-center justify-between text-foreground-muted">
          <span>{t('pos.subtotal')}</span>
          <MoneyDisplay amount={subtotal} />
        </div>
        <div className="flex items-center justify-between text-foreground-muted">
          <span>
            {t('pos.discount')}
            {discountLabel ? <span className="ms-1 text-xs">({discountLabel})</span> : null}
          </span>
          <MoneyDisplay amount={shown?.discount_minor ?? 0} />
        </div>
        <div className="flex items-center justify-between text-foreground-muted">
          <span>{t('pos.serviceCharge')}</span>
          <MoneyDisplay amount={shown?.service_charge_minor ?? 0} />
        </div>
        {/*
          The total payable is the ONE number the sale turns on, so it is stated
          once, at a size and weight nothing else on the card uses, on its own
          tinted row rather than as a fourth line among three quieter ones. The
          figure itself is unchanged — it is still the backend preview's total.
        */}
        <div className="mt-1 flex items-center justify-between rounded-md bg-surface px-2 py-1.5 text-lg font-black text-foreground-strong">
          <span>{t('pos.total')}</span>
          <MoneyDisplay amount={shown?.total ?? subtotal} className="text-lg font-black" />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border-subtle px-3 py-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground-muted">
          <User size={15} aria-hidden className="shrink-0" />
          {customer ? (
            <span className="truncate font-medium text-foreground">{customer.name}</span>
          ) : (
            // "بدون عميل" is a real, recorded identity — not a blank field.
            <span className="text-xs font-medium">{t('pos.noCustomer')}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {customer ? (
            <Button variant="ghost" size="sm" onClick={onDetachCustomer} disabled={detaching}>
              <X size={15} aria-hidden />
              {t('pos.removeCustomer')}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onCustomer}>
            <UserPlus size={15} aria-hidden />
            {customer ? t('pos.changeCustomer') : t('pos.chooseCustomer')}
          </Button>
        </span>
      </div>
      {/*
        SERVICE CHARGE — an invoice-level charge, exactly like the discount, and
        never a product line. The amounts come from Dev Settings
        (`service_charge.amounts`) through the same settings command the POS
        already used, so no value is hardcoded here, and applying one needs NO
        authorization: a normal cashier selects it directly, which is the one
        deliberate difference from the privileged discount flow.
      */}
      {serviceChargeOptions.length ? (
        <div className="flex flex-col gap-1.5 border-t border-border-subtle px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-caption font-medium text-foreground-muted">
              <HandCoins size={15} aria-hidden />
              {t('pos.serviceCharge')}
            </span>
            <span className="flex flex-wrap items-center gap-1">
              <Button
                size="sm"
                variant={serviceCharge === 0 ? 'secondary' : 'ghost'}
                aria-pressed={serviceCharge === 0}
                onClick={() => onServiceCharge(0)}
              >
                {t('pos.noServiceCharge')}
              </Button>
              {serviceChargeOptions.map((amount) => (
                <Button
                  key={amount}
                  size="sm"
                  variant={serviceCharge === amount ? 'default' : 'outline'}
                  aria-pressed={serviceCharge === amount}
                  aria-label={t('pos.serviceChargeOption', {
                    amount: formatMinorMoney(amount, { variant: 'auto' }),
                  })}
                  onClick={() => onServiceCharge(amount)}
                >
                  <MoneyDisplay amount={amount} />
                </Button>
              ))}
            </span>
          </div>
          {/* States the authorization model in the UI instead of implying a hidden
              manager step the cashier cannot perform. */}
          <span className="text-caption text-foreground-subtle">
            {serviceCharge === 0
              ? t('pos.serviceChargeNone')
              : t('pos.serviceChargeApplied', {
                  amount: formatMinorMoney(serviceCharge, { variant: 'auto' }),
                })}
          </span>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-3 py-2">
        <Button variant="destructiveGhost" size="sm" onClick={onDiscount}>
          <Tag size={15} aria-hidden />
          {discountLabel ?? t('pos.addDiscount')}
        </Button>
        {onTicket ? (
          <Button variant="ghost" size="sm" onClick={onTicket}>
            <Ticket size={15} aria-hidden />
            {t('pos.washTicket')}
          </Button>
        ) : null}
        <span className="flex-1" />
        {/*
          The wash-ticket preview is a COMPACT trigger: the ticket is a small
          operational document, so it must not compete with the invoice preview
          or the pay action. It opens the same shared preview dialog — only the
          presentation differs.
        */}
        {onTicketPreview ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onTicketPreview}
            title={t('pos.ticketPreview')}
            aria-label={t('pos.ticketPreview')}
          >
            <Ticket size={16} aria-hidden />
          </Button>
        ) : null}
        {/* Print preview sits beside the pay action: it shows the invoice
            document the printer draws, before anything is finalized. */}
        <Button
          variant="outline"
          size="sm"
          onClick={onPrintPreview ?? undefined}
          disabled={!onPrintPreview}
          aria-label={t('pos.printPreview')}
        >
          <Eye size={15} aria-hidden />
          {t('pos.printPreview')}
        </Button>
        {/*
          Payment stays a single, unmistakable action. `lg` gives it a full-height
          target in the workspace's narrow order column, where it is pressed
          repeatedly; below that it is the same button at the inline-end of the
          action row. Same handler, same command, same authorization rules.
        */}
        <Button
          size="lg"
          className="lg:w-full"
          onClick={onReviewPay}
          disabled={order.lines.length === 0}
        >
          <Wallet size={16} aria-hidden />
          {t('pos.reviewAndPay')}
        </Button>
      </div>
    </section>
  )
}

export function TotalsBlock({ shown }: Readonly<{ readonly shown: OrderPreview }>) {
  const { t } = useTranslation()
  return (
    <div className="mb-3 flex flex-col gap-1 rounded-md border border-border-subtle bg-surface-muted p-2.5 text-sm">
      <div className="flex justify-between text-foreground-muted">
        <span>{t('pos.subtotal')}</span>
        <MoneyDisplay amount={shown.subtotal} />
      </div>
      <div className="flex justify-between text-foreground-muted">
        <span>{t('pos.discount')}</span>
        <MoneyDisplay amount={shown.discount_minor} />
      </div>
      <div className="flex justify-between text-foreground-muted">
        <span>{t('pos.serviceCharge')}</span>
        <MoneyDisplay amount={shown.service_charge_minor} />
      </div>
      <div className="flex justify-between border-t border-border-subtle pt-1.5 text-base font-bold">
        <span>{t('pos.total')}</span>
        <MoneyDisplay amount={shown.total} />
      </div>
    </div>
  )
}
