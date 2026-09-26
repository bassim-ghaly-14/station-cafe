/**
 * Category navigation for the catalog.
 *
 * The cashier's fastest route to an item, so it is a real `nav` of real
 * `<button>`s — keyboard reachable in document order, one per tab stop, with a
 * strong visible focus ring that is never removed.
 *
 * Accessibility notes
 * -------------------
 * - The selected category is signalled by MORE than color: a filled surface, a
 *   solid border, bolder typography AND `aria-current="true"`. A color-blind
 *   user, or anyone on a low-contrast screen, still sees the selection.
 * - Categories come from the real database, in the order the API returns them,
 *   so the layout is predictable between sessions.
 * - On narrow viewports the row scrolls horizontally instead of wrapping, which
 *   keeps the strip scannable as ONE line. The active chip is scrolled into
 *   view so the current selection is never off-screen after a search reset.
 * - `nav` + `aria-label` (not a tablist): these filter one grid rather than
 *   switch panels, so tab semantics would be misleading.
 */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { Layers } from '@/components/ui/icon'
import { categoryTone } from '@/lib/category-visual'
import { cn } from '@/lib/utils'

export interface CatalogCategoryOption {
  id: number
  name: string
  /** Items in this category, used for the count and the empty-state messaging. */
  count: number
}

export function CatalogCategoryFilter({
  categories,
  selectedId,
  onSelect,
  allLabel,
  totalCount,
  className,
}: {
  categories: CatalogCategoryOption[]
  /** `null` means "all categories". */
  selectedId: number | null
  onSelect: (id: number | null) => void
  allLabel: string
  totalCount: number
  className?: string
}) {
  const { t } = useTranslation()
  const activeRef = useRef<HTMLButtonElement>(null)

  // Keep the selected chip visible when the strip overflows (narrow viewports)
  // or after the filter changes from elsewhere.
  useEffect(() => {
    // Guarded: jsdom and some older webviews do not implement scrollIntoView.
    activeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [selectedId])

  return (
    <nav aria-label={t('catalog.categoryNavLabel')} className={cn('min-w-0', className)}>
      {/* `overflow-x-auto` + `whitespace-nowrap` keeps one scannable line;
          the scrollbar is thin so it never competes with the content. */}
      <div
        data-testid="catalog-category-nav"
        className="flex items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]"
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
