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
import { Button, DateRangePicker, FilterBar, Switch, ToolbarSearch } from '@/components/ui'
import { FilterX } from '@/components/ui/icon'
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
      {/* Row 1 — the data-management toolbar. The shared `FilterBar` gives the
          search its own full-width line on a phone and puts the create action
          beneath it, instead of the two competing for 296px. */}
      <FilterBar
        search={
          <ToolbarSearch
            value={query}
            onValueChange={onQueryChange}
            label={t('employees.search.label')}
            placeholder={t('employees.search.placeholder')}
            hint={t('employees.search.hint')}
            clearLabel={t('employees.search.clear')}
          />
        }
      >
        {actions}

        {filtered ? (
          <Button type="button" variant="ghost" onClick={onReset}>
            <FilterX size={16} aria-hidden />
            {t('employees.filters.reset')}
          </Button>
        ) : null}
      </FilterBar>

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
