/**
 * Invoice list data for the invoices page — one query, no duplicate sources.
 *
 * Everything the page shows comes from the SAME two commands the POS already
 * uses: `shift_api.state()` to resolve the open business day, and
 * `search_invoices` to read the day (or the whole history when no day is open).
 * No client-side filtering is introduced: the search box, the status filter and
 * the payment-method filter are all resolved by the backend, which is also
 * where the 200-row cap lives.
 *
 * Two query states are kept apart, the way the operations log does it:
 *   - `initialLoading` — nothing is on screen yet, so the page shows a shaped
 *     skeleton;
 *   - `refreshing`     — rows are already on screen and a new search/filter
 *     request is in flight, so the list stays visible and merely marks itself
 *     busy instead of blanking out on every keystroke.
 *
 * The free-text query is debounced: the field stays live and responsive while
 * the backend is asked once per settled search instead of once per character.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrText } from '@/lib/err'
import { api, type InvoiceRow } from '@/services/posApi'
import { shiftApi } from '@/services/shiftApi'

/** How long typing settles before the backend is queried again. */
const SEARCH_DEBOUNCE_MS = 250

export type InvoiceListQuery = {
  search: string
  status: string
  method: string
}

export type InvoiceListState = {
  rows: InvoiceRow[]
  /** The resolved business day, or `null` when none is open (history view). */
  dayId: number | null
  initialLoading: boolean
  refreshing: boolean
  error: string | null
  reload: () => void
}

export function useInvoiceList({ search, status, method }: InvoiceListQuery): InvoiceListState {
  const { t } = useTranslation()
  const errText = useErrText(t)
  const [rows, setRows] = useState<InvoiceRow[] | null>(null)
  const [dayId, setDayId] = useState<number | null>(null)
  const [dayResolved, setDayResolved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  // The live value the debounce writes into; `search` itself may still be
  // mid-sentence, so the effect must never depend on it directly.
  const [debouncedSearch, setDebouncedSearch] = useState(search)
  const dayIdRef = useRef<number | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  // The open business day is context, not a filter input: it is resolved once
  // per reload instead of on every keystroke.
  useEffect(() => {
    let active = true
    shiftApi
      .state()
      .then((state) => {
        if (!active) return
        const id = state.day?.id ?? null
        dayIdRef.current = id
        setDayId(id)
        setDayResolved(true)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(errText(cause))
        setDayResolved(true)
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [revision, errText])

  useEffect(() => {
    if (!dayResolved) return
    let active = true
    // Gated on the resolved business day; `loading` is raised before the search
    // starts so the list marks itself busy instead of blanking on every filter.
    // oxlint-disable-next-line react/set-state-in-effect -- external async read.
    setLoading(true)
    api
      .invoices({
        business_day_id: dayIdRef.current ?? undefined,
        query: debouncedSearch.trim() || undefined,
        status: status || undefined,
        method: method || undefined,
      })
      .then((result) => {
        if (!active) return
        setRows(result)
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
  }, [dayResolved, debouncedSearch, status, method, revision, errText])

  const reload = useCallback(() => setRevision((value) => value + 1), [])

  const hasRows = rows !== null
  return {
    rows: rows ?? [],
    dayId,
    initialLoading: loading && !hasRows,
    refreshing: loading && hasRows,
    error,
    reload,
  }
}
