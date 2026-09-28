/**
 * The catalog filter panel: search, the two narrowing selects, the category
 * navigation and the "you are filtering" summary.
 *
 * Category navigation sits directly above the results it filters, so the
 * relationship between "this category" and "these cards" is obvious, and it is
 * one tap away from the search box. The panel is a pure function of the filter
 * state the page owns — it changes nothing itself.
 */
import type { ReactNode, SelectHTMLAttributes } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui'
import { Search } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'

import {
  CatalogCategoryFilter,
  CatalogHiddenCategoriesNote,
  type CatalogCategoryOption,
} from './CatalogCategoryFilter'
import type { CatalogFilters } from './useCatalogFilters'
import { TYPES } from './catalogVisual'

export function CatalogFilterPanel({
  filters,
  barCategories,
  effectiveCategoryId,
  resultCount,
  totalCount,
  hiddenCategoryCount,
  categoriesExpanded,
  onToggleExpanded,
  onOpenCategoryManager,
}: {
  readonly filters: CatalogFilters
  readonly barCategories: CatalogCategoryOption[]
  readonly effectiveCategoryId: number | null
  readonly resultCount: number
  /** Every item the page loaded, the denominator behind the "All" chip. */
  readonly totalCount: number
  readonly hiddenCategoryCount: number
  readonly categoriesExpanded: boolean
  readonly onToggleExpanded: () => void
  readonly onOpenCategoryManager: () => void
}) {
  const { t } = useTranslation()
  const { query, setQuery, type, setType, status, setStatus, hasFilters, clearFilters } = filters

  return (
    <section className="border border-border bg-surface">
      <div className="flex flex-col gap-3 p-3 xl:flex-row">
        {/* Search */}
        <div className="relative min-w-0 flex-1">
          <Search
            size={17}
            aria-hidden
            className="pointer-events-none absolute top-1/2 inset-s-3 -translate-y-1/2 text-foreground-subtle"
          />

          <Input
            aria-label={t('catalog.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('catalog.search')}
            className="h-11 ps-9"
          />
        </div>

        {/* Type + Status only */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:flex">
          <CatalogSelect
            aria-label={t('catalog.type')}
            value={type}
            onChange={(value) => setType(value as CatalogFilters['type'])}
          >
            <option value="">{t('catalog.type')}</option>

            {TYPES.map((itemType) => (
              <option key={itemType} value={itemType}>
                {t(`catalog.${itemType}`)}
              </option>
            ))}
          </CatalogSelect>

          <CatalogSelect
            aria-label={t('app.status')}
            value={status}
            onChange={(value) => setStatus(value as CatalogFilters['status'])}
          >
            <option value="">{t('catalog.allStatuses')}</option>

            <option value="ACTIVE">{t('catalog.active')}</option>

            <option value="INACTIVE">{t('catalog.inactive')}</option>
          </CatalogSelect>
        </div>
      </div>

      <div className="border-t border-border-subtle px-3 py-3">
        <CatalogCategoryFilter
          categories={barCategories}
          selectedId={effectiveCategoryId}
          onSelect={filters.setCategoryId}
          allLabel={t('catalog.allCategories')}
          totalCount={totalCount}
          hiddenCount={hiddenCategoryCount}
          expanded={categoriesExpanded}
          onToggleExpanded={onToggleExpanded}
          onOpenManager={onOpenCategoryManager}
        />

        {/* Compact mode states the hidden count in words, so the cashier knows
            the missing categories are a choice and not missing data. */}
        {categoriesExpanded ? null : (
          <div className="mt-2">
            <CatalogHiddenCategoriesNote count={hiddenCategoryCount} />
          </div>
        )}
      </div>

      {hasFilters ? (
        <div className="flex items-center justify-between gap-3 border-t border-border-subtle px-3 py-2.5">
          <p className="text-caption">
            {resultCount} {t('catalog.type')}
          </p>

          <Button variant="ghost" size="sm" onClick={clearFilters}>
            {t('catalog.clearFilters')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

function CatalogSelect({
  value,
  onChange,
  children,
  ...props
}: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly children: ReactNode
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>) {
  return (
    <select
      {...props}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={[
        'h-11 min-w-0 border border-border-strong bg-surface-input',
        'px-3 text-sm text-foreground',
        'outline-none transition-colors',
        'focus:border-primary focus:ring-1 focus:ring-primary',
      ].join(' ')}
    >
      {children}
    </select>
  )
}
