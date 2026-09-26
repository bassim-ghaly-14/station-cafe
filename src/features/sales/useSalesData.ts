/**
 * Sales page data — two reads, no client-side aggregation.
 *
 * The page is one filtered dataset, so it is fetched as one dataset:
 *
 *  - `sales_overview` returns the KPIs, the daily trend and the item analysis
 *    together, in a single command. One filter change therefore costs ONE round
 *    trip instead of one per KPI, and the three surfaces can never disagree
 *    because they come from the same response.
 *  - `sales_invoices` is separate because the activity list has its own size
 *    (200 rows) and is the only surface that grows with the period.
 *
 * The free-text customer filter is debounced exactly like the invoice and
 * customer searches, and the two query states are kept apart so typing never
 * blanks the screen:
 *   - `initialLoading` — nothing on screen yet → shaped skeletons;
 *   - `refreshing`     — data is on screen and a new request is in flight.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrText } from '@/lib/err'
import {
  salesApi,
  type SalesFilter,
  type SalesInvoiceRow,
  type SalesItemSort,
  type SalesOverview,
} from '@/services/salesApi'

/** How long typing settles before the backend is queried again. */
const SEARCH_DEBOUNCE_MS = 250

export type SalesDataState = {
  overview: SalesOverview | null
  invoices: SalesInvoiceRow[]
  initialLoading: boolean
  refreshing: boolean
  error: string | null
  reload: () => void
}

export function useSalesData(filter: SalesFilter, sort: SalesItemSort = 'revenue'): SalesDataState {
  const { t } = useTranslation()
  const errText = useErrText(t)
  const [overview, setOverview] = useState<SalesOverview | null>(null)
  const [invoices, setInvoices] = useState<SalesInvoiceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [debouncedCustomer, setDebouncedCustomer] = useState(filter.customer ?? '')

  // The field stays live while the backend is asked once per settled search.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedCustomer(filter.customer ?? ''), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [filter.customer])

  // The filter is taken apart into PRIMITIVES on purpose. Depending on the
  // filter OBJECT would re-issue a request on every keystroke — the field
  // creates a new object per character — and the debounce below would do
  // nothing at all.
  const from = filter.from ?? ''
  const to = filter.to ?? ''
  const method = filter.method ?? ''
  const status = filter.status ?? ''
  const userId = filter.user_id ?? null

  useEffect(() => {
    let active = true
    setLoading(true)
    // One filter object, sent to BOTH reads: the KPIs, the trend, the items and
    // the invoice list can never end up describing different windows.
    const query: SalesFilter = {
      from,
      to,
      method,
      status,
      user_id: userId,
      customer: debouncedCustomer.trim() || null,
    }
    Promise.all([salesApi.overview(query, sort), salesApi.invoices(query)])
      .then(([nextOverview, nextInvoices]) => {
        if (!active) return
        setOverview(nextOverview)
        setInvoices(nextInvoices)
        setError(null)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(errText(cause))
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [from, to, method, status, userId, debouncedCustomer, sort, revision, errText])

  const reload = useCallback(() => setRevision((value) => value + 1), [])
  const hasData = overview !== null
  return {
    overview,
    invoices,
    initialLoading: loading && !hasData,
    refreshing: loading && hasData,
    error,
    reload,
  }
}
