/**
 * Customers page data — one query per surface, no client-side aggregation.
 *
 * The list, the KPI band and the drawer are three separate backend reads
 * because they have three DIFFERENT authorization levels: the list is open to
 * every role, while the KPI band and the drawer are manager-level. Keeping
 * them apart means a cashier's browser never holds a financial figure at all.
 *
 * The free-text query is debounced, exactly like the invoices page: the field
 * stays live while the backend is asked once per settled search. The two query
 * states are kept apart as well, so typing never blanks the screen:
 *   - `initialLoading` — nothing on screen yet → shaped skeletons;
 *   - `refreshing`     — rows are on screen and a new request is in flight.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrText } from '@/lib/err'
import { customersApi } from '@/services/customersApi'
import type { CustomerList, CustomerOverview } from '@/services/customersApi'

/** How long typing settles before the backend is queried again. */
const SEARCH_DEBOUNCE_MS = 250

export type CustomerListState = {
  list: CustomerList | null
  initialLoading: boolean
  refreshing: boolean
  error: string | null
  reload: () => void
}

export type CustomerOverviewState = {
  overview: CustomerOverview | null
  loading: boolean
  error: string | null
  reload: () => void
}

/** The page list, for every role. */
export function useCustomerList(query: string, from: string, to: string): CustomerListState {
  const { t } = useTranslation()
  const errText = useErrText(t)
  const [list, setList] = useState<CustomerList | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [debouncedQuery, setDebouncedQuery] = useState(query)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    let active = true
    // `loading` is the in-flight flag and must be raised before the request,
    // not derived during render; deriving it would move the request into render
    // and drop the `active` guard that discards stale answers.
    // oxlint-disable-next-line react/set-state-in-effect -- external async read.
    setLoading(true)
    customersApi
      .list(debouncedQuery, { from, to })
      .then((result) => {
        if (!active) return
        setList(result)
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
  }, [debouncedQuery, from, to, revision, errText])

  const reload = useCallback(() => setRevision((value) => value + 1), [])
  const hasRows = list !== null
  return {
    list,
    initialLoading: loading && !hasRows,
    refreshing: loading && hasRows,
    error,
    reload,
  }
}

/**
 * The KPI band.
 *
 * `enabled` is the caller's role decision, and it is enforced HERE rather than
 * by conditionally calling the hook: the hook itself is unconditional (hooks
 * order must not change with the role), but with `enabled = false` it issues no
 * request at all, so a cashier's browser never asks for analytics it may not
 * have. The backend refuses the same call anyway — this only avoids making it.
 */
export function useCustomerOverview(
  from: string,
  to: string,
  enabled = true,
): CustomerOverviewState {
  const { t } = useTranslation()
  const errText = useErrText(t)
  const [overview, setOverview] = useState<CustomerOverview | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!enabled) {
      // When the session stops being manager-level the KPI must be
      // DROPPED, not merely left in place while the request is skipped. A cashier
      // must never hold a financial figure, so this is a security-relevant reset.
      // oxlint-disable-next-line react/set-state-in-effect -- role gate.
      setOverview(null)
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    customersApi
      .overview({ from, to })
      .then((result) => {
        if (!active) return
        setOverview(result)
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
  }, [from, to, revision, errText, enabled])

  return {
    overview,
    loading,
    error,
    reload: useCallback(() => setRevision((value) => value + 1), []),
  }
}
