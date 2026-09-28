/**
 * The wash-ticket toolbar: live search plus the one filter the backend can
 * actually answer.
 *
 * Structurally the same toolbar the invoices page uses — a live search field
 * with a magnifier, a clear affordance and a stated expectation, then the
 * narrowing selects and a reset that exists only while something narrows the
 * list. Deliberately narrower than the invoice toolbar: a wash ticket has no
 * payment method, and a control the backend cannot resolve would be a filter
 * that silently does nothing.
 */
import { useTranslation } from 'react-i18next'
import { Button, FilterBar, Select, ToolbarSearch } from '@/components/ui'
import { FilterX } from '@/components/ui/icon'
import type { WashTicketListQuery } from './useWashTicketList'

const STATUSES = ['OPEN', 'READY_TO_PAY', 'CLOSED'] as const

export function WashTicketFilters({
  query,
  onChange,
  onReset,
  className,
}: {
  readonly query: WashTicketListQuery
  readonly onChange: (next: WashTicketListQuery) => void
  /** Clears every narrowing control at once. */
  readonly onReset: () => void
  readonly className?: string
}) {
  const { t } = useTranslation()
  const active = query.search.trim() !== '' || query.status !== ''

  return (
    <FilterBar
      className={className}
      search={
        <ToolbarSearch
          value={query.search}
          onValueChange={(search) => onChange({ ...query, search })}
          label={t('washTicketsPage.search.label')}
          placeholder={t('washTicketsPage.search.placeholder')}
          hint={t('washTicketsPage.search.hint')}
          clearLabel={t('washTicketsPage.search.clear')}
        />
      }
    >
      <div className="w-full sm:w-48">
        <label className="sr-only" htmlFor="wash-ticket-status">
          {t('washTicketsPage.filters.status')}
        </label>
        <Select
          id="wash-ticket-status"
          value={query.status}
          onChange={(event) => onChange({ ...query, status: event.target.value })}
        >
          <option value="">{t('washTicketsPage.filters.statusAll')}</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(`washTicketsPage.orderStatus.${status}`)}
            </option>
          ))}
        </Select>
      </div>

      {/* Reset exists only while something is narrowing the list. */}
      {active ? (
        <Button type="button" variant="ghost" onClick={onReset}>
          <FilterX size={16} aria-hidden />
          {t('washTicketsPage.filters.reset')}
        </Button>
      ) : null}
    </FilterBar>
  )
}
