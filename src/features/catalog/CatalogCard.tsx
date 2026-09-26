/**
 * The catalog card.
 *
 * Information hierarchy, in the order a cashier actually reads it:
 *
 *   1. NAME  — the item's identity. Truncates rather than wraps, and the full
 *      name stays reachable via `title` when it is long.
 *   2. PRICE — a HERO element. The number itself is the largest thing on the
 *      card, so a price can be found in a grid without reading anything else.
 *      It uses `text-foreground-strong` + `text-money` (theme tokens), never a
 *      hardcoded color, so it stays high-contrast in BOTH themes.
 *   3. Operational badges — availability (success/danger) and "new".
 *   4. Secondary metadata — type and stock, deliberately muted and smaller.
 *
 * Deliberately restrained: a subtle border/surface change on hover, no lift, no
 * zoom, no gradient, no decorative motion. This is a POS surface and it should
 * feel fast.
 */
import { useTranslation } from 'react-i18next'

import { Button, MoneyDisplay } from '@/components/ui'
import { Coffee, Droplets, Pencil, Power } from '@/components/ui/icon'
import type { Product } from '@/services/posApi'

import { CatalogCategoryBadge, CatalogNewBadge, CatalogStatusBadge } from './CatalogBadges'

export function CatalogCard({
  product,
  canManage,
  onEdit,
  onToggle,
}: {
  product: Product
  canManage: boolean
  onEdit: () => void
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const isCafe = product.department === 'CAFE'
  const DepartmentIcon = isCafe ? Coffee : Droplets

  return (
    <article
      data-testid="catalog-card"
      className={[
        'group relative flex min-h-64 flex-col overflow-hidden rounded-lg p-0',
        'border border-border bg-surface-card shadow-sm',
        'transition-[border-color,box-shadow] duration-150 motion-reduce:transition-none',
        'hover:border-border-accent-hover hover:shadow-md',
        // A disabled item stays fully readable — muted, never hidden or faded
        // out — because the cashier still needs its name and price to know
        // what is unavailable.
        !product.is_active ? 'border-destructive-border' : '',
      ].join(' ')}
    >
      {/* 1 + 3 — identity, then the operational state right beside it. */}
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span
            aria-hidden="true"
            className={[
              'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border',
              isCafe
                ? 'border-primary-border bg-primary-soft text-primary'
                : 'border-info-border bg-info-soft text-info',
            ].join(' ')}
          >
            <DepartmentIcon size={16} strokeWidth={1.8} />
          </span>

          <div className="min-w-0">
            <h3
              className="truncate text-base leading-snug font-bold text-foreground-strong"
              title={product.name}
            >
              {product.name}
            </h3>

            <p className="mt-0.5 text-xs font-medium text-foreground-subtle">
              {t(`catalog.${product.item_type}`)}
            </p>
          </div>
        </div>
      </div>

      {/* 2 — PRICE HERO. Positioned identically on every card so the eye can
          drop straight down the price column of the grid. */}
      <div className="px-4 pt-3" data-testid="catalog-card-price">
        <MoneyDisplay
          amount={product.price_minor}
          className="text-money block text-3xl leading-none font-black tracking-tight text-foreground-strong"
        />
      </div>

      {/* 3 — badges. Availability first (the operational question), then
          "new" (the editorial one), then the category grouping. */}
      <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
        <CatalogStatusBadge isActive={product.is_active} />
        {product.is_new ? <CatalogNewBadge /> : null}
        <CatalogCategoryBadge categoryId={product.category_id} name={product.category_name} />
      </div>

      {/* 4 — secondary metadata, muted and compact. */}
      <div className="px-4 pt-3">
        <p className="text-xs font-medium text-foreground-subtle">
          {product.track_inventory
            ? `${t('inventory.stock')}: ${product.stock_quantity}`
            : t('inventory.notTracked')}
        </p>
      </div>

      {canManage ? (
        <div className="mt-auto grid grid-cols-2 gap-2 border-t border-border-subtle p-3">
          <Button variant="outline" size="sm" className="min-w-0" onClick={onEdit}>
            <Pencil size={15} aria-hidden />
            {t('catalog.edit')}
          </Button>

          {/* Disabled → red action; Activate → GREEN. The action color always
              states the outcome, so the relationship is self-explanatory. */}
          <Button
            variant={product.is_active ? 'destructiveGhost' : 'success'}
            size="sm"
            className="min-w-0"
            onClick={onToggle}
          >
            <Power size={15} aria-hidden />
            {product.is_active ? t('catalog.deactivate') : t('catalog.activate')}
          </Button>
        </div>
      ) : null}
    </article>
  )
}
