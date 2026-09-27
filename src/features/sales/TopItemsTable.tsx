/**
 * The top-selling items — the useful half of the old "مبيعات الأصناف" report,
 * rebuilt for management instead of copied.
 *
 * What changed and why:
 *  - it states the SHARE of the period's item revenue, so "big" is relative to
 *    this period rather than absolute;
 *  - it separates the two things a manager means by "best seller" — the item
 *    that earned the most and the item that sold most often — and lets the
 *    backend order by either;
 *  - the department stays visible as a badge, because a hybrid business sells
 *    cafe items and wash services side by side;
 *  - a proportional bar replaces a bare percentage, so the ranking is readable
 *    without reading every number.
 *
 * The rows come from the immutable invoice line snapshots, so renaming or
 * repricing an item in the catalog can never rewrite this history.
 */
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/states'
import { Button, Card, MoneyDisplay } from '@/components/ui'
import { DataTable, DataTableCell, DataTableRow, type DataTableColumn } from '@/components/ui'
import { ArrowUpDown, Coffee, Droplets } from '@/components/ui/icon'
import { chartBarColor } from '@/lib/chart-colors'
import { cn } from '@/lib/utils'
import type { SalesItemRow, SalesItemSort } from '@/services/salesApi'

function SortToggle({
  active,
  label,
  onClick,
}: {
  readonly active: boolean
  readonly label: string
  readonly onClick: () => void
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? 'default' : 'outline'}
      aria-pressed={active}
      onClick={onClick}
    >
      <ArrowUpDown size={14} aria-hidden />
      {label}
    </Button>
  )
}

export function TopItemsTable({
  items,
  sort,
  onSortChange,
  className,
}: {
  readonly items: SalesItemRow[]
  readonly sort: SalesItemSort
  readonly onSortChange: (sort: SalesItemSort) => void
  readonly className?: string
}) {
  const { t } = useTranslation()
  const topShare = items[0]?.share_percent ?? 0

  const columns: DataTableColumn[] = [
    { key: 'item', label: t('sales.items.columns.item'), headerClassName: 'min-w-48' },
    { key: 'department', label: t('sales.items.columns.department'), headerClassName: 'w-28' },
    { key: 'quantity', label: t('sales.items.columns.quantity'), headerClassName: 'w-24' },
    { key: 'revenue', label: t('sales.items.columns.revenue'), headerClassName: 'w-32' },
    { key: 'share', label: t('sales.items.columns.share'), headerClassName: 'w-40' },
  ]

  return (
    <Card className={cn('overflow-hidden p-0', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2 p-4 pb-3">
        <div>
          <h2 className="text-section text-foreground-strong">{t('sales.items.title')}</h2>
          <p className="mt-0.5 text-caption text-foreground-subtle">{t('sales.items.hint')}</p>
        </div>
        {/* Two orderings, both resolved by the backend — never a client sort. */}
        <div
          className="flex items-center gap-2"
          role="group"
          aria-label={t('sales.items.sortLabel')}
        >
          <SortToggle
            active={sort === 'revenue'}
            label={t('sales.items.sortRevenue')}
            onClick={() => onSortChange('revenue')}
          />
          <SortToggle
            active={sort === 'quantity'}
            label={t('sales.items.sortQuantity')}
            onClick={() => onSortChange('quantity')}
          />
        </div>
      </div>

      {items.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState title={t('sales.items.empty')} />
        </div>
      ) : (
        <DataTable caption={t('sales.items.caption')} columns={columns}>
          {items.map((item) => (
            <DataTableRow key={`${item.department}-${item.product_name}`}>
              <DataTableCell>
                <span className="block max-w-56 truncate font-bold text-foreground-strong">
                  {item.product_name}
                </span>
              </DataTableCell>
              <DataTableCell>
                <span className="inline-flex items-center gap-1.5 text-caption text-foreground-muted">
                  {item.department === 'WASH' ? (
                    <Droplets size={13} aria-hidden className="text-primary" />
                  ) : (
                    <Coffee size={13} aria-hidden className="text-primary" />
                  )}
                  {t(`catalog.${item.department}`)}
                </span>
              </DataTableCell>
              <DataTableCell>
                <span className="tabular-nums">{item.quantity}</span>
              </DataTableCell>
              <DataTableCell>
                <MoneyDisplay amount={item.revenue} variant="auto" className="text-money" />
              </DataTableCell>
              <DataTableCell>
                {/* The bar is scaled to the leading item, so the column shows
                    the shape of the ranking at a glance. */}
                <span className="flex items-center gap-2">
                  <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-muted">
                    <span
                      className="block h-full rounded-full"
                      style={{
                        // The same CENTRALIZED chart bar role every other bar uses
                        // (`lib/chart-colors.ts`), so a Dev Settings change repaints
                        // this ranking bar with the rest of the application.
                        background: chartBarColor('primary'),
                        width: `${topShare > 0 ? Math.max(4, (item.share_percent / topShare) * 100) : 0}%`,
                      }}
                    />
                  </span>
                  <span className="tabular-nums text-foreground-muted">{item.share_percent}%</span>
                </span>
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTable>
      )}
    </Card>
  )
}
