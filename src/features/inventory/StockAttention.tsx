/**
 * المخزون — the attention area.
 *
 * # What it is
 *
 * The same low rows the list below already shows, promoted to the top of the
 * page because "what needs my attention" is the question a manager opens this
 * page to answer, and the answer should not require scrolling to find.
 * It keeps the three-state split: strictly-below rows first (danger), then
 * exactly-at rows (warning) — never collapsed into one bucket.
 *
 * # What it is NOT
 *
 * It is NOT a second dataset. It is derived from the very same `stock` rows the
 * list is rendered from, by `attentionRows()` in the presentation model — so
 * there is no additional command, no additional query, and no way for the two
 * sections to disagree about which items are low. The rows keep the backend's
 * own low-first ordering.
 *
 * It renders NOTHING when no item is low. An empty warning panel would be noise
 * on the majority of days, and a green "everything is fine" banner would be a
 * second, vaguer answer to a question the page's own figures already give. The
 * absence of the panel IS the all-clear.
 *
 * The surface uses the EXISTING warning tokens (`border-warning-border`,
 * `bg-warning-soft`, `text-warning-foreground`) exactly as the printing status
 * panel and the day-closing panel already use them, so this introduces no new
 * colour treatment.
 */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import { CircleAlert, SlidersHorizontal, TriangleAlert } from '@/components/ui/icon'
import type { StockRow } from '@/services/opsApi'
import { stockStateOf } from './inventoryModel'

function rowTone(row: StockRow): 'danger' | 'warning' {
  return stockStateOf(row) === 'BELOW_MINIMUM' ? 'danger' : 'warning'
}

function rowLabelKey(row: StockRow): string {
  return stockStateOf(row) === 'BELOW_MINIMUM' ? 'inventory.state.below' : 'inventory.state.atMin'
}

export function StockAttention({
  rows,
  onAdjust,
}: Readonly<{
  /** The low rows, in the backend's own order. */
  readonly rows: readonly StockRow[]
  readonly onAdjust: (row: StockRow) => void
}>) {
  const { t } = useTranslation()

  if (rows.length === 0) return null

  const below = rows.filter((row) => stockStateOf(row) === 'BELOW_MINIMUM')
  const atMin = rows.filter((row) => stockStateOf(row) === 'AT_MINIMUM')
  const ordered = [...below, ...atMin]

  return (
    <section
      aria-label={t('inventory.attention.title')}
      className="rounded-lg border border-warning-border bg-warning-soft p-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <TriangleAlert size={18} aria-hidden className="shrink-0 text-warning" />
          <div className="min-w-0">
            <h2 className="text-section text-warning-foreground">
              {t('inventory.attention.title')}
            </h2>
            <p className="text-caption text-warning-foreground">
              {below.length > 0 && atMin.length > 0
                ? t('inventory.attention.hintBoth', { below: below.length, atMin: atMin.length })
                : below.length > 0
                  ? t('inventory.attention.hintBelow', { count: below.length })
                  : t('inventory.attention.hintAtMin', { count: atMin.length })}
            </p>
          </div>
        </div>
        <span className="shrink-0 text-caption tabular-nums text-warning-foreground">
          {t('inventory.attention.count', { count: rows.length })}
        </span>
      </div>

      <ul className="flex flex-col gap-2">
        {ordered.map((row) => {
          const Icon = rowTone(row) === 'danger' ? TriangleAlert : CircleAlert
          return (
            <li
              key={row.product_id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning-border bg-surface-card px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-body flex items-center gap-1.5 font-bold">
                  <Icon
                    size={15}
                    aria-hidden
                    className={rowTone(row) === 'danger' ? 'text-destructive' : 'text-warning'}
                  />
                  {row.product_name}
                </p>
                <p className="text-caption tabular-nums">
                  {t(rowLabelKey(row))}: {row.quantity} / {row.min_quantity}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                aria-label={t('inventory.filters.adjustItem', { name: row.product_name })}
                onClick={() => onAdjust(row)}
              >
                <SlidersHorizontal size={16} aria-hidden />
                {t('inventory.adjust')}
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
