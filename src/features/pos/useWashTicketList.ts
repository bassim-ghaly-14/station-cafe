/**
 * Daily wash-ticket data — one query, no duplicate sources.
 *
 * This is the twin of `useInvoiceList`, deliberately built the same way:
 *   - the open business day is resolved once per reload from `shift_api.state()`
 *     (never from the calendar clock), and is context, not a filter input;
 *   - the search and the status filter are resolved by the BACKEND, which is
 *     also where the day scoping lives, so the page can never hold a second
 *     opinion about which tickets belong to the day;
 *   - `initialLoading` (nothing on screen yet) and `refreshing` (rows already
 *     on screen, a new request in flight) stay apart, so typing in the search
 *     field never blanks the page;
 *   - the free-text query is debounced by the same interval the invoices page
 *     uses, so both screens feel identical under the hand.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrText } from '@/lib/err'
import { api, type WashTicketRow } from '@/services/posApi'
import { shiftApi } from '@/services/shiftApi'

/** How long typing settles before the backend is queried again. */
const SEARCH_DEBOUNCE_MS = 250

export type WashTicketListQuery = {
  search: string
  status: string
}

export type WashTicketListState = {
  rows: WashTicketRow[]
  /** The resolved business day, or `null` when none is open (history view). */
  dayId: number | null
  initialLoading: boolean
  refreshing: boolean
  error: string | null
  reload: () => void
}

export function useWashTicketList({ search, status }: WashTicketListQuery): WashTicketListState {
  const { t } = useTranslation()
  const errText = useErrText(t)
  const [rows, setRows] = useState<WashTicketRow[] | null>(null)
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
    setLoading(true)
    api
      .washTickets({
        business_day_id: dayIdRef.current ?? undefined,
        query: debouncedSearch.trim() || undefined,
        order_status: status || undefined,
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
  }, [dayResolved, debouncedSearch, status, revision, errText])

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
