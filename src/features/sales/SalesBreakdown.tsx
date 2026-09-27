/**
 * The sales breakdown: how the settled money was taken, and how the invoiced
 * money is split between the two business lines.
 *
 * The two axes are deliberately kept apart, because mixing them would double
 * count a hybrid order:
 *
 *  - **Payment method** comes from the `payments` ledger, so the three rows are
 *    SETTLED money. The card says so, and it
 *    therefore does not have to equal total revenue when a credit invoice is
 *    still outstanding.
 *  - **Business type** comes from the invoice snapshot totals (`cafe_total` /
 *    `wash_total`), which sum to the invoice subtotal. A hybrid invoice appears
 *    in both rows — once per business line — which is exactly what those two
 *    figures mean.
 *
 * The share percentages are the ones the backend sent for the payment methods;
 * the two business-line shares are the display ratio of the two snapshot totals
 * the backend sent, rounded exactly as the backend rounds its own shares. The
 * bar widths are sized from the very same numbers, so the visual and the figure
 * can never disagree, and colour is never the only signal — the percentage is
 * printed and the bar carries an accessible label.
 *
 * The card itself is the SHARED `ProportionCard`, the same component the
 * Expenses category ranking uses; only the slices are sales-specific.
 */
import { useTranslation } from 'react-i18next'
import { ProportionCard, type ProportionSlice } from '@/components/charts/ProportionCard'
import { MoneyDisplay } from '@/components/ui'
import { Coffee, Droplets, HandCoins, ShoppingBag, Wallet } from '@/components/ui/icon'
import { chartBarColor } from '@/lib/chart-colors'
import { cn } from '@/lib/utils'
import type { SalesSummary } from '@/services/salesApi'

/** Whole-percent share of a part against a whole, mirroring the backend rule. */
function share(part: number, whole: number): number {
  return whole > 0 ? Math.round((part * 100) / whole) : 0
}

export function SalesBreakdown({
  summary,
  className,
}: {
  readonly summary: SalesSummary
  readonly className?: string
}) {
  const { t } = useTranslation()
  const settled = summary.cash + summary.card + summary.credit
  const business = summary.cafe_sales + summary.wash_sales

  return (
    <div className={cn('grid grid-cols-1 gap-4 lg:grid-cols-2', className)}>
      <ProportionCard
        title={t('sales.breakdown.paymentTitle')}
        hint={t('sales.breakdown.paymentHint')}
        slices={
          [
            {
              key: 'cash',
              label: t('pay.method.CASH'),
              amount: summary.cash,
              share: summary.cash_share,
              icon: Wallet,
              color: chartBarColor('quaternary'),
            },
            {
              key: 'card',
              label: t('pay.method.CARD'),
              amount: summary.card,
              share: summary.card_share,
              icon: ShoppingBag,
              color: chartBarColor('secondary'),
            },
            {
              key: 'credit',
              label: t('pay.method.CREDIT'),
              amount: summary.credit,
              share: summary.credit_share,
              icon: HandCoins,
              color: chartBarColor('tertiary'),
            },
          ] satisfies ProportionSlice[]
        }
      />
      <ProportionCard
        title={t('sales.breakdown.businessTitle')}
        hint={t('sales.breakdown.businessHint')}
        slices={
          [
            {
              key: 'cafe',
              label: t('catalog.CAFE'),
              amount: summary.cafe_sales,
              share: share(summary.cafe_sales, business),
              icon: Coffee,
              color: chartBarColor('secondary'),
            },
            {
              key: 'wash',
              label: t('catalog.WASH'),
              amount: summary.wash_sales,
              share: share(summary.wash_sales, business),
              icon: Droplets,
              color: chartBarColor('primary'),
            },
          ] satisfies ProportionSlice[]
        }
      />
      {/* Stating the settled total keeps the honest gap visible: invoiced
          revenue can exceed it while a credit invoice is still open. */}
      <p className="flex flex-wrap items-center gap-1.5 text-caption text-foreground-subtle lg:col-span-2">
        {t('sales.breakdown.settledNote')}
        <MoneyDisplay amount={settled} variant="auto" className="font-bold text-foreground" />
      </p>
    </div>
  )
}
