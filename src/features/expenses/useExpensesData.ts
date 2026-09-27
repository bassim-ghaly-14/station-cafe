/**
 * Expenses page data — ONE period, read once, no client-side aggregation.
 *
 * The page is a single filtered dataset, so it is fetched as a single dataset:
 * `expenses_overview` returns the KPIs, the daily trend and the category ranking
 * together, and `list_expenses` returns the page of records. Both reads take the
 * SAME `from`/`to` this hook was given, so the headline number, the chart and the
 * rows underneath always describe one window.
 *
 * The two query states are kept apart, exactly like the sales and employees
 * hooks, so changing the period never blanks the screen:
 *   - `initialLoading` — nothing on screen yet → shaped skeletons;
 *   - `refreshing`     — data is on screen and a new request is in flight.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrText } from '@/lib/err'
import { opsApi, type Expense, type ExpenseOverview } from '@/services/opsApi'

export type ExpensesDataState = {
  overview: ExpenseOverview | null
  rows: Expense[]
  initialLoading: boolean
  refreshing: boolean
  error: string | null
  reload: () => void
}

export function useExpensesData(from: string, to: string): ExpensesDataState {
  const { t } = useTranslation()
  const errText = useErrText(t)
  const [overview, setOverview] = useState<ExpenseOverview | null>(null)
  const [rows, setRows] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    // One window, two reads. The overview is the aggregate; the list is the
    // page of records behind it — the totals are never re-summed in React.
    const period = { from: from || undefined, to: to || undefined }
    Promise.all([
      opsApi.expensesOverview(period.from, period.to),
      opsApi.expenses(period.from, period.to),
    ])
      .then(([nextOverview, nextRows]) => {
        if (!active) return
        setOverview(nextOverview)
        setRows(nextRows)
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
  }, [from, to, revision, errText])

  const reload = useCallback(() => setRevision((value) => value + 1), [])
  const hasData = overview !== null
  return {
    overview,
    rows,
    initialLoading: loading && !hasData,
    refreshing: loading && hasData,
    error,
    reload,
  }
}
