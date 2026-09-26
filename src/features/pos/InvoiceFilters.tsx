/**
 * The invoice toolbar: live search plus the two filters the backend can
 * actually answer.
 *
 * Search is LIVE. There is no submit button and there never needs to be one:
 * the field filters through `search_invoices` as the user types, so a search
 * button could only repeat a query the screen has already run. The only
 * affordances the field needs are a magnifier (it says "this looks"), a clear
 * button that appears once there is something to clear, and a stated
 * expectation that results update as you type.
 *
 * Only controls backed by real query parameters are exposed: free text,
 * invoice status and payment method. There is deliberately no date-range
 * control here — `search_invoices` takes no dates, and a date filter that
 * silently does nothing is worse than none.
 */
import { useTranslation } from 'react-i18next'
import { Button, Select } from '@/components/ui'
import { FilterX, Search, X } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import type { InvoiceListQuery } from './useInvoiceList'

const STATUSES = ['PAID', 'PARTIALLY_PAID', 'CREDIT'] as const
const METHODS = ['CASH', 'CARD', 'CREDIT'] as const

export function InvoiceFilters({
  query,
  onChange,
  onReset,
  className,
}: {
  query: InvoiceListQuery
  onChange: (next: InvoiceListQuery) => void
  /** Clears every narrowing control at once. */
  onReset: () => void
  className?: string
}) {
  const { t } = useTranslation()
  const active = query.search.trim() !== '' || query.status !== '' || query.method !== ''

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {/* The search field takes the free space; the filters keep a fixed width
          so the primary control stays the visually dominant one. */}
      <div className="relative min-w-56 flex-1">
        <label className="sr-only" htmlFor="invoice-search">
          {t('invoicesPage.search.label')}
        </label>
        <Search
          size={16}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 inset-s-3 my-auto text-foreground-subtle"
        />
        <input
          id="invoice-search"
          type="search"
          role="searchbox"
          value={query.search}
          onChange={(event) => onChange({ ...query, search: event.target.value })}
          placeholder={t('invoicesPage.search.placeholder')}
          aria-describedby="invoice-search-hint"
          // WebKit draws its own clear affordance on `type="search"`; the
          // explicit button below is the labelled, RTL-correct one, so the
          // native control is suppressed to avoid two competing actions.
          className="h-10 w-full rounded-md border border-border-strong bg-surface-input ps-9 pe-9 text-base text-foreground placeholder:text-placeholder-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus [&::-webkit-search-cancel-button]:hidden"
        />
        {query.search !== '' ? (
          <button
            type="button"
            onClick={() => onChange({ ...query, search: '' })}
            aria-label={t('invoicesPage.search.clear')}
            title={t('invoicesPage.search.clear')}
            className="absolute inset-y-0 inset-e-1 my-auto flex size-8 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <X size={15} aria-hidden />
          </button>
        ) : null}
        {/* States the live behaviour in words, so "instant" is not a guess. */}
        <p id="invoice-search-hint" className="sr-only">
          {t('invoicesPage.search.hint')}
        </p>
      </div>

      <div className="w-full sm:w-44">
        <label className="sr-only" htmlFor="invoice-status">
          {t('invoicesPage.filters.status')}
        </label>
        <Select
          id="invoice-status"
          value={query.status}
          onChange={(event) => onChange({ ...query, status: event.target.value })}
        >
          <option value="">{t('invoicesPage.filters.statusAll')}</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(`invoice.status.${status}`)}
            </option>
          ))}
        </Select>
      </div>

      <div className="w-full sm:w-44">
        <label className="sr-only" htmlFor="invoice-method">
          {t('invoicesPage.filters.method')}
        </label>
        <Select
          id="invoice-method"
          value={query.method}
          onChange={(event) => onChange({ ...query, method: event.target.value })}
        >
          <option value="">{t('invoicesPage.filters.methodAll')}</option>
          {METHODS.map((method) => (
            <option key={method} value={method}>
              {t(`pay.method.${method}`)}
            </option>
          ))}
        </Select>
      </div>

      {/* Reset exists only while something is narrowing the list. */}
      {active ? (
        <Button type="button" variant="ghost" onClick={onReset}>
          <FilterX size={16} aria-hidden />
          {t('invoicesPage.filters.reset')}
        </Button>
      ) : null}
    </div>
  )
}
