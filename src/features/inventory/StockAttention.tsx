/**
 * المخزون — the attention area.
 *
 * # What it is
 *
 * The same low rows the list below already shows, promoted to the top of the
 * page because "what needs my attention" is the question a manager opens this
 * page to answer, and the answer should not require scrolling to find.
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
import { SlidersHorizontal, TriangleAlert } from '@/components/ui/icon'
import type { StockRow } from '@/services/opsApi'

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
            <p className="text-caption text-warning-foreground">{t('inventory.attention.hint')}</p>
          </div>
        </div>
        <span className="shrink-0 text-caption tabular-nums text-warning-foreground">
          {t('inventory.attention.count', { count: rows.length })}
        </span>
      </div>

      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li
            key={row.product_id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning-border bg-surface-card px-3 py-2"
          >
            <div className="min-w-0">
              <p className="text-body font-bold">{row.product_name}</p>
              <p className="text-caption tabular-nums">
                {t('inventory.columns.quantity')}: {row.quantity} · {t('inventory.columns.min')}:{' '}
                {row.min_quantity}
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
        ))}
      </ul>
    </section>
  )
}
