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
 *   3. Operational badges — availability (success/danger) and category identity;
 *      "new" lives in the top corner ribbon, so it appears exactly once.
 *   4. Secondary metadata — type and stock, deliberately muted and smaller.
 *
 * NEW ITEMS
 * ---------
 * A NEW item is a catalog STATE, not a decoration, so it is expressed on the
 * card itself and not only on a badge: soft accent surface, solid accent edge on
 * the reading side, stronger border + elevation, accent title, and a corner
 * ribbon. The whole treatment is defined once in `lib/new-item-visual.ts`, so it
 * can never drift, and it deliberately leaves the price, the badges, the stock
 * line, the action row and the card's click target exactly as they are for a
 * normal item.
 *
 * Deliberately restrained: a subtle border/surface change on hover, no lift, no
 * zoom, no gradient, no decorative motion. This is a POS surface and it should
 * feel fast.
 */
import { useTranslation } from 'react-i18next'

import { Button, MoneyDisplay } from '@/components/ui'
import { ChefHat, Coffee, Droplets, Pencil, Power, Trash2 } from '@/components/ui/icon'
import {
  NEW_CARD_EDGE,
  NEW_CARD_FRAME,
  NEW_CARD_TEST_ID,
  NEW_CARD_TITLE,
} from '@/lib/new-item-visual'
import { cn } from '@/lib/utils'
import type { Product } from '@/services/posApi'

import { CatalogCategoryBadge, CatalogNewRibbon, CatalogStatusBadge } from './CatalogBadges'
import { CatalogRecipeBadge } from './CatalogRecipe'

export function CatalogCard({
  product,
  canManage,
  canDelete,
  onEdit,
  onToggle,
  onDelete,
  onRecipe,
}: {
  readonly product: Product
  readonly canManage: boolean
  /** ADMIN only: the backend rejects the delete for any other role. */
  readonly canDelete: boolean
  readonly onEdit: () => void
  readonly onToggle: () => void
  readonly onDelete: () => void
  /** Opens the recipe editor. Only passed for tracked products when managing. */
  readonly onRecipe?: () => void
}) {
  const { t } = useTranslation()
  const isCafe = product.department === 'CAFE'
  const DepartmentIcon = isCafe ? Coffee : Droplets
  const isNew = product.is_new

  return (
    <article
      data-testid="catalog-card"
      data-new={isNew ? 'true' : undefined}
      className={cn(
        'group relative flex min-h-64 flex-col overflow-hidden rounded-lg p-0',
        'border border-border bg-surface-card shadow-sm',
        'transition-[border-color,box-shadow] duration-150 motion-reduce:transition-none',
        'hover:border-border-accent-hover hover:shadow-md',
        // A NEW item is a catalog STATE, so it changes the card frame itself.
        // Disabled and new are independent, so the destructive border still wins
        // on availability while the new surface/edge/ribbon stay visible.
        isNew && NEW_CARD_FRAME,
        isNew && 'hover:border-new-border',
        // A disabled item stays fully readable — muted, never hidden or faded
        // out — because the cashier still needs its name and price to know
        // what is unavailable.
        !product.is_active ? 'border-destructive-border' : '',
      )}
    >
      {/* The NEW accent edge. `inset-s-0` is a logical property, so it lands on
          the reading (right) side in Arabic without a direction-specific class;
          the card's 4px horizontal padding keeps the content clear of it. */}
      {isNew ? (
        <span
          data-testid={NEW_CARD_TEST_ID}
          aria-hidden="true"
          className={cn('absolute inset-y-0 inset-s-0 w-1', NEW_CARD_EDGE)}
        />
      ) : null}

      {/* 1 + 3 — identity, then the operational state right beside it. The row
          is a flex line with the name block and the ribbon, so the ribbon can
          never overlap the product name however long the name is. */}
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span
            aria-hidden="true"
            className={cn(
              'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border',
              isCafe
                ? 'border-primary-border bg-primary-soft text-primary'
                : 'border-info-border bg-info-soft text-info',
            )}
          >
            <DepartmentIcon size={16} strokeWidth={1.8} />
          </span>

          <div className="min-w-0">
            <h3
              className={cn(
                'truncate text-base leading-snug font-bold text-foreground-strong',
                isNew && NEW_CARD_TITLE,
              )}
              title={product.name}
            >
              {product.name}
            </h3>

            <p className="mt-0.5 text-xs font-medium text-foreground-subtle">
              {t(`catalog.${product.item_type}`)}
            </p>
          </div>
        </div>

        {isNew ? <CatalogNewRibbon /> : null}
      </div>

      {/* 2 — PRICE HERO. Positioned identically on every card so the eye can
          drop straight down the price column of the grid. */}
      <div className="px-4 pt-3" data-testid="catalog-card-price">
        <MoneyDisplay
          amount={product.price_minor}
          className="text-money block text-3xl leading-none font-black tracking-tight text-foreground-strong"
        />
      </div>

      {/* 3 — badges. Availability first (the operational question), then the
          category grouping, then the recipe signal when present. "New" is
          deliberately NOT repeated here: it is stated once, by the ribbon
          in the card's top corner. */}
      <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
        <CatalogStatusBadge isActive={product.is_active} />
        <CatalogCategoryBadge categoryId={product.category_id} name={product.category_name} />
        <CatalogRecipeBadge product={product} />
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
        <CatalogCardActions
          isActive={product.is_active}
          canDelete={canDelete}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
          onRecipe={onRecipe}
        />
      ) : null}
    </article>
  )
}

/**
 * The action row of a catalog card, for a role that may manage the catalog.
 *
 * The action colour always states the OUTCOME — a disabled item offers a
 * destructive "deactivate", an enabled one a green "activate" — so the
 * relationship is self-explanatory without reading the label. Delete is a
 * separate, ADMIN-only, terminal affordance and never shares the reversible
 * availability switch.
 *
 * The recipe button belongs to tracked products only: a recipe is what ONE
 * unit of product consumes, so an untracked product has nothing to consume
 * from. When present it is a plain outline action like Edit — the recipe is
 * configuration, not an availability outcome.
 */
function CatalogCardActions({
  isActive,
  canDelete,
  onEdit,
  onToggle,
  onDelete,
  onRecipe,
}: Readonly<{
  isActive: boolean
  canDelete: boolean
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
  onRecipe?: () => void
}>) {
  const { t } = useTranslation()
  return (
    <div
      className={[
        'mt-auto grid gap-2 border-t border-border-subtle p-3',
        canDelete ? 'grid-cols-3' : 'grid-cols-2',
      ].join(' ')}
    >
      <Button variant="outline" size="sm" className="min-w-0" onClick={onEdit}>
        <Pencil size={15} aria-hidden />
        {t('catalog.edit')}
      </Button>

      {onRecipe ? (
        <Button variant="outline" size="sm" className="min-w-0" onClick={onRecipe}>
          <ChefHat size={15} aria-hidden />
          {t('rawmaterials.recipe.button')}
        </Button>
      ) : null}

      <Button
        variant={isActive ? 'destructiveGhost' : 'success'}
        size="sm"
        className="min-w-0"
        onClick={onToggle}
      >
        <Power size={15} aria-hidden />
        {isActive ? t('catalog.deactivate') : t('catalog.activate')}
      </Button>

      {canDelete ? (
        <Button
          variant="destructiveGhost"
          size="sm"
          className="min-w-0"
          onClick={onDelete}
          data-testid="catalog-card-delete"
        >
          <Trash2 size={15} aria-hidden />
          {t('catalog.delete')}
        </Button>
      ) : null}
    </div>
  )
}
