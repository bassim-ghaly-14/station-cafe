/**
 * The monthly comparison data — ONE read, independent of the page filter.
 *
 * WHY THIS IS A SEPARATE HOOK from `useSalesData`:
 * the page's date picker scopes the KPIs, the daily trend, the item analysis and
 * the invoice list. This series is a CALENDAR comparison between two business
 * lines, and slicing it by an arbitrary business-day range would turn whole
 * months into fragments and change the meaning of every bar. So it is fetched
 * once, from its own command that accepts no filter at all, and re-reading it on
 * every period change would be pure waste.
 *
 * Its states mirror the rest of the app: `initialLoading` while there is nothing
 * on screen yet, `refreshing` for an explicit reload, and an `error` the chart
 * surfaces with a retry.
 *
 * THE WINDOW IS A SETTING, NOT A RULE: the number of months comes from the
 * persisted Dev Settings value, read through the same `settingsApi` every other
 * screen uses. It is passed down explicitly so the screen and the query can never
 * disagree, and when the setting cannot be read the request is sent with no
 * argument at all, leaving the backend to apply its own stored default.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrText } from '@/lib/err'
import { settingsApi } from '@/services/posApi'
import { salesApi, type SalesMonthlyReport } from '@/services/salesApi'

export type MonthlyRevenueState = {
  report: SalesMonthlyReport | null
  initialLoading: boolean
  refreshing: boolean
  error: string | null
  reload: () => void
}

export function useMonthlyRevenue(): MonthlyRevenueState {
  const { t } = useTranslation()
  const errText = useErrText(t)
  const [report, setReport] = useState<SalesMonthlyReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    // The configured window decides how many month buckets come back. It is read
    // from the settings table, exactly like every other cafe configuration.
    settingsApi
      .monthlySalesPeriod()
      .then((config) => salesApi.monthly(config.months))
      .catch(() => salesApi.monthly())
      .then((response) => {
        if (!active) return
        setReport(response)
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
  const hasReport = report !== null
  return {
    report,
    initialLoading: loading && !hasReport,
    refreshing: loading && hasReport,
    error,
    reload,
  }
}
