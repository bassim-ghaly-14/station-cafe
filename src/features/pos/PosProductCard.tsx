/** The POS product tile — the cashier's primary, repeated target.
 *
 * It reuses the CATALOG's visual language rather than inventing a second one:
 * the category tone comes from `lib/category-visual` (the same deterministic
 * per-category palette the Catalog card uses) and the NEW treatment comes from
 * `lib/new-item-visual` plus the Catalog's own ribbon and category badge
 * components. A category therefore looks identical in the Catalog and at the
 * till, in both themes, because both read the same tokens.
 *
 * WHY A DEDICATED TILE
 * --------------------
 * The pad is used hundreds of times a shift, so the tile is sized for the hand
 * and for the eye rather than for density: a real minimum height, a name that
 * WRAPS over up to three lines instead of truncating, and the price as the
 * strongest element after the name.
 *
 * Long Arabic names
 * ----------------
 * Truncation was the defect: a name that cannot be read cannot be ordered. The
 * name is a three-line clamp over a RESERVED three-line block, so a one-line
 * name and a three-line name occupy the same geometry and the grid never
 * reflows when a long name appears. `title` remains as a secondary fallback for
 * the rare name past three lines, and `break-words` keeps a long unbroken token
 * from forcing a horizontal overflow in RTL.
 *
 * It is a POS tile, not a Catalog card: no edit/delete/availability actions and
 * no stock line, because those belong to catalog management, not to selling.
 */
import { useTranslation } from 'react-i18next'

import { MoneyDisplay } from '@/components/ui'
import { CatalogCategoryBadge, CatalogNewRibbon } from '@/features/catalog/CatalogBadges'
import { categoryTone } from '@/lib/category-visual'
import {
  NEW_CARD_EDGE,
  NEW_CARD_FRAME,
  NEW_CARD_TEST_ID,
  NEW_CARD_TITLE,
} from '@/lib/new-item-visual'
import { cn } from '@/lib/utils'
import type { Product } from '@/services/posApi'

export function PosProductCard({
  product,
  onAdd,
  recipeShort = false,
}: Readonly<{
  readonly product: Product
  readonly onAdd: (product: Product) => void
  /**
   * Advisory recipe signal: true when this product HAS a recipe whose current
   * balances do not cover ONE unit. Never blocks the tap and never touches
   * product-stock display — checkout revalidates authoritatively.
   */
  readonly recipeShort?: boolean
}>) {
  const { t } = useTranslation()
  const tone = categoryTone(product.category_id)
  const isNew = product.is_new

  return (
    <button
      type="button"
      onClick={() => onAdd(product)}
      data-testid={`pos-product-${product.id}`}
      data-category-tone={tone.slot}
      data-new={isNew ? 'true' : undefined}
      // The accessible name states the ACTION with the product's identity, so a
      // screen reader announces "add product X" rather than a bare noun, and the
      // visible name is never the only thing carrying the meaning.
      aria-label={t('pos.addProduct', { name: product.name })}
      title={product.name}
      className={cn(
        'group relative flex min-h-40 flex-col items-start gap-2 overflow-hidden rounded-lg border p-3 text-start',
        'transition-[border-color,box-shadow] duration-150 motion-reduce:transition-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        // The category identity: the same deterministic tone the Catalog card
        // gives this category, applied here as a tinted surface + border so a
        // whole category reads as one colour block at a glance.
        tone.background,
        tone.border,
        'hover:border-border-accent-hover hover:shadow-md',
        // NEW wins the frame, exactly as on the Catalog card. The category tone
        // still reads through the badge below, so the two treatments compose
        // rather than overwrite each other.
        isNew && NEW_CARD_FRAME,
        isNew && 'hover:border-new-border',
      )}
    >
      {isNew ? (
        <span
          data-testid={NEW_CARD_TEST_ID}
          aria-hidden="true"
          className={cn('absolute inset-y-0 inset-s-0 w-1', NEW_CARD_EDGE)}
        />
      ) : null}

      {/* Name + ribbon share one flex line, so the ribbon can never overlap the
          name however long the name is. */}
      <div className="flex w-full items-start justify-between gap-2">
        <span
          className={cn(
            'line-clamp-3 min-h-17 text-base leading-snug font-bold text-foreground-strong',
            isNew && NEW_CARD_TITLE,
          )}
        >
          {product.name}
        </span>

        {isNew ? <CatalogNewRibbon /> : null}
      </div>

      {/* The category identity, reusing the Catalog's badge so the same category
          is spelled and coloured the same way on both screens. */}
      <div className="flex w-full flex-wrap items-center gap-1.5">
        <CatalogCategoryBadge categoryId={product.category_id} name={product.category_name} />
        {recipeShort ? (
          <span
            data-testid={`pos-recipe-short-${product.id}`}
            title={t('pos.recipeShortHint')}
            className="rounded-full border border-warning-border bg-warning-soft px-2 py-0.5 text-caption font-semibold text-warning"
          >
            {t('pos.recipeShort')}
          </span>
        ) : null}
      </div>

      {/* Price is the hero: the largest thing on the tile after the name. */}
      <span className="mt-auto block w-full text-lg font-black text-foreground-strong">
        <MoneyDisplay amount={product.price_minor} />
      </span>
    </button>
  )
}
