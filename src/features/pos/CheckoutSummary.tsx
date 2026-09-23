/** Compact checkout summary: totals + optional customer + single pay action. */
import { useTranslation } from 'react-i18next'
import { Button, MoneyDisplay } from '@/components/ui'
import { Eye, Percent, Ticket, User, UserPlus, Wallet, X } from '@/components/ui/icon'
import type { OrderCustomer, OrderPreview, PosOrder } from '@/services/posApi'

export function CheckoutSummary({
  order,
  shown,
  customer,
  discountLabel,
  onDiscount,
  onLimit,
  canManageLimits,
  onCustomer,
  onDetachCustomer,
  detaching,
  onTicket,
  onReviewPay,
  onPrintPreview,
  printPreviewHint,
}: {
  order: PosOrder
  shown: OrderPreview | null
  customer: OrderCustomer | null
  discountLabel: string | null
  onDiscount: () => void
  onLimit: () => void
  canManageLimits: boolean
  onCustomer: () => void
  onDetachCustomer: () => void
  detaching: boolean
  onTicket: (() => void) | null
  onReviewPay: () => void
  /** Print preview of the order's printable document; null when none exists yet. */
  onPrintPreview: (() => void) | null
  printPreviewHint?: string | null
}) {
  const { t } = useTranslation()
  const subtotal = shown?.subtotal ?? order.lines.reduce((a, l) => a + l.line_total, 0)
  return (
    <section
      aria-label={t('pos.checkoutSummary')}
      className="mb-3 rounded-md border border-border bg-surface-muted/40"
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
        <div className="mt-1 flex items-center justify-between border-t border-border-subtle pt-1.5 text-base font-bold">
          <span>{t('pos.total')}</span>
          <MoneyDisplay amount={shown?.total ?? subtotal} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border-subtle px-3 py-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground-muted">
          <User size={15} aria-hidden className="shrink-0" />
          {customer ? (
            <span className="truncate font-medium text-foreground">{customer.name}</span>
          ) : (
            <span className="text-xs">{t('pos.noCustomer')}</span>
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
      <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-3 py-2">
        <Button variant="outline" size="sm" onClick={onDiscount}>
          <Percent size={15} aria-hidden />
          {discountLabel ?? t('pos.discount')}
        </Button>
        {canManageLimits ? (
          <Button variant="ghost" size="sm" onClick={onLimit}>
            {t('pos.discountLimitShort')}
          </Button>
        ) : null}
        {onTicket ? (
          <Button variant="ghost" size="sm" onClick={onTicket}>
            <Ticket size={15} aria-hidden />
            {t('pos.washTicket')}
          </Button>
        ) : null}
        <span className="flex-1" />
        {/* Print preview sits beside the pay action: it shows the document the
            printer draws (or is disabled while no such document exists yet). */}
        <Button
          variant="outline"
          size="sm"
          onClick={onPrintPreview ?? undefined}
          disabled={!onPrintPreview}
          title={onPrintPreview ? undefined : (printPreviewHint ?? undefined)}
          aria-label={t('pos.printPreview')}
        >
          <Eye size={15} aria-hidden />
          {t('pos.printPreview')}
        </Button>
        <Button size="sm" onClick={onReviewPay} disabled={order.lines.length === 0}>
          <Wallet size={15} aria-hidden />
          {t('pos.reviewAndPay')}
        </Button>
      </div>
      {!onPrintPreview && printPreviewHint ? (
        <p className="border-t border-border-subtle px-3 py-1.5 text-xs text-foreground-subtle">
          {printPreviewHint}
        </p>
      ) : null}
    </section>
  )
}

export function TotalsBlock({ shown }: { shown: OrderPreview }) {
  const { t } = useTranslation()
  return (
    <div className="mb-3 flex flex-col gap-1 rounded-md border border-border-subtle bg-surface-muted/60 p-2.5 text-sm">
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
