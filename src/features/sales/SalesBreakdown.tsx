/**
 * The sales breakdown: how the settled money was taken, and how the invoiced
 * money is split between the two business lines.
 *
 * The two axes are deliberately kept apart, because mixing them would double
 * count a hybrid order:
 *
 *  - **Payment method** comes from the `payments` ledger of non-cancelled
 *    invoices, so the three rows are SETTLED money. The card says so, and it
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
 */
import { useTranslation } from 'react-i18next'
import { Card, MoneyDisplay } from '@/components/ui'
import {
  Coffee,
  Droplets,
  HandCoins,
  ShoppingBag,
  Wallet,
  type LucideIcon,
} from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import type { SalesSummary } from '@/services/salesApi'

interface Slice {
  key: string
  label: string
  amount: number
  share: number
  icon: LucideIcon
  /** A Station semantic token, so light and dark mode stay the theme's job. */
  tone: string
}

/** The bar itself: a proportional fill plus the number, never colour alone. */
function SliceRow({ slice }: { slice: Slice }) {
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 font-medium">
          <span className="flex size-6 shrink-0 items-center justify-center rounded bg-accent text-primary">
            <slice.icon size={13} aria-hidden />
          </span>
          <span className="truncate">{slice.label}</span>
        </span>
        <span className="flex shrink-0 items-center gap-3 tabular-nums">
          <MoneyDisplay amount={slice.amount} variant="auto" className="text-foreground" />
          <strong className="min-w-10 text-end text-foreground-strong">{slice.share}%</strong>
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
        role="img"
        aria-label={`${slice.label}: ${slice.share}%`}
      >
        <div
          className={cn('h-full rounded-full', slice.tone)}
          style={{ width: `${slice.share}%` }}
        />
      </div>
    </li>
  )
}

function BreakdownCard({
  title,
  hint,
  slices,
  className,
}: {
  title: string
  hint: string
  slices: Slice[]
  className?: string
}) {
  return (
    <Card className={className}>
      <h2 className="text-section text-foreground-strong">{title}</h2>
      <p className="mt-0.5 mb-3 text-caption text-foreground-subtle">{hint}</p>
      <ul className="flex flex-col gap-3">
        {slices.map((slice) => (
          <SliceRow key={slice.key} slice={slice} />
        ))}
      </ul>
    </Card>
  )
}

/** Whole-percent share of a part against a whole, mirroring the backend rule. */
function share(part: number, whole: number): number {
  return whole > 0 ? Math.round((part * 100) / whole) : 0
}

export function SalesBreakdown({
  summary,
  className,
}: {
  summary: SalesSummary
  className?: string
}) {
  const { t } = useTranslation()
  const settled = summary.cash + summary.card + summary.credit
  const business = summary.cafe_sales + summary.wash_sales

  return (
    <div className={cn('grid grid-cols-1 gap-4 lg:grid-cols-2', className)}>
      <BreakdownCard
        title={t('sales.breakdown.paymentTitle')}
        hint={t('sales.breakdown.paymentHint')}
        slices={[
          {
            key: 'cash',
            label: t('pay.method.CASH'),
            amount: summary.cash,
            share: summary.cash_share,
            icon: Wallet,
            tone: 'bg-success',
          },
          {
            key: 'card',
            label: t('pay.method.CARD'),
            amount: summary.card,
            share: summary.card_share,
            icon: ShoppingBag,
            tone: 'bg-info',
          },
          {
            key: 'credit',
            label: t('pay.method.CREDIT'),
            amount: summary.credit,
            share: summary.credit_share,
            icon: HandCoins,
            tone: 'bg-warning',
          },
        ]}
      />
      <BreakdownCard
        title={t('sales.breakdown.businessTitle')}
        hint={t('sales.breakdown.businessHint')}
        slices={[
          {
            key: 'cafe',
            label: t('catalog.CAFE'),
            amount: summary.cafe_sales,
            share: share(summary.cafe_sales, business),
            icon: Coffee,
            tone: 'bg-info',
          },
          {
            key: 'wash',
            label: t('catalog.WASH'),
            amount: summary.wash_sales,
            share: share(summary.wash_sales, business),
            icon: Droplets,
            tone: 'bg-primary',
          },
        ]}
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
