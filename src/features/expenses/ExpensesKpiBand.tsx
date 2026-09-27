/**
 * The expenses KPI band.
 *
 * Same visual language as the sales band — a hero figure for the headline, a
 * compact strip for the supporting readings — because they are the same
 * application. What differs is the SEMANTICS, and each tile says exactly what it
 * is:
 *
 *  - **إجمالي المصروفات** is `SUM(expenses.amount)` over the selected period,
 *    aggregated in SQL over every matching row. It is spend, not profit: Station
 *    stores no cost of goods, so no margin figure exists anywhere in this band.
 *  - **من الدرج (كاش)** is the part with `paid_from_cash = 1` — the money that
 *    physically left the drawer, and the figure a day closing reconciles against.
 *  - **مكرر** is the part flagged as a repeating commitment: the fixed baseline
 *    an operator pays again every week or month, kept apart from one-off buys.
 *
 * The cash and recurring tiles are INDEPENDENT slices, not a split of the
 * headline: a single expense can be both, and the band says so in words rather
 * than leaving the reader to work it out.
 */
import { useTranslation } from 'react-i18next'
import { ProportionCard, type ProportionSlice } from '@/components/charts/ProportionCard'
import { Card, MoneyDisplay, Skeleton } from '@/components/ui'
import { Coins, Receipt, Repeat, TrendingUp, Wallet, type LucideIcon } from '@/components/ui/icon'
import { CHART_BAR_TOKENS } from '@/lib/chart-colors'
import { cn } from '@/lib/utils'
import type { ExpenseOverview } from '@/services/opsApi'

/** 1 → 2 → 3 → 4. The strip never squeezes a tile into illegibility. */
const STRIP_GRID = 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'

function StatTile({
  icon: Icon,
  label,
  hint,
  children,
}: {
  icon: LucideIcon
  label: string
  hint?: string
  children: React.ReactNode
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

export function ExpensesKpiBand({
  overview,
  loading,
  className,
}: {
  overview: ExpenseOverview | null
  loading: boolean
  className?: string
}) {
  const { t } = useTranslation()

  if (loading && !overview) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={t('expenses.kpi.loading')}
        className={className}
      >
        <Card className="mb-3 flex flex-col gap-3 p-4">
          <Skeleton variant="text" className="h-3 w-32" accessibilityLabel="" />
          <Skeleton variant="text" className="h-8 w-56" accessibilityLabel="" />
        </Card>
        <div className={STRIP_GRID}>
          {Array.from({ length: 4 }, (_, index) => (
            <Card key={index} className="flex flex-col gap-2 p-3">
              <Skeleton variant="text" className="h-3 w-20" accessibilityLabel="" />
              <Skeleton variant="text" className="h-5 w-24" accessibilityLabel="" />
            </Card>
          ))}
        </div>
        <span className="sr-only">{t('expenses.kpi.loading')}</span>
      </div>
    )
  }

  if (!overview) return null

  return (
    <div className={cn(className)} aria-busy={loading || undefined}>
      {/* The headline spend, with the two figures a manager reads next to it. */}
      <Card className="flex flex-wrap items-end justify-between gap-4 p-4">
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-caption">
            <TrendingUp size={15} aria-hidden className="text-primary" />
            {t('expenses.kpi.total')}
          </p>
          <MoneyDisplay
            amount={overview.total_amount}
            variant="auto"
            className="text-3xl leading-tight font-extrabold text-foreground-strong"
          />
          <p className="text-caption text-foreground-subtle">{t('expenses.kpi.totalHint')}</p>
        </div>

        <dl className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex flex-col">
            <dt className="text-caption">{t('expenses.kpi.count')}</dt>
            <dd className="text-base font-bold text-foreground-strong tabular-nums">
              {overview.expenses_count}
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-caption">{t('expenses.kpi.average')}</dt>
            <dd>
              <MoneyDisplay
                amount={overview.average_amount}
                variant="auto"
                className="text-base font-bold text-foreground-strong"
              />
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-caption">{t('expenses.kpi.largest')}</dt>
            <dd>
              <MoneyDisplay
                amount={overview.largest_amount}
                variant="auto"
                className="text-base font-bold text-foreground-strong"
              />
            </dd>
          </div>
        </dl>
      </Card>

      {/* The supporting readings. Every one of them is a real aggregate. */}
      <div className={cn(STRIP_GRID, 'mt-3')}>
        <StatTile
          icon={Wallet}
          label={t('expenses.kpi.cash')}
          hint={t('expenses.kpi.cashCount', { count: overview.cash_count })}
        >
          <MoneyDisplay amount={overview.cash_amount} variant="auto" />
        </StatTile>
        <StatTile
          icon={Repeat}
          label={t('expenses.kpi.recurring')}
          hint={t('expenses.kpi.recurringCount', { count: overview.recurring_count })}
        >
          <MoneyDisplay amount={overview.recurring_amount} variant="auto" />
        </StatTile>
        <StatTile icon={Receipt} label={t('expenses.kpi.dailyAverage')}>
          <MoneyDisplay amount={dailyAverage(overview)} variant="auto" />
        </StatTile>
        <StatTile icon={Coins} label={t('expenses.kpi.categories')}>
          <span className="tabular-nums">{overview.categories.length}</span>
        </StatTile>
      </div>

      {/* The two slices overlap, so they must never read as a decomposition. */}
      <p className="mt-2 text-caption text-foreground-subtle">{t('expenses.kpi.slicesNote')}</p>
    </div>
  )
}

/**
 * Average spend per day that actually had an expense.
 *
 * The denominator is the number of days the backend returned — days with at
 * least one record. A day nobody spent anything is not an average of zero, it is
 * simply not in the set. A period with no days at all yields 0 rather than a
 * division by zero.
 */
function dailyAverage(overview: ExpenseOverview): number {
  if (overview.days.length === 0) return 0
  return Math.round(overview.total_amount / overview.days.length)
}

/** The category ranking, drawn with the SAME card the sales breakdown uses. */
export function ExpensesCategoryCard({
  overview,
  className,
}: {
  overview: ExpenseOverview
  className?: string
}) {
  const { t } = useTranslation()
  // Station chart bar roles only — the tone is a reading aid, never the signal.
  // Each row prints its own label and percentage, so a repeated tone on a long
  // list costs nothing. The ramp is the centralized one, so a category keeps the
  // same colour here and in the monthly expenses chart.
  const TONES = CHART_BAR_TOKENS

  const slices: ProportionSlice[] = overview.categories.map((category, index) => ({
    key: category.category,
    label: category.category_name,
    amount: category.amount,
    share: category.share,
    color: TONES[index % TONES.length],
    hint: t('expenses.categories.count', { count: category.count }),
  }))

  if (slices.length === 0) return null

  return (
    <ProportionCard
      className={className}
      title={t('expenses.categories.title')}
      hint={t('expenses.categories.hint')}
      slices={slices}
      footnote={t('expenses.categories.footnote')}
    />
  )
}
