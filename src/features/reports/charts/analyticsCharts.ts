import { useEffect, useState } from 'react'
import type { LucideIcon } from '@/components/ui/icon'
import { BarChart3, Droplets, Wallet } from '@/components/ui/icon'
import { opsApi, type AnalyticsCharts } from '@/services/opsApi'

export type AnalyticsCategory = { id: string; label: string; value: number; color: string }
export type AnalyticsChart = {
  id: string
  title: string
  description: string
  total: number
  hasData: boolean
  categories: AnalyticsCategory[]
  icon: LucideIcon
  exportFilename: string
}
export type AnalyticsReportState = {
  data: AnalyticsChart[]
  loading: boolean
  error: string | null
  reload: () => void
}

/**
 * Presentation-only configuration for the three Station analytics charts:
 * titles, icons, export file names. Every *value* rendered by the charts comes
 * from the `analytics_charts` report over persisted data — nothing here is a
 * statistic, so these constants are UI configuration, not chart data.
 */
export const CHARTS_PRESENTATION: Record<
  string,
  Omit<AnalyticsChart, 'categories' | 'total' | 'hasData'>
> = {
  'laundry-cafe': {
    id: 'laundry-cafe',
    title: 'المغسلة مقابل الكافيه',
    description: 'توزيع الإيرادات حسب النشاط',
    icon: Droplets,
    exportFilename: 'station-laundry-cafe',
  },
  'cash-visa': {
    id: 'cash-visa',
    title: 'كاش مقابل فيزا',
    description: 'توزيع المبيعات حسب طريقة الدفع',
    icon: Wallet,
    exportFilename: 'station-cash-visa',
  },
  'sales-expenses': {
    id: 'sales-expenses',
    title: 'المبيعات مقابل المصروفات',
    description: 'مقارنة المبيعات بالمصروفات التشغيلية',
    icon: BarChart3,
    exportFilename: 'station-sales-expenses',
  },
}

/**
 * Category labels and segment colors, keyed by the ids the report returns.
 * Colors are existing Station semantic tokens (never a raw palette), so light
 * and dark mode stay driven by the centralized theme.
 */
export const CATEGORY_PRESENTATION: Record<string, { label: string; color: string }> = {
  laundry: { label: 'المغسلة', color: 'var(--primary)' },
  cafe: { label: 'كافيه', color: 'var(--info)' },
  cash: { label: 'كاش', color: 'var(--success)' },
  visa: { label: 'فيزا', color: 'var(--info)' },
  sales: { label: 'المبيعات', color: 'var(--success)' },
  expenses: { label: 'المصروفات', color: 'var(--destructive)' },
}

/**
 * Pure DTO → view-model mapping. No aggregation happens here: `value`, `total`
 * and `has_data` are computed by the backend report from SQLite records.
 */
export function toAnalyticsCharts(response: AnalyticsCharts): AnalyticsChart[] {
  return response.charts.flatMap((chart) => {
    const presentation = CHARTS_PRESENTATION[chart.id]
    if (!presentation) return []
    const categories = chart.categories.map((category) => ({
      id: category.id,
      value: category.value,
      ...(CATEGORY_PRESENTATION[category.id] ?? { label: category.id, color: 'var(--info)' }),
    }))
    return [{ ...presentation, categories, total: chart.total, hasData: chart.has_data }]
  })
}

/** Loads the persisted analytics report for the selected business-date range. */
export function useAnalyticsCharts(from = '', to = ''): AnalyticsReportState {
  const [state, setState] = useState<AnalyticsReportState>({
    data: [],
    loading: true,
    error: null,
    reload: () => undefined,
  })
  const [requestVersion, setRequestVersion] = useState(0)
  useEffect(() => {
    let active = true
    setState((previous) => ({ ...previous, loading: true, error: null }))
    opsApi
      .analyticsCharts(from, to)
      .then((response) => {
        if (!active) return
        setState({
          data: toAnalyticsCharts(response),
          loading: false,
          error: null,
          reload: state.reload,
        })
      })
      .catch((error: unknown) => {
        if (!active) return
        setState({
          data: [],
          loading: false,
          error: error instanceof Error ? error.message : 'internal_error',
          reload: state.reload,
        })
      })
    return () => {
      active = false
    }
    // `state.reload` is a stable closure over `setRequestVersion`; re-running on
    // it would loop, so only the range and the manual reload counter are inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, requestVersion])
  return { ...state, reload: () => setRequestVersion((version) => version + 1) }
}
