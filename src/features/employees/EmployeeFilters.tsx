/**
 * The employees toolbar: live search, the primary create action, and the
 * analytics period.
 *
 * Search is LIVE for the same reason it is live on the invoices page: the
 * backend resolves it as the user types, so a submit button could only repeat a
 * query the screen has already run.
 *
 * Two rows, on purpose:
 *   row 1 — the data-management toolbar: the search field takes every bit of
 *           free space and the create action stays anchored to the inline end.
 *   row 2 — the period control on its own line, because it scopes the FIGURES
 *           (attendance, hours, performance), not the roster itself. Putting it
 *           beside the search would imply it filters the table, which it does
 *           not — the same separation the customers toolbar draws.
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, DateRangePicker, Switch } from '@/components/ui'
import { FilterX, Search, X } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import type { DateRange } from '@/components/ui/date-range-picker'

export function EmployeeFilters({
  query,
  onQueryChange,
  range,
  onRangeChange,
  includeInactive,
  onIncludeInactiveChange,
  onReset,
  actions,
  className,
}: {
  readonly query: string
  readonly onQueryChange: (value: string) => void
  readonly range: DateRange
  readonly onRangeChange: (range: DateRange) => void
  /** Deactivation is reversible, so inactive staff stay reachable. */
  readonly includeInactive: boolean
  readonly onIncludeInactiveChange: (value: boolean) => void
  readonly onReset: () => void
  /** Primary action rendered at the inline end of the search row. */
  readonly actions?: ReactNode
  readonly className?: string
}) {
  const { t } = useTranslation()
  const filtered = query.trim() !== ''
  const perioded = range.from !== '' || range.to !== ''

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <label className="sr-only" htmlFor="employee-search">
            {t('employees.search.label')}
          </label>
          <Search
            size={16}
            aria-hidden
            className="pointer-events-none absolute inset-y-0 inset-s-3 my-auto text-foreground-subtle"
          />
          <input
            id="employee-search"
            type="search"
            role="searchbox"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t('employees.search.placeholder')}
            aria-describedby="employee-search-hint"
            className="h-10 w-full rounded-md border border-border-strong bg-surface-input ps-9 pe-9 text-base text-foreground placeholder:text-placeholder-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus [&::-webkit-search-cancel-button]:hidden"
          />
          {query !== '' ? (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              aria-label={t('employees.search.clear')}
              title={t('employees.search.clear')}
              className="absolute inset-y-0 inset-e-1 my-auto flex size-8 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              <X size={15} aria-hidden />
            </button>
          ) : null}
          <p id="employee-search-hint" className="sr-only">
            {t('employees.search.hint')}
          </p>
        </div>

        {actions}

        {filtered ? (
          <Button type="button" variant="ghost" onClick={onReset}>
            <FilterX size={16} aria-hidden />
            {t('employees.filters.reset')}
          </Button>
        ) : null}
      </div>

      {/* Row 2 — the period that scopes every figure, plus the roster filter. */}
      <div className="flex flex-wrap items-center gap-3">
        <DateRangePicker
          from={range.from}
          to={range.to}
          onChange={onRangeChange}
          label={t('employees.period.label')}
        />
        <label className="flex cursor-pointer items-center gap-2 text-caption text-foreground-muted">
          <Switch
            checked={includeInactive}
            onCheckedChange={onIncludeInactiveChange}
            aria-label={t('employees.filters.includeInactive')}
          />
          {t('employees.filters.includeInactive')}
        </label>
        {perioded ? (
          <Button type="button" variant="ghost" onClick={onReset}>
            <FilterX size={16} aria-hidden />
            {t('employees.filters.reset')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
