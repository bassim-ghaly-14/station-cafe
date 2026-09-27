/**
 * The customers toolbar: live search, the primary create action, and the
 * analytics period.
 *
 * Search is LIVE for the reason it is live on the invoices page — the backend
 * resolves it as the user types, so a submit button could only repeat a query
 * the screen has already run.
 *
 * Two rows, on purpose:
 *   row 1 — the data-management toolbar: the search field takes every bit of
 *           free space, the compact create action stays anchored to the
 *           inline end. They are the two things the user reaches for most.
 *   row 2 — the period control on its own line, because it scopes the ANALYTICS
 *           only, not the list. Putting it beside the search would imply it
 *           filters the table, which it does not.
 *
 * The date range is shown ONLY to a role that receives analytics. The list
 * itself is not period-scoped, so offering the control to a role that cannot
 * see the period's numbers would be a filter that appears to do nothing.
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, DateRangePicker } from '@/components/ui'
import { FilterX, Search, X } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import type { DateRange } from '@/components/ui/date-range-picker'

export function CustomerFilters({
  query,
  onQueryChange,
  range,
  onRangeChange,
  showPeriod,
  onReset,
  actions,
  className,
}: {
  readonly query: string
  readonly onQueryChange: (value: string) => void
  readonly range: DateRange
  readonly onRangeChange: (range: DateRange) => void
  /** Whether this role receives the period analytics at all. */
  readonly showPeriod: boolean
  readonly onReset: () => void
  /** Primary action rendered at the inline end of the search row. */
  readonly actions?: ReactNode
  readonly className?: string
}) {
  const { t } = useTranslation()
  const filtered = query.trim() !== ''
  const perioded = showPeriod && (range.from !== '' || range.to !== '')

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {/* The search field takes the free space; the create action keeps its
            natural width so the field stays visually dominant. */}
        <div className="relative min-w-56 flex-1">
          <label className="sr-only" htmlFor="customer-search">
            {t('customers.search.label')}
          </label>
          <Search
            size={16}
            aria-hidden
            className="pointer-events-none absolute inset-y-0 inset-s-3 my-auto text-foreground-subtle"
          />
          <input
            id="customer-search"
            type="search"
            role="searchbox"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t('customers.search.placeholder')}
            aria-describedby="customer-search-hint"
            className="h-10 w-full rounded-md border border-border-strong bg-surface-input ps-9 pe-9 text-base text-foreground placeholder:text-placeholder-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus [&::-webkit-search-cancel-button]:hidden"
          />
          {query !== '' ? (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              aria-label={t('customers.search.clear')}
              title={t('customers.search.clear')}
              className="absolute inset-y-0 inset-e-1 my-auto flex size-8 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              <X size={15} aria-hidden />
            </button>
          ) : null}
          {/* States the live behaviour in words, so "instant" is not a guess. */}
          <p id="customer-search-hint" className="sr-only">
            {t('customers.search.hint')}
          </p>
        </div>

        {actions}

        {filtered ? (
          <Button type="button" variant="ghost" onClick={onReset}>
            <FilterX size={16} aria-hidden />
            {t('customers.filters.reset')}
          </Button>
        ) : null}
      </div>

      {/* Row 2 — the analytics period, deliberately on its own line. */}
      {showPeriod ? (
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker
            from={range.from}
            to={range.to}
            onChange={onRangeChange}
            label={t('customers.period.label')}
          />
          {perioded ? (
            <Button type="button" variant="ghost" onClick={onReset}>
              <FilterX size={16} aria-hidden />
              {t('customers.filters.reset')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
