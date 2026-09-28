import { useTranslation } from 'react-i18next'
import { Button, FilterBar, Select, ToolbarSearch } from '@/components/ui'
import { RotateCcw } from '@/components/ui/icon'
import type { AuditEntry } from '@/services/opsApi'
import { hasActiveFilters, presentActors, type OperationFilters } from './useOperationHistory'
import { operationGroupLabelKey, presentGroups, type OperationGroupId } from './operationTypes'

/**
 * OperationHistoryFilters — the toolbar above the operations log.
 *
 * Only filters the data can actually answer are exposed. The log carries an
 * action, an entity and an actor, so those three are what is offered: free-text
 * search, operation type, and operator. There is deliberately no date range,
 * amount or status control, because the log records none of those — a control
 * that silently cannot filter is worse than no control.
 *
 * Layout: a search field that takes the free space, then two fixed-width
 * selects, then reset. The whole row wraps, so a narrow window stacks the
 * controls instead of squeezing them.
 */
export function OperationHistoryFilters({
  rows,
  filters,
  onChange,
  className,
}: Readonly<{
  readonly rows: readonly AuditEntry[]
  readonly filters: OperationFilters
  readonly onChange: (next: OperationFilters) => void
  readonly className?: string
}>) {
  const { t } = useTranslation()
  const groups = presentGroups(rows.map((entry) => entry.action))
  const actors = presentActors(rows)
  const active = hasActiveFilters(filters)

  return (
    <FilterBar
      className={className}
      search={
        <ToolbarSearch
          value={filters.search}
          onValueChange={(search) => onChange({ ...filters, search })}
          label={t('audit.search.label')}
          placeholder={t('audit.search.placeholder')}
          clearLabel={t('audit.search.clear')}
        />
      }
    >
      <div className="w-full sm:w-44">
        <label className="sr-only" htmlFor="operation-history-group">
          {t('audit.filters.type')}
        </label>
        <Select
          id="operation-history-group"
          value={filters.group ?? ''}
          onChange={(event) =>
            onChange({
              ...filters,
              group: (event.target.value || null) as OperationGroupId | null,
            })
          }
        >
          <option value="">{t('audit.filters.typeAll')}</option>
          {groups.map((group) => (
            <option key={group} value={group}>
              {t(operationGroupLabelKey(group))}
            </option>
          ))}
        </Select>
      </div>

      <div className="w-full sm:w-44">
        <label className="sr-only" htmlFor="operation-history-actor">
          {t('audit.filters.actor')}
        </label>
        <Select
          id="operation-history-actor"
          value={filters.actor ?? ''}
          disabled={actors.length === 0}
          onChange={(event) => onChange({ ...filters, actor: event.target.value || null })}
        >
          <option value="">{t('audit.filters.actorAll')}</option>
          {actors.map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.name || t('audit.actionFallback')}
            </option>
          ))}
        </Select>
      </div>

      {/* Reset only exists while something is narrowing the list, so the
          toolbar stays quiet until it is needed. */}
      {active ? (
        <Button
          type="button"
          variant="ghost"
          size="md"
          onClick={() => onChange({ search: '', group: null, actor: null })}
        >
          <RotateCcw size={16} aria-hidden />
          {t('audit.filters.reset')}
        </Button>
      ) : null}
    </FilterBar>
  )
}
