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
import { Card, KpiGrid, KpiTile, MoneyDisplay, Skeleton } from '@/components/ui'
import {
  Coffee,
  Droplets,
  HandCoins,
  Layers,
  Percent,
  Receipt,
  ShoppingBag,
  Ticket,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import type { SalesSummary } from '@/services/salesApi'

/* The band's grid is the SHARED KPI rule (`KpiGrid`): one tile per row on a
   phone, then the same 2 → 3 → 4 progression the desktop already had. The
   phone step used to be two columns from 360px up, which is what truncated an
   Arabic label to nothing on a 360px phone. */
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
    <KpiTile icon={<Icon size={13} aria-hidden />} label={label} hint={hint}>
      {children}
    </KpiTile>
  )
}
/**
 * One secondary box: a KIND of invoice and how many documents of that kind the
 * period holds.
 *
 * The value is a COUNT, so it is rendered as a plain integer and is deliberately
 * NOT wrapped in `MoneyDisplay`: that component reads its argument as piasters
 * and divides it by 100, which would turn 6 invoices into `0.06 ج.م`. The
 * subdued weight is what makes it read as supporting detail under the hero.
 */
function KindBox({
  icon: Icon,
  label,
  count,
}: {
  readonly icon: LucideIcon
  readonly label: string
  readonly count: number
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border-subtle bg-surface-card px-3 py-2">
      <span className="flex min-w-0 items-center gap-2 text-caption">
        <Icon size={13} aria-hidden className="shrink-0 text-primary" />
        <span className="min-w-0 truncate">{label}</span>
      </span>
      <span className="text-base font-bold text-foreground-strong tabular-nums">{count}</span>
    </div>
  )
}

/**
 * The invoice-COUNT card: how many documents the period produced, and how they
 * break down by kind.
 *
 * The total is the HERO of this card and is stated as an integer count — never as
 * money, and never as an average. The four boxes beneath it are the SAME period's
 * invoices partitioned by the document kind the printer itself already uses, so
 * the four always add up to the hero above them. A hybrid invoice is counted once
 * here while its money still appears in both departments, which is why the card
 * says so rather than leaving the reader to reconcile the two by hand.
 */
function SalesInvoiceKindCard({
  summary,
  className,
}: {
  readonly summary: SalesSummary
  readonly className?: string
}) {
  const { t } = useTranslation()

  return (
    <Card className={cn('flex flex-col gap-3 p-4', className)}>
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-2 text-caption">
          <Receipt size={15} aria-hidden className="text-primary" />
          {t('sales.kpi.invoiceKinds.title')}
        </p>
        {/* The hero count. `tabular-nums` keeps the digits aligned as the figure
            changes, and the number is rendered raw — a count is an integer. */}
        <p
          className="text-3xl leading-tight font-extrabold text-foreground-strong tabular-nums"
          data-testid="sales-invoice-count-hero"
        >
          {summary.invoices_count}
        </p>
        <p className="text-caption text-foreground-subtle">{t('sales.kpi.invoiceKinds.hint')}</p>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <KindBox
          icon={Coffee}
          label={t('sales.kpi.invoiceKinds.cafeOnly')}
          count={summary.cafe_invoices}
        />
        <KindBox
          icon={Droplets}
          label={t('sales.kpi.invoiceKinds.washOnly')}
          count={summary.wash_invoices}
        />
        <KindBox
          icon={Layers}
          label={t('sales.kpi.invoiceKinds.hybrid')}
          count={summary.hybrid_invoices}
        />
        <KindBox
          icon={ShoppingBag}
          label={t('sales.kpi.invoiceKinds.takeawayOnly')}
          count={summary.takeaway_invoices}
        />
      </div>
      <p className="text-caption text-foreground-subtle">
        {t('sales.kpi.invoiceKinds.breakdownHint')}
      </p>
    </Card>
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
        <KpiGrid>
          {Array.from({ length: 8 }, (_, index) => (
            <Card key={index} className="flex flex-col gap-2 p-3">
              <Skeleton variant="text" className="h-3 w-20" accessibilityLabel="" />
              <Skeleton variant="text" className="h-5 w-24" accessibilityLabel="" />
            </Card>
          ))}
        </KpiGrid>
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

      {/* How many DOCUMENTS the period produced, and of what kind. Its own card,
          because it is a count and not a money figure: it never shares a tile
          with an amount, so no reader can mistake it for one. */}
      <SalesInvoiceKindCard summary={summary} />

      {/* The supporting figures. Every one of them is a real aggregate. */}
      <KpiGrid>
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
      </KpiGrid>
    </div>
  )
}
