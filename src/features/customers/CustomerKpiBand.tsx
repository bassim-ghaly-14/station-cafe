/**
 * The customer KPI band (MANAGER+).
 *
 * Every tile is a real aggregate computed in SQL by the customers overview
 * command — there is no decorative figure and no client-side arithmetic. The
 * two "leader" tiles name a real customer with the number that made them the
 * leader, or state plainly that nobody leads the period.
 *
 * The two axes Station actually stores are kept visibly separate so a hybrid
 * order is never read twice: department (كافيه / مغسلة) comes from the invoice
 * snapshot totals, while order type (طاولات / طلب خارجي) comes from the
 * invoice's own `order_type`.
 *
 * Layout
 * ------
 * The metrics themselves are preserved exactly as they are; only the
 * presentation changed. A plain CSS grid runs 1 → 2 → 3 → 5 columns, so the
 * desktop band is a single row of five, a tablet drops to three without
 * shrinking the cards, and a phone stacks them. No card is squeezed into
 * illegibility, and no sixth tile is invented to fill a row.
 */
import { useTranslation } from 'react-i18next'
import {
  Card,
  KpiBreakdown,
  KpiBreakdownEntry,
  KpiGrid,
  MoneyDisplay,
  Skeleton,
} from '@/components/ui'
import {
  Coffee,
  Droplets,
  HandCoins,
  Receipt,
  ShoppingBag,
  TrendingUp,
  User,
  Users,
  Wallet,
} from '@/components/ui/icon'
import type { LucideIcon } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import type { CustomerOverview } from '@/services/customersApi'

/** The band's grid is the SHARED KPI rule (`KpiGrid`): one tile per row on a
 * phone, then the same 2 → 3 → 5 progression the desktop already had. The
 * phone step used to be two columns from 360px up, which is what truncated an
 * Arabic label to nothing on a 360px phone. */

/** One tile: label, value, and an optional second line of context. */
function KpiTile({
  icon: Icon,
  label,
  children,
  hint,
  className,
}: {
  readonly icon: LucideIcon
  readonly label: string
  readonly children: React.ReactNode
  /** Optional second line: a count, a name, or an amount. */
  readonly hint?: React.ReactNode
  readonly className?: string
}) {
  return (
    <Card
      className={cn(
        // Subtle surface contrast and a hairline border instead of a heavy
        // bordered tile: hierarchy comes from spacing and type weight, not
        // from a box around every number.
        'group flex flex-col gap-2 border-border-subtle bg-surface-card p-3.5 transition-colors hover:border-border-strong motion-reduce:transition-none',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-primary transition-colors group-hover:bg-accent-hover">
          <Icon size={15} aria-hidden />
        </span>
        <p className="min-w-0 truncate text-caption">{label}</p>
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="text-[1.375rem] leading-tight font-bold tabular-nums text-foreground-strong">
          {children}
        </span>
        {hint ? <span className="truncate text-caption text-foreground-subtle">{hint}</span> : null}
      </div>
    </Card>
  )
}

function Count({ value }: Readonly<{ readonly value: number }>) {
  return <span className="tabular-nums">{value}</span>
}

/**
 * The takeaway card: ONE total, split by the only two order kinds Station stores.
 *
 * # Why this card was reshaped
 *
 * It used to render the takeaway figure alone under the label "طلبات طلب خارجي"
 * with the hint "منها {{count}} طلب طاولة" — "of which N table orders". That hint
 * asserts table orders are a SUBSET of takeaways, which is false: `order_type`
 * is a two-valued enum (`TABLE` | `TAKEAWAY`, enforced by a CHECK constraint), so
 * the two figures partition the period's invoices and neither contains the other.
 * A reader was invited to subtract one from the other and get a wrong answer.
 *
 * # What the card now says
 *
 *     إجمالي الطلبات
 *              TOTAL          ← table orders + external orders
 *     ─────────────────────────────
 *         طلبات الطاولة  X
 *       الطلبات الخارجية  Y
 *
 * The hero is the whole, and the two rows beneath it are exactly its parts, so the
 * card states the relationship instead of implying one. Both figures are the
 * backend's own — `customer_analytics::overview` already returns them as two
 * disjoint aggregates over the same query — so this is presentation only: no
 * classification is invented, and no order is counted twice or dropped.
 *
 * # Design
 *
 * It is the SAME shape as the employees headcount tile — "إجمالي الطلبات" with
 * its total, then the two categories that make that total up beneath a hairline
 * (`2 — الكاشير` / `0 — عمال المغسلة`). That tile established the visual
 * language for "one hero number with two supporting halves", so this card
 * reuses the shared `KpiBreakdown` rather than inventing a third arrangement:
 * hero above, figure-above-label breakdown below, identical spacing and
 * containment.
 *
 * The hero sits at `1.75rem` against the breakdown's `1.125rem` — a clear
 * primary/supporting relationship without enlarging the card. No nested card is
 * introduced, so the band keeps its one-row rhythm on a desktop and its
 * one-tile-per-row phone rule.
 */
function CustomerOrderKindsCard({
  overview,
  className,
}: {
  readonly overview: CustomerOverview
  readonly className?: string
}) {
  const { t } = useTranslation()
  // The hero is the SUM of the two backend figures, which is also exactly the
  // period's invoice count for these customers. Both parts are stated below it, so
  // the reader can verify the total rather than trust it.
  const total = overview.table_orders + overview.takeaway_orders
  return (
    <Card className={cn('flex flex-col gap-3 p-4', className)}>
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-2 text-caption">
          <ShoppingBag size={15} aria-hidden className="text-primary" />
          {t('customers.kpi.orderKinds.title')}
        </p>
        <p
          className="text-[1.75rem] leading-tight font-extrabold text-foreground-strong tabular-nums"
          data-testid="customers-order-kinds-hero"
        >
          {total}
        </p>
        <p className="text-caption text-foreground-subtle">{t('customers.kpi.orderKinds.hint')}</p>
      </div>

      {/* The two categories are the WHOLE, split — the same hero-then-breakdown
          structure the employees headcount tile uses, and the same shared
          primitive, so the two cards read as one family. `mt-auto` pins the
          breakdown to the bottom of the card and the hairline separates "the
          total" from "its parts" rather than running them together. */}
      <div className="mt-auto border-t border-border-subtle pt-3">
        <KpiBreakdown>
          <KpiBreakdownEntry
            label={t('customers.kpi.orderKinds.table')}
            value={overview.table_orders}
          />
          <KpiBreakdownEntry
            label={t('customers.kpi.orderKinds.external')}
            value={overview.takeaway_orders}
          />
        </KpiBreakdown>
      </div>
    </Card>
  )
}

export function CustomerKpiBand({
  overview,
  loading,
  className,
}: {
  readonly overview: CustomerOverview | null
  readonly loading: boolean
  readonly className?: string
}) {
  const { t } = useTranslation()

  if (loading && !overview) {
    return (
      <KpiGrid
        as="output"
        xl={5}
        className={className}
        aria-busy="true"
        aria-label={t('customers.kpi.loading')}
      >
        {Array.from({ length: 5 }, (_, index) => (
          <Card key={index} className="flex flex-col gap-2 border-border-subtle p-3.5">
            <Skeleton variant="rect" className="size-7" accessibilityLabel="" />
            <div className="flex-1 space-y-2">
              <Skeleton variant="text" className="h-3 w-1/2" accessibilityLabel="" />
              <Skeleton variant="text" className="h-5 w-2/3" accessibilityLabel="" />
            </div>
          </Card>
        ))}
        <span className="sr-only">{t('customers.kpi.loading')}</span>
      </KpiGrid>
    )
  }

  if (!overview) return null

  return (
    <KpiGrid xl={5} className={className} aria-busy={loading || undefined}>
      <KpiTile icon={Users} label={t('customers.kpi.total')}>
        <Count value={overview.total_customers} />
      </KpiTile>

      <KpiTile
        icon={User}
        label={t('customers.kpi.active')}
        hint={t('customers.kpi.activeHint', { orders: overview.total_orders })}
      >
        <Count value={overview.active_customers} />
      </KpiTile>

      <KpiTile icon={Wallet} label={t('customers.kpi.paid')}>
        <MoneyDisplay amount={overview.total_paid} variant="auto" />
      </KpiTile>

      <KpiTile icon={TrendingUp} label={t('customers.kpi.average')}>
        <MoneyDisplay amount={overview.average_spend} variant="auto" />
      </KpiTile>

      {/* Fifth tile of the desktop row: a standing balance, so it is promoted
          next to the other money figures rather than left at the end. */}
      <KpiTile
        icon={HandCoins}
        label={t('customers.kpi.outstandingCredit')}
        hint={t('customers.kpi.creditHint')}
      >
        <MoneyDisplay amount={overview.outstanding_credit} variant="auto" />
      </KpiTile>

      <KpiTile
        icon={Receipt}
        label={t('customers.kpi.topOrders')}
        hint={
          overview.top_by_orders
            ? t('customers.kpi.topOrdersHint', { count: overview.top_by_orders.value })
            : t('customers.kpi.none')
        }
      >
        {overview.top_by_orders ? (
          <span className="truncate">{overview.top_by_orders.name}</span>
        ) : (
          <span className="text-foreground-faint">—</span>
        )}
      </KpiTile>

      <KpiTile
        icon={Wallet}
        label={t('customers.kpi.topSpend')}
        hint={
          overview.top_by_spend ? (
            <MoneyDisplay amount={overview.top_by_spend.value} variant="auto" />
          ) : (
            t('customers.kpi.none')
          )
        }
      >
        {overview.top_by_spend ? (
          <span className="truncate">{overview.top_by_spend.name}</span>
        ) : (
          <span className="text-foreground-faint">—</span>
        )}
      </KpiTile>

      <KpiTile icon={Coffee} label={t('customers.kpi.cafeOrders')}>
        <Count value={overview.cafe_orders} />
      </KpiTile>

      <KpiTile icon={Droplets} label={t('customers.kpi.washOrders')}>
        <Count value={overview.wash_orders} />
      </KpiTile>
    </KpiGrid>
  )
}

/**
 * The order-kind card, rendered as its own full-width row beneath the band.
 *
 * It carries a hero and a breakdown, so it does not belong in the one-row KPI
 * grid: a tile with a sub-structure inside it would be the "excessive nested
 * card" the design system avoids. Giving it its own row keeps its hierarchy
 * intact and lets it span the width its two labelled rows need.
 */
export function CustomerOrderKinds({
  overview,
  loading,
  className,
}: {
  readonly overview: CustomerOverview | null
  readonly loading: boolean
  readonly className?: string
}) {
  const { t } = useTranslation()

  if (loading && !overview) {
    return (
      <Card
        aria-busy="true"
        aria-label={t('customers.kpi.loading')}
        className={cn('flex flex-col gap-3 p-4', className)}
      >
        <Skeleton variant="text" className="h-3 w-32" accessibilityLabel="" />
        <Skeleton variant="text" className="h-8 w-56" accessibilityLabel="" />
      </Card>
    )
  }

  if (!overview) return null

  return (
    <div className={cn('mt-3', className)} aria-busy={loading || undefined}>
      <CustomerOrderKindsCard overview={overview} />
    </div>
  )
}
