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
import { Button, Select } from '@/components/ui'
import { FilterX, Search, X } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
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
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {/* The search field takes the free space; the filter keeps a fixed width
          so the primary control stays the visually dominant one. */}
      <div className="relative min-w-56 flex-1">
        <label className="sr-only" htmlFor="wash-ticket-search">
          {t('washTicketsPage.search.label')}
        </label>
        <Search
          size={16}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 inset-s-3 my-auto text-foreground-subtle"
        />
        <input
          id="wash-ticket-search"
          type="search"
          role="searchbox"
          value={query.search}
          onChange={(event) => onChange({ ...query, search: event.target.value })}
          placeholder={t('washTicketsPage.search.placeholder')}
          aria-describedby="wash-ticket-search-hint"
          // WebKit draws its own clear affordance on `type="search"`; the
          // explicit button below is the labelled, RTL-correct one.
          className="h-10 w-full rounded-md border border-border-strong bg-surface-input ps-9 pe-9 text-base text-foreground placeholder:text-placeholder-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus [&::-webkit-search-cancel-button]:hidden"
        />
        {query.search !== '' ? (
          <button
            type="button"
            onClick={() => onChange({ ...query, search: '' })}
            aria-label={t('washTicketsPage.search.clear')}
            title={t('washTicketsPage.search.clear')}
            className="absolute inset-y-0 inset-e-1 my-auto flex size-8 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <X size={15} aria-hidden />
          </button>
        ) : null}
        {/* States the live behaviour in words, so "instant" is not a guess. */}
        <p id="wash-ticket-search-hint" className="sr-only">
          {t('washTicketsPage.search.hint')}
        </p>
      </div>

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
    </div>
  )
}
