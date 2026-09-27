/**
 * The monthly expenses comparison data — ONE read, independent of the page filter.
 *
 * WHY THIS IS A SEPARATE HOOK from `useExpensesData`:
 * the page's date picker scopes the KPIs, the daily trend, the category ranking
 * and the records list. This series is a CALENDAR comparison between expense
 * categories, and slicing it by an arbitrary business-day range would turn whole
 * months into fragments and change the meaning of every bar. So it is fetched
 * once, from its own command that accepts no range at all, and re-reading it on
 * every period change would be pure waste.
 *
 * Its states mirror the rest of the app: `initialLoading` while there is nothing
 * on screen yet, `refreshing` for an explicit reload, and an `error` the chart
 * surfaces with a retry.
 *
 * THE WINDOW IS A SETTING, NOT A RULE — and it is the SAME setting the sales
 * monthly chart reads. The number of months comes from the persisted Dev
 * Settings value through the same `settingsApi` accessor, so there is no second
 * period state and no second setting anywhere in this feature. It is passed down
 * explicitly so the screen and the query can never disagree, and when the setting
 * cannot be read the request is sent with no argument at all, leaving the backend
 * to apply its own stored default.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrText } from '@/lib/err'
import { settingsApi } from '@/services/posApi'
import { opsApi, type ExpenseMonthlyWindow } from '@/services/opsApi'

export type MonthlyExpensesState = {
  window: ExpenseMonthlyWindow | null
  initialLoading: boolean
  refreshing: boolean
  error: string | null
  reload: () => void
}

export function useMonthlyExpenses(): MonthlyExpensesState {
  const { t } = useTranslation()
  const errText = useErrText(t)
  const [window, setWindow] = useState<ExpenseMonthlyWindow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    // The configured window decides how many month buckets come back. It is read
    // from the settings table, exactly like every other cafe configuration and
    // exactly like the sales monthly chart.
    settingsApi
      .monthlySalesPeriod()
      .then((config) => opsApi.expensesMonthly(config.months))
      .catch(() => opsApi.expensesMonthly())
      .then((response) => {
        if (!active) return
        setWindow(response)
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
  }, [revision, errText])

  const reload = useCallback(() => setRevision((value) => value + 1), [])
  const hasWindow = window !== null
  return {
    window,
    initialLoading: loading && !hasWindow,
    refreshing: loading && hasWindow,
    error,
    reload,
  }
}
