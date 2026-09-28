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
import { Button, DateRangePicker, FilterBar, ToolbarSearch } from '@/components/ui'
import { FilterX } from '@/components/ui/icon'
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
      {/* Row 1 — the data-management toolbar. The shared `FilterBar` gives the
          search its own full-width line on a phone and puts the create action
          beneath it, instead of the two competing for 296px. */}
      <FilterBar
        search={
          <ToolbarSearch
            value={query}
            onValueChange={onQueryChange}
            label={t('customers.search.label')}
            placeholder={t('customers.search.placeholder')}
            hint={t('customers.search.hint')}
            clearLabel={t('customers.search.clear')}
          />
        }
      >
        {actions}

        {filtered ? (
          <Button type="button" variant="ghost" onClick={onReset}>
            <FilterX size={16} aria-hidden />
            {t('customers.filters.reset')}
          </Button>
        ) : null}
      </FilterBar>

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
