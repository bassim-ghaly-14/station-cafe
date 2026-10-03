/** Compact checkout summary: totals + optional customer + single pay action. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Field, Input, MoneyDisplay } from '@/components/ui'
import { Eye, HandCoins, Tag, Ticket, User, UserPlus, Wallet, X } from '@/components/ui/icon'
import { formatMinorMoney, formatMinorMoneyInput } from '@/lib/money'
import { parseMajor } from '@/lib/utils'
import type { OrderCustomer, OrderPreview, PosOrder } from '@/services/posApi'

/**
 * The custom-amount half of the service-charge control.
 *
 * It is deliberately the MIRROR of `DiscountDialog` with the authorization step
 * removed, because that contrast IS the business rule: a custom DISCOUNT is an
 * administrative act and asks for the shared PIN, while a custom SERVICE CHARGE
 * is ordinary till work and does not. Only the field, its validation and its
 * Apply action exist here — there is no PIN input, no authorization dialog and
 * no second round-trip.
 *
 * The money convention is the shared one (`parseMajor` / `formatMinorMoneyInput`,
 * the same pair the discount field uses): up to seven whole pounds and at most
 * two decimals, so a piaster-typed value can never be silently rounded, and a
 * sign, a letter or a three-decimal number is refused rather than coerced.
 *
 * Replacing, not stacking: `onApply` carries ONE amount, so typing a new figure
 * replaces the previous charge exactly the way tapping another quick amount
 * does. Zero is a legitimate outcome and means "no service charge", which is the
 * same thing the "No Service" button does.
 */
function ServiceChargeCustomAmount({
  current,
  error,
  onError,
  onApply,
}: {
  /** The amount currently on this invoice, in minor units. */
  readonly current: number
  readonly error: string | null
  readonly onError: (message: string | null) => void
  readonly onApply: (amount: number) => void
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')

  const apply = () => {
    const parsed = parseMajor(value)
    if (parsed === null) {
      onError(t('pos.invalidServiceChargeAmount'))
      return
    }
    onApply(parsed)
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={t('pos.serviceChargeCustom')} htmlFor="service-charge-custom" error={error}>
        <Input
          id="service-charge-custom"
          inputMode="decimal"
          dir="ltr"
          autoComplete="off"
          // The current charge is shown as the PLACEHOLDER rather than as the
          // field's value, so the draft a cashier is typing is never overwritten
          // by a re-render caused by their own Apply. It is the amount this
          // field accepts, not an empty-money hint — a service charge of 0 is a
          // real instruction ("no service charge"), so a generic "0.00" would
          // blur that.
          placeholder={
            current > 0 ? formatMinorMoneyInput(current) : t('pos.serviceChargeCustomPlaceholder')
          }
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            onError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              apply()
            }
          }}
        />
      </Field>

      <Button variant="outline" onClick={apply}>
        {t('pos.serviceChargeApply')}
      </Button>
    </div>
  )
}

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
  const [error, setError] = useState<string | null>(null)
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
        never a product line. TWO ways to set it, both on this one row:

          1. the QUICK amounts, configured in Dev Settings (`service_charge.amounts`)
             and read through the same settings command the POS already used, so no
             value is hardcoded here; and
          2. a CUSTOM amount the cashier types, because a service charge is not a
             closed set — a cafe that charges 37 on one table and 10 on the next
             must not have to reconfigure the app to say so.

        The quick amounts are SHORTCUTS, never a whitelist: the backend accepts
        any positive amount (`settings::resolve_service_charge`), and choosing a
        different one REPLACES the current charge rather than stacking on it.

        NO AUTHORIZATION anywhere on this path — selecting, typing, changing or
        clearing a service charge never asks for the shared discount PIN. That is
        the one deliberate difference from the privileged discount flow, and it is
        stated here rather than implied. Only the DISCOUNT needs a credential.
      */}
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
              onClick={() => {
                setError(null)
                onServiceCharge(0)
              }}
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
                onClick={() => {
                  setError(null)
                  onServiceCharge(amount)
                }}
              >
                <MoneyDisplay amount={amount} />
              </Button>
            ))}
          </span>
        </div>
        <ServiceChargeCustomAmount
          current={serviceCharge}
          error={error}
          onError={setError}
          onApply={(amount) => {
            setError(null)
            onServiceCharge(amount)
          }}
        />
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
