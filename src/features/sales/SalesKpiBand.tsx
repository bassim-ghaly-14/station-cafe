/**
 * The sales KPI band.
 *
 * Financial semantics — every tile is an aggregate the backend computed from
 * the invoice snapshot, and each label says exactly what it is:
 *
 *  - **إجمالي المبيعات** is `SUM(invoice.total)`. Checkout persists
 *    `total = subtotal − discount + service_charge`, so it is already net of
 *    discounts and inclusive of service charges. It is NOT profit: Station
 *    stores no cost, so no margin figure exists anywhere in this band.
 *  - **قيمة الفواتير قبل الخصومات** is `SUM(invoice.subtotal)`, the same
 *    invoices before the discount. It is a gross comparator, never a second
 *    "revenue".
 *  - **Cash / card / credit** come from the payments ledger. A credit invoice
 *    is invoiced credit, never collected cash, so the three tiles need not add
 *    up to revenue — the breakdown states that too.
 *
 * Layout: a hero tile for the headline revenue plus a compact strip for the
 * supporting figures, instead of a wall of identical cards.
 */
import { useTranslation } from 'react-i18next'
import { Card, MoneyDisplay, Skeleton } from '@/components/ui'
import {
  Coffee,
  Droplets,
  HandCoins,
  Percent,
  ShoppingBag,
  Ticket,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import type { SalesSummary } from '@/services/salesApi'

/** 1 → 2 → 3 → 4. The strip never squeezes a tile into illegibility. */
const STRIP_GRID = 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'

function StatTile({
  icon: Icon,
  label,
  hint,
  children,
}: {
  readonly icon: LucideIcon
  readonly label: string
  readonly hint?: string
  readonly children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border-subtle bg-surface-card p-3">
      <div className="flex items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded bg-accent text-primary">
          <Icon size={13} aria-hidden />
        </span>
        <p className="min-w-0 truncate text-caption">{label}</p>
      </div>
      <p className="text-lg leading-tight font-bold text-foreground-strong tabular-nums">
        {children}
      </p>
      {hint ? <p className="truncate text-caption text-foreground-subtle">{hint}</p> : null}
    </div>
  )
}

export function SalesKpiBand({
  summary,
  loading,
  className,
}: {
  readonly summary: SalesSummary | null
  readonly loading: boolean
  readonly className?: string
}) {
  const { t } = useTranslation()

  if (loading && !summary) {
    return (
      <output
        aria-busy="true"
        aria-label={t('sales.kpi.loading')}
        className={cn('block', className)}
      >
        <Card className="mb-3 flex flex-col gap-3 p-4">
          <Skeleton variant="text" className="h-3 w-32" accessibilityLabel="" />
          <Skeleton variant="text" className="h-8 w-56" accessibilityLabel="" />
        </Card>
        <div className={STRIP_GRID}>
          {Array.from({ length: 8 }, (_, index) => (
            <Card key={index} className="flex flex-col gap-2 p-3">
              <Skeleton variant="text" className="h-3 w-20" accessibilityLabel="" />
              <Skeleton variant="text" className="h-5 w-24" accessibilityLabel="" />
            </Card>
          ))}
        </div>
        <span className="sr-only">{t('sales.kpi.loading')}</span>
      </output>
    )
  }

  if (!summary) return null

  return (
    <div className={cn('flex flex-col gap-3', className)} aria-busy={loading || undefined}>
      {/* The headline: what was sold, in one dominant number, with the two
          figures that give it meaning stated right beside it. */}
      <Card className="flex flex-wrap items-end justify-between gap-4 p-4">
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-caption">
            <TrendingUp size={15} aria-hidden className="text-primary" />
            {t('sales.kpi.revenue')}
          </p>
          <MoneyDisplay
            amount={summary.total_sales}
            variant="auto"
            className="text-3xl leading-tight font-extrabold text-foreground-strong"
          />
          <p className="text-caption text-foreground-subtle">{t('sales.kpi.revenueHint')}</p>
        </div>

        <dl className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex flex-col">
            <dt className="text-caption">{t('sales.kpi.gross')}</dt>
            <dd>
              <MoneyDisplay
                amount={summary.subtotal}
                variant="auto"
                className="text-base font-bold text-foreground-strong"
              />
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-caption">{t('sales.kpi.invoices')}</dt>
            <dd className="text-base font-bold text-foreground-strong tabular-nums">
              {summary.invoices_count}
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-caption">{t('sales.kpi.average')}</dt>
            <dd>
              <MoneyDisplay
                amount={summary.average_invoice}
                variant="auto"
                className="text-base font-bold text-foreground-strong"
              />
            </dd>
          </div>
        </dl>
      </Card>

      {/* The supporting figures. Every one of them is a real aggregate. */}
      <div className={STRIP_GRID}>
        <StatTile icon={Percent} label={t('sales.kpi.discounts')}>
          <MoneyDisplay amount={summary.discounts} variant="auto" />
        </StatTile>
        <StatTile icon={Ticket} label={t('sales.kpi.serviceCharge')}>
          <MoneyDisplay amount={summary.service_charges} variant="auto" />
        </StatTile>
        <StatTile icon={Wallet} label={t('sales.kpi.cash')} hint={`${summary.cash_share}%`}>
          <MoneyDisplay amount={summary.cash} variant="auto" />
        </StatTile>
        <StatTile icon={ShoppingBag} label={t('sales.kpi.card')} hint={`${summary.card_share}%`}>
          <MoneyDisplay amount={summary.card} variant="auto" />
        </StatTile>
        <StatTile icon={HandCoins} label={t('sales.kpi.credit')} hint={`${summary.credit_share}%`}>
          <MoneyDisplay amount={summary.credit} variant="auto" />
        </StatTile>
        <StatTile icon={Coffee} label={t('sales.kpi.cafe')}>
          <MoneyDisplay amount={summary.cafe_sales} variant="auto" />
        </StatTile>
        <StatTile icon={Droplets} label={t('sales.kpi.wash')}>
          <MoneyDisplay amount={summary.wash_sales} variant="auto" />
        </StatTile>
      </div>
    </div>
  )
}
