/**
 * Category navigation for the catalog — the cashier's fastest route to an item.
 *
 * Two modes, one real `nav` of real `<button>`s (keyboard reachable in document
 * order, one per tab stop, with a strong visible focus ring that is never
 * removed):
 *
 *   COMPACT (default) — only the categories the cashier pinned, WRAPPED onto as
 *     many rows as they need. This replaces the old horizontal-scroll strip:
 *     nothing is cut off, and no category has to be scrolled into reach.
 *   EXPANDED          — every category, wrapped, for the rare case where the
 *     full list is needed. The toggle is explicit and reversible.
 *
 * A HIDDEN category is never disabled and never unreachable: it appears in the
 * expanded mode and can be pinned from the manager drawer. Hiding is a
 * presentation choice about the primary bar, never a restriction.
 *
 * Accessibility notes
 * -------------------
 * - The selected category is signalled by MORE than color: a filled surface, a
 *   solid border, bolder typography AND `aria-current="true"`.
 * - `hiddenCount` is always stated in words next to the controls, so the compact
 *   state is never communicated by an icon or a color alone.
 * - Categories come from the real database, in the order the API returns them,
 *   so the layout is predictable between sessions.
 * - `nav` + `aria-label` (not a tablist): these filter one grid rather than
 *   switch panels, so tab semantics would be misleading.
 */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui'
import { EyeOff, Layers, SlidersHorizontal } from '@/components/ui/icon'
import { categoryTone } from '@/lib/category-visual'
import { cn } from '@/lib/utils'

export interface CatalogCategoryOption {
  id: number
  name: string
  /** Items in this category, used for the chip count. */
  count: number
}

export function CatalogCategoryFilter({
  categories,
  selectedId,
  onSelect,
  allLabel,
  totalCount,
  hiddenCount = 0,
  expanded = false,
  onToggleExpanded,
  onOpenManager,
  className,
}: {
  categories: CatalogCategoryOption[]
  /** `null` means "all categories". */
  selectedId: number | null
  onSelect: (id: number | null) => void
  allLabel: string
  totalCount: number
  /** Categories NOT shown in compact mode; they are one "show all" tap away. */
  hiddenCount?: number
  /** Compact by default: only the cashier's pinned categories are listed. */
  expanded?: boolean
  onToggleExpanded?: () => void
  onOpenManager?: () => void
  className?: string
}) {
  const { t } = useTranslation()
  const activeRef = useRef<HTMLButtonElement>(null)

  // "Show all" is only offered when it is a decision the cashier can actually
  // make: something is hidden, or we are already expanded and can collapse.
  const canToggleAll = Boolean(onToggleExpanded) && (expanded || hiddenCount > 0)

  // Keep the selected chip in view after the filter changes from elsewhere.
  useEffect(() => {
    // Guarded: jsdom and some older webviews do not implement scrollIntoView.
    activeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [selectedId])

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      {/* Label and controls share one flex row, so the whole category area stays
          a compact block instead of pushing the product grid down. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="text-caption font-bold">{t('catalog.category')}</p>

        <div className="flex flex-wrap items-center gap-2">
          {canToggleAll ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onToggleExpanded}
              aria-expanded={expanded}
              aria-controls="catalog-category-list"
              data-testid="catalog-category-expand"
            >
              {expanded ? t('catalog.hideCategories') : t('catalog.showAllCategories')}
            </Button>
          ) : null}

          {onOpenManager ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onOpenManager}
              aria-haspopup="dialog"
              data-testid="catalog-category-manage"
            >
              <SlidersHorizontal size={16} aria-hidden />
              {t('catalog.manageCategories')}
            </Button>
          ) : null}
        </div>
      </div>

      <nav aria-label={t('catalog.categoryNavLabel')} className="min-w-0">
        {/* `flex-wrap` with NO `overflow-x-auto`: the compact bar can never grow a
            horizontal scrollbar, which is the whole point of the mode. */}
        <div
          id="catalog-category-list"
          data-testid="catalog-category-nav"
          data-expanded={expanded ? 'true' : 'false'}
          className="flex flex-wrap items-center gap-2"
        >
          <CategoryChip
            ref={activeRef}
            selected={selectedId === null}
            onClick={() => onSelect(null)}
            label={allLabel}
            count={totalCount}
            icon
          />

          {categories.map((category) => (
            <CategoryChip
              key={category.id}
              selected={selectedId === category.id}
              onClick={() => onSelect(category.id)}
              label={category.name}
              count={category.count}
              tone={categoryTone(category.id)}
            />
          ))}
        </div>
      </nav>
    </div>
  )
}

function CategoryChip({
  selected,
  onClick,
  label,
  count,
  tone,
  icon = false,
  ref,
}: {
  selected: boolean
  onClick: () => void
  label: string
  count: number
  tone?: ReturnType<typeof categoryTone>
  icon?: boolean
  ref?: React.Ref<HTMLButtonElement>
}) {
  const { t } = useTranslation()
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-current={selected ? 'true' : undefined}
      data-category-tone={tone?.slot}
      title={label}
      className={cn(
        'inline-flex min-h-10 shrink-0 cursor-pointer items-center gap-2',
        'rounded-md border px-3 text-sm whitespace-nowrap',
        'transition-[background-color,border-color,color] duration-150 motion-reduce:transition-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        selected
          ? 'border-border-strong bg-surface-selected font-bold text-foreground-strong shadow-sm'
          : cn(
              'border-border bg-surface font-medium text-foreground-muted',
              'hover:border-border-accent-hover hover:bg-surface-hover hover:text-foreground',
              'active:bg-surface-active',
            ),
      )}
    >
      {icon ? <Layers size={15} aria-hidden /> : null}
      {!icon && tone ? (
        <span
          aria-hidden="true"
          className={cn('size-2 shrink-0 rounded-full', selected ? tone.foreground : tone.border)}
        />
      ) : null}

      <span className="truncate">{label}</span>

      {/* The count is part of the chip's accessible name, so a screen reader
          hears "مشروبات 4" rather than a bare number with no context. */}
      <span
        className={cn(
          'rounded px-1 text-xs font-bold tabular-nums',
          selected ? 'bg-surface-card text-foreground-muted' : 'text-foreground-subtle',
        )}
      >
        {count}
      </span>
      <span className="sr-only">{t('catalog.categoryItems')}</span>
    </button>
  )
}

/**
 * The compact-mode state in words: how many categories are out of the primary
 * bar, and how to reach them. Rendered by the page under the bar so the
 * "everything is still there" promise is explicit rather than implied.
 */
export function CatalogHiddenCategoriesNote({ count }: { count: number }) {
  const { t } = useTranslation()

  if (count <= 0) {
    return null
  }

  return (
    <p className="text-caption inline-flex items-center gap-1.5" data-testid="catalog-hidden-note">
      <EyeOff size={14} aria-hidden />
      {t('catalog.hiddenCategoriesHint', { count })}
    </p>
  )
}
