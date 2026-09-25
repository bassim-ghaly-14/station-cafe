import { useEffect, useState } from 'react'
import type { LucideIcon } from '@/components/ui/icon'
import { BarChart3, Droplets, Wallet } from '@/components/ui/icon'
import { opsApi, type AnalyticsCharts } from '@/services/opsApi'

export type AnalyticsCategory = {
  id: string
  /** Translation key of the category's Arabic label — never display text. */
  labelKey: string
  value: number
  color: string
}
export type AnalyticsChart = {
  id: string
  titleKey: string
  descriptionKey: string
  total: number
  hasData: boolean
  categories: AnalyticsCategory[]
  icon: LucideIcon
  exportFilename: string
}
export type AnalyticsReportState = {
  data: AnalyticsChart[]
  loading: boolean
  /** True only while the very first report is in flight (nothing to show yet). */
  initialLoading: boolean
  /** True while a re-fetch runs over an already-populated report. */
  refreshing: boolean
  error: string | null
  reload: () => void
}

/**
 * Presentation-only configuration for the three Station analytics charts:
 * which translation keys hold their titles, their icon, and their export file
 * names. Every *value* rendered by the charts comes from the `analytics_charts`
 * report over persisted data — nothing here is a statistic, so these entries
 * are UI configuration, not chart data. Titles and descriptions are referenced
 * by key so the copy lives in the translation catalogue like every other
 * user-visible string.
 */
export const CHARTS_PRESENTATION: Record<
  string,
  Omit<AnalyticsChart, 'categories' | 'total' | 'hasData' | 'title' | 'description'>
> = {
  'laundry-cafe': {
    id: 'laundry-cafe',
    titleKey: 'laundryCafeTitle',
    descriptionKey: 'laundryCafeDescription',
    icon: Droplets,
    exportFilename: 'station-laundry-cafe',
  },
  'cash-visa': {
    id: 'cash-visa',
    titleKey: 'cashVisaTitle',
    descriptionKey: 'cashVisaDescription',
    icon: Wallet,
    exportFilename: 'station-cash-visa',
  },
  'sales-expenses': {
    id: 'sales-expenses',
    titleKey: 'salesExpensesTitle',
    descriptionKey: 'salesExpensesDescription',
    icon: BarChart3,
    exportFilename: 'station-sales-expenses',
  },
}

/**
 * Category labels and segment colors, keyed by the ids the report returns.
 * Colors are existing Station semantic tokens (never a raw palette), so light
 * and dark mode stay driven by the centralized theme.
 */
export const CATEGORY_PRESENTATION: Record<string, { labelKey: string; color: string }> = {
  laundry: { labelKey: 'laundry', color: 'var(--primary)' },
  cafe: { labelKey: 'cafe', color: 'var(--info)' },
  cash: { labelKey: 'cash', color: 'var(--success)' },
  visa: { labelKey: 'visa', color: 'var(--info)' },
  sales: { labelKey: 'sales', color: 'var(--success)' },
  expenses: { labelKey: 'expenses', color: 'var(--destructive)' },
}

/** Translation-key prefix for category labels inside the reports catalogue. */
export const CATEGORY_LABEL_PREFIX = 'reports.charts.categories.'

/**
 * Pure DTO → view-model mapping. No aggregation happens here: `value`, `total`
 * and `has_data` are computed by the backend report from SQLite records.
 * Presentation labels are carried as translation KEYS, never resolved here —
 * a chart model has no business owning display strings.
 */
export function toAnalyticsCharts(response: AnalyticsCharts): AnalyticsChart[] {
  return response.charts.flatMap((chart) => {
    const presentation = CHARTS_PRESENTATION[chart.id]
    if (!presentation) return []
    const categories = chart.categories.map((category) => ({
      id: category.id,
      value: category.value,
      labelKey: CATEGORY_PRESENTATION[category.id]?.labelKey ?? category.id,
      color: CATEGORY_PRESENTATION[category.id]?.color ?? 'var(--info)',
    }))
    return [
      { ...presentation, categories, total: chart.total, hasData: chart.has_data },
    ] satisfies AnalyticsChart[]
  })
}

/** Loads the persisted analytics report for the selected business-date range. */
export function useAnalyticsCharts(from = '', to = ''): AnalyticsReportState {
  const [data, setData] = useState<AnalyticsChart[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [requestVersion, setRequestVersion] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    opsApi
      .analyticsCharts(from, to)
      .then((response) => {
        if (!active) return
        setData(toAnalyticsCharts(response))
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(cause instanceof Error ? cause.message : 'internal_error')
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [from, to, requestVersion])

  // A chart grid that blanks out and rebuilds on every range change reads as a
  // flash, not as progress. The report keeps the previous charts on screen and
  // marks itself busy instead, so a re-fetch is a quiet state transition.
  const hasReport = data.length > 0 && error === null
  return {
    data,
    loading,
    initialLoading: loading && !hasReport,
    refreshing: loading && hasReport,
    error,
    reload: () => setRequestVersion((version) => version + 1),
  }
}
