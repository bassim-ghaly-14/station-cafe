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
import { Button, FilterBar, Select, ToolbarSearch } from '@/components/ui'
import { FilterX } from '@/components/ui/icon'
import type { InvoiceListQuery } from './useInvoiceList'

const STATUSES = ['PAID', 'PARTIALLY_PAID', 'CREDIT'] as const
const METHODS = ['CASH', 'CARD', 'CREDIT'] as const

export function InvoiceFilters({
  query,
  onChange,
  onReset,
  className,
}: {
  readonly query: InvoiceListQuery
  readonly onChange: (next: InvoiceListQuery) => void
  /** Clears every narrowing control at once. */
  readonly onReset: () => void
  readonly className?: string
}) {
  const { t } = useTranslation()
  const active = query.search.trim() !== '' || query.status !== '' || query.method !== ''

  return (
    <FilterBar
      className={className}
      search={
        <ToolbarSearch
          value={query.search}
          onValueChange={(search) => onChange({ ...query, search })}
          label={t('invoicesPage.search.label')}
          placeholder={t('invoicesPage.search.placeholder')}
          hint={t('invoicesPage.search.hint')}
          clearLabel={t('invoicesPage.search.clear')}
        />
      }
    >
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
    </FilterBar>
  )
}
