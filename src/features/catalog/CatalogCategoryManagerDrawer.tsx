/**
 * Category management — the cashier's control over which categories stay in the
 * primary category bar, plus the MANAGER/ADMIN actions on a category itself.
 *
 * Presented in the shared `Drawer` (anchored to the inline end, so it opens on
 * the reading side in Arabic without a direction-specific class) rather than a
 * bespoke popover: there is no Popover primitive in the design system, and a
 * panel is the right weight for a list the cashier scans and reorders.
 *
 * Behavior
 * --------
 * - Every category is listed, pinned ones first in their saved order. Nothing is
 *   ever removed from the catalog by this drawer — the switch only moves chips in
 *   and out of the bar.
 * - A real `Switch` carries the visible/hidden state, with the state named in
 *   words (ظاهرة / مخفية) so it never depends on the switch position or color.
 *   It uses the `state` tone, so the track reads as a plain condition — green
 *   when the category is on the bar, soft neutral when it is not.
 * - Reordering is two explicit arrow buttons per pinned row, keyboard reachable
 *   and labelled, disabled at the ends of the list.
 * - Choices are applied immediately through the shared visibility store, so the
 *   bar behind the drawer updates live and the choice survives a reload. A
 *   "restore default" action returns to the untouched catalog order.
 * - RENAME and DELETE are icon actions on the row itself, because the row is the
 *   only place the category being acted on is named. Rename is a MANAGER action
 *   and delete a narrower ADMIN one, mirroring the product card exactly; a role
 *   that may not perform an action never sees its button, while the real
 *   boundary stays the backend command AND the service behind it. Each action
 *   appears only when its handler is supplied, so the drawer stays read-only for
 *   the roles that have no category management at all.
 */
import { useTranslation } from 'react-i18next'

import { Button, Drawer } from '@/components/ui'
import { Switch } from '@/components/ui/input'
import { ChevronDown, ChevronUp, Pencil, Pin, RotateCcw, Trash2 } from '@/components/ui/icon'
import {
  moveCategoryInList,
  resetCategoryVisibility,
  resolveVisibleCategories,
  setVisibleCategoryIds,
  toggleCategoryInList,
  useCategoryVisibility,
} from '@/lib/category-visibility'
import { categoryTone } from '@/lib/category-visual'
import { cn } from '@/lib/utils'

import type { CatalogCategoryOption } from './CatalogCategoryFilter'

export function CatalogCategoryManagerDrawer({
  open,
  onClose,
  categories,
  onEditCategory,
  onDeleteCategory,
}: {
  open: boolean
  onClose: () => void
  /** Every category, in the catalog's own order. */
  categories: CatalogCategoryOption[]
  /**
   * MANAGER+ rename. Omitted for roles without category management, which is
   * what keeps the row free of an action they could not perform.
   */
  onEditCategory?: (category: CatalogCategoryOption) => void
  /**
   * ADMIN-only delete, offered as a separate affordance from the reversible
   * rename and never sharing the visibility switch. Omitted for every other
   * role; the backend refuses them regardless.
   */
  onDeleteCategory?: (category: CatalogCategoryOption) => void
}) {
  const { t } = useTranslation()
  const preference = useCategoryVisibility()

  /**
   * The drawer must mirror what the bar ACTUALLY shows, so it reads the same
   * resolved list the bar does — including the untouched default, where the
   * first categories are on screen without having been pinned yet. Deriving it
   * from the raw preference instead would label six visible categories as
   * "hidden", which is exactly the confusion this screen exists to remove.
   */
  const resolved = resolveVisibleCategories(categories, preference)
  const visibleIds = resolved.map((category) => category.id)
  const isVisible = (id: number) => visibleIds.includes(id)

  /** Every edit is applied to the RESOLVED order and written through once, so a
      first-time change also captures the categories already on screen. */
  const toggle = (id: number) => setVisibleCategoryIds(toggleCategoryInList(visibleIds, id))
  const move = (id: number, offset: -1 | 1) =>
    setVisibleCategoryIds(moveCategoryInList(visibleIds, id, offset))

  /** Pinned first in the SAVED order, then everything still hidden in the
      catalog's own order — so the list reads as "in the bar" then "not yet". */
  const ordered = [...resolved, ...categories.filter((category) => !isVisible(category.id))]

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t('catalog.manageCategories')}
      subtitle={t('catalog.manageCategoriesHint')}
      width="sm"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={resetCategoryVisibility}
            data-testid="catalog-category-reset"
          >
            <RotateCcw size={16} aria-hidden />
            {t('catalog.resetCategories')}
          </Button>

          <Button onClick={onClose} data-testid="catalog-category-done">
            {t('app.done')}
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-2">
        {ordered.map((category) => {
          const visible = isVisible(category.id)
          const visibleIndex = visibleIds.indexOf(category.id)
          const tone = categoryTone(category.id)

          return (
            <li
              key={category.id}
              data-testid="catalog-category-row"
              data-visible={visible ? 'true' : 'false'}
              className={cn(
                'flex items-center gap-3 rounded-md border px-3 py-2',
                visible ? 'border-border-strong bg-surface-selected' : 'border-border bg-surface',
              )}
            >
              <span
                aria-hidden="true"
                className={cn('size-2.5 shrink-0 rounded-full', tone.foreground)}
              />

              <div className="min-w-0 flex-1">
                <p className="truncate font-bold" title={category.name}>
                  {category.name}
                </p>

                {/* The state in words: never color or switch position alone. */}
                <p className="text-caption">
                  {visible ? t('catalog.categoryPinned') : t('catalog.categoryHidden')}
                </p>
              </div>

              {visible ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => move(category.id, -1)}
                    disabled={visibleIndex <= 0}
                    aria-label={t('catalog.moveCategoryUp', { name: category.name })}
                  >
                    <ChevronUp size={16} aria-hidden />
                  </Button>

                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => move(category.id, 1)}
                    disabled={visibleIndex >= visibleIds.length - 1}
                    aria-label={t('catalog.moveCategoryDown', { name: category.name })}
                  >
                    <ChevronDown size={16} aria-hidden />
                  </Button>
                </div>
              ) : null}

              {/* The category's own actions. Icon-only, so the row stays one
                  compact line; each carries an Arabic accessible name, and the
                  destructive one is a separate affordance from the reversible
                  rename, exactly as on the product card. */}
              {onEditCategory || onDeleteCategory ? (
                <div className="flex shrink-0 items-center gap-1">
                  {onEditCategory ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onEditCategory(category)}
                      aria-label={t('catalog.editCategoryAction', { name: category.name })}
                      data-testid="catalog-category-edit"
                    >
                      <Pencil size={16} aria-hidden />
                    </Button>
                  ) : null}

                  {onDeleteCategory ? (
                    <Button
                      variant="destructiveGhost"
                      size="icon-sm"
                      onClick={() => onDeleteCategory(category)}
                      aria-label={t('catalog.deleteCategoryAction', { name: category.name })}
                      data-testid="catalog-category-delete"
                    >
                      <Trash2 size={16} aria-hidden />
                    </Button>
                  ) : null}
                </div>
              ) : null}

              <span className="shrink-0">
                {/* The `state` tone, not the default "new item" accent: this
                    switch reports whether a category is VISIBLE, so it reads as
                    a plain condition (green when on, soft neutral when off)
                    instead of borrowing an unrelated magenta identity. */}
                <Switch
                  checked={visible}
                  onCheckedChange={() => toggle(category.id)}
                  label={t('catalog.toggleCategoryVisible', { name: category.name })}
                  tone="state"
                />
              </span>
            </li>
          )
        })}
      </ul>

      {preference.visible === null ? (
        <p className="text-caption mt-4 flex items-start gap-2">
          <Pin size={14} aria-hidden className="mt-1 shrink-0" />
          {t('catalog.manageCategoriesDefault')}
        </p>
      ) : null}
    </Drawer>
  )
}
