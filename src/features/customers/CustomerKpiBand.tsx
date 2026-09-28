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
 * snapshot totals, while order type (طاولات / تيك اواي) comes from the
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
import { Card, MoneyDisplay, Skeleton } from '@/components/ui'
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

/** 1 → 2 → 3 → 5. The five-column step only kicks in where a card still fits. */
const BAND_GRID = 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5'

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
      <output
        className={cn('block', BAND_GRID, className)}
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
      </output>
    )
  }

  if (!overview) return null

  return (
    <div className={cn(BAND_GRID, className)} aria-busy={loading || undefined}>
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

      <KpiTile
        icon={ShoppingBag}
        label={t('customers.kpi.takeawayOrders')}
        hint={t('customers.kpi.tableOrdersHint', { count: overview.table_orders })}
      >
        <Count value={overview.takeaway_orders} />
      </KpiTile>
    </div>
  )
}
