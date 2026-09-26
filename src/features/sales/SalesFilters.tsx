/**
 * The sales toolbar: the period every section obeys, and the narrowing controls.
 *
 * Two rows, on purpose:
 *  - row 1 — the period control and a refresh, always visible. It is THE filter
 *    of this page: the KPIs, the trend, the items and the invoice list all read
 *    the same range, so it must never be buried.
 *  - row 2 — the narrowing controls, revealed on demand (progressive
 *    disclosure). A manager opening the page sees the situation, not a wall of
 *    form fields; a manager investigating opens the panel.
 *
 * Every control here is backed by a real query parameter. There is no
 * department filter: a hybrid invoice carries cafe AND wash money, and Station
 * has no authoritative per-department allocation of the invoice discount or
 * service charge, so filtering revenue by department would have to invent one.
 * The business split is therefore presented as a breakdown, not as a filter.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, DateRangePicker, Select } from '@/components/ui'
import { FilterX, RefreshCw, Search, SlidersHorizontal, X } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import type { DateRange } from '@/components/ui/date-range-picker'
import type { SalesCashier, SalesFilter } from '@/services/salesApi'

const METHODS = ['CASH', 'CARD', 'CREDIT'] as const
const STATUSES = ['PAID', 'PARTIALLY_PAID', 'CREDIT'] as const

const FIELD =
  'h-10 w-full rounded-md border border-border-strong bg-surface-input text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus'

export function SalesFilters({
  filter,
  onChange,
  cashiers,
  refreshing,
  onRefresh,
  onReset,
  className,
}: {
  filter: SalesFilter
  onChange: (next: SalesFilter) => void
  cashiers: SalesCashier[]
  refreshing?: boolean
  onRefresh: () => void
  onReset: () => void
  className?: string
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const narrowing =
    (filter.method ?? '') !== '' ||
    (filter.status ?? '') !== '' ||
    filter.user_id != null ||
    (filter.customer ?? '') !== ''

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker
          from={filter.from ?? ''}
          to={filter.to ?? ''}
          onChange={(range: DateRange) => onChange({ ...filter, from: range.from, to: range.to })}
          label={t('sales.period.label')}
        />

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls="sales-filters-panel"
        >
          <SlidersHorizontal size={15} aria-hidden />
          {t('sales.filters.more')}
        </Button>

        {narrowing ? (
          <Button type="button" variant="ghost" size="sm" onClick={onReset}>
            <FilterX size={15} aria-hidden />
            {t('sales.filters.reset')}
          </Button>
        ) : null}

        <span className="ms-auto">
          <Button type="button" variant="ghost" size="sm" onClick={onRefresh} loading={refreshing}>
            {!refreshing ? <RefreshCw size={15} aria-hidden /> : null}
            {t('sales.filters.refresh')}
          </Button>
        </span>
      </div>

      {expanded ? (
        <div
          id="sales-filters-panel"
          className="flex flex-wrap items-end gap-2 rounded-md border border-border-subtle bg-surface-muted p-3"
        >
          <div className="w-full sm:w-44">
            <label className="sr-only" htmlFor="sales-method">
              {t('sales.filters.method')}
            </label>
            <Select
              id="sales-method"
              value={filter.method ?? ''}
              onChange={(event) => onChange({ ...filter, method: event.target.value })}
            >
              <option value="">{t('sales.filters.methodAll')}</option>
              {METHODS.map((method) => (
                <option key={method} value={method}>
                  {t(`pay.method.${method}`)}
                </option>
              ))}
            </Select>
          </div>

          <div className="w-full sm:w-44">
            <label className="sr-only" htmlFor="sales-status">
              {t('sales.filters.status')}
            </label>
            <Select
              id="sales-status"
              value={filter.status ?? ''}
              onChange={(event) => onChange({ ...filter, status: event.target.value })}
            >
              <option value="">{t('sales.filters.statusAll')}</option>
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`invoice.status.${status}`)}
                </option>
              ))}
            </Select>
          </div>

          <div className="w-full sm:w-44">
            <label className="sr-only" htmlFor="sales-cashier">
              {t('sales.filters.cashier')}
            </label>
            <Select
              id="sales-cashier"
              value={filter.user_id == null ? '' : String(filter.user_id)}
              onChange={(event) =>
                onChange({
                  ...filter,
                  user_id: event.target.value ? Number(event.target.value) : null,
                })
              }
            >
              <option value="">{t('sales.filters.cashierAll')}</option>
              {cashiers.map((cashier) => (
                <option key={cashier.id} value={cashier.id}>
                  {cashier.name}
                </option>
              ))}
            </Select>
          </div>

          {/* The one free-text control: the backend matches it against the
              customer name snapshotted on the invoice, not the live record. */}
          <div className="relative w-full sm:w-56">
            <label className="sr-only" htmlFor="sales-customer">
              {t('sales.filters.customer')}
            </label>
            <Search
              size={15}
              aria-hidden
              className="pointer-events-none absolute inset-y-0 inset-s-3 my-auto text-foreground-subtle"
            />
            <input
              id="sales-customer"
              type="search"
              value={filter.customer ?? ''}
              onChange={(event) => onChange({ ...filter, customer: event.target.value })}
              placeholder={t('sales.filters.customerPlaceholder')}
              aria-describedby="sales-customer-hint"
              className={`${FIELD} ps-9 pe-9 placeholder:text-placeholder-foreground [&::-webkit-search-cancel-button]:hidden`}
            />
            {(filter.customer ?? '') !== '' ? (
              <button
                type="button"
                onClick={() => onChange({ ...filter, customer: '' })}
                aria-label={t('sales.filters.customerClear')}
                title={t('sales.filters.customerClear')}
                className="absolute inset-y-0 inset-e-1 my-auto flex size-8 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground"
              >
                <X size={15} aria-hidden />
              </button>
            ) : null}
            <p id="sales-customer-hint" className="sr-only">
              {t('sales.filters.customerHint')}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}
