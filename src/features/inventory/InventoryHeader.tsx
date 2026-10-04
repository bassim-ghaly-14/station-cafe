/**
 * المخزون — the page header and the operational summary.
 *
 * # The header
 *
 * It is the SAME header every manager page uses (Sales, Reports, Expenses,
 * Employees, Customers): an `h1` with the destination's own icon, a one-line
 * operational subtitle, and nothing else. There is no primary action here,
 * because the page has exactly one operation — adjusting a quantity — and that
 * operation belongs to a ROW, not to the page. Inventing a page-level "add
 * stock" action would either be a Catalog duplicate or a new command, and
 * neither is this page's business.
 *
 * # The summary band
 *
 * Three counts, and only three, because three is what the loaded data can
 * honestly answer:
 *
 *   - how many items do I track at all;
 *   - how many have reached their minimum;
 *   - how many are fine.
 *
 * Every one is a COUNT over the complete `list_stock` set — no money, no value,
 * no margin. Station stores no cost of goods, so an "inventory value" tile
 * would be a fabrication, and a "moves today" tile would need a backend
 * aggregate that does not exist. The band is deliberately the smallest one that
 * still answers "is anything wrong?".
 *
 * It uses the SHARED `KpiGrid`/`KpiTile`, so the phone step (one tile per row,
 * no truncated Arabic label) and the desktop row are the application-wide rule
 * rather than a class string this page could forget — the same contract the
 * Sales, Expenses and Employees bands already state.
 */
import { useTranslation } from 'react-i18next'
import { Card, KpiGrid, KpiTile, Skeleton } from '@/components/ui'
import { Boxes, Check, Package, TriangleAlert, type LucideIcon } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import type { StockSummary } from './inventoryModel'

/** The page identity: title, icon and the one line that says what this page is for. */
export function InventoryHeader() {
  const { t } = useTranslation()
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-heading flex items-center gap-2">
          <Boxes size={22} aria-hidden />
          {t('nav.inventory')}
        </h1>
        <p className="mt-0.5 text-caption text-foreground-subtle">{t('inventory.subtitle')}</p>
      </div>
    </header>
  )
}

/** One tile, in the shape the other bands already use. */
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
 * The operational summary.
 *
 * `summary` is `null` until the stock read resolves, and `null` ALSO covers a
 * failed load — so a failed read can never be presented as a band of zeroes.
 * The band simply is not there, and the stock section below it shows the error
 * with a retry. That precedence is the reason this component takes the value
 * rather than computing it.
 *
 * `loading` marks a refresh over rows already on screen: the figures stay, the
 * region is announced busy, and nothing flashes.
 */
export function InventorySummary({
  summary,
  loading,
  className,
}: {
  readonly summary: StockSummary | null
  readonly loading: boolean
  readonly className?: string
}) {
  const { t } = useTranslation()

  if (summary === null) {
    return (
      <output
        aria-busy="true"
        aria-label={t('inventory.kpi.loading')}
        className={cn('block', className)}
      >
        <KpiGrid>
          {Array.from({ length: 3 }, (_, index) => (
            <Card key={index} className="flex flex-col gap-2 border-border-subtle p-3">
              <Skeleton variant="text" className="h-3 w-24" accessibilityLabel="" />
              <Skeleton variant="text" className="h-6 w-12" accessibilityLabel="" />
            </Card>
          ))}
        </KpiGrid>
        <span className="sr-only">{t('inventory.kpi.loading')}</span>
      </output>
    )
  }

  return (
    <KpiGrid className={className} aria-busy={loading || undefined}>
      <StatTile icon={Package} label={t('inventory.kpi.tracked')}>
        <span className="tabular-nums">{summary.total}</span>
      </StatTile>

      <StatTile
        icon={TriangleAlert}
        label={t('inventory.kpi.low')}
        hint={t('inventory.kpi.lowHint')}
      >
        <span className="tabular-nums">{summary.low}</span>
      </StatTile>

      <StatTile icon={Check} label={t('inventory.kpi.ok')} hint={t('inventory.kpi.okHint')}>
        <span className="tabular-nums">{summary.ok}</span>
      </StatTile>
    </KpiGrid>
  )
}
