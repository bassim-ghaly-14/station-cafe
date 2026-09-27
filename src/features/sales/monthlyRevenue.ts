/**
 * The Sales page's monthly comparison configuration — Cafe vs Wash.
 *
 * This file is the ONLY place that knows the series mean something. It maps the
 * backend's `YYYY-MM` rows onto the generic chart model, chooses the localized
 * labels, and picks the two Station tokens the bars are drawn in. The chart
 * itself receives plain data and plain configuration.
 *
 * No aggregation happens here either: the backend already grouped the invoices
 * by calendar month, and this file only renames and labels what it received.
 */
import type {
  MonthlyComparisonDatum,
  MonthlySeriesConfig,
} from '@/components/charts/monthlyComparison'
import { chartBarColor } from '@/lib/chart-colors'
import { formatMonthKey } from '@/lib/date'
import { formatMinorMoney } from '@/lib/money'
import type { SalesMonthRow } from '@/services/salesApi'

/** The series keys this usage plots, in the order the bars and legend appear. */
export const CAFE_KEY = 'cafe'
export const WASH_KEY = 'wash'

/** Localized strings the configuration needs, resolved by the caller. */
export type MonthlyRevenueLabels = {
  cafe: string
  wash: string
}

/**
 * Series colors are the CENTRALIZED chart bar roles (`lib/chart-colors.ts`) —
 * the same roles the reports donuts use for these two business lines, so the two
 * charts cannot disagree about what the first or second series means, and a
 * developer can change either from Dev Settings.
 */
export function monthlyRevenueSeries(labels: MonthlyRevenueLabels): MonthlySeriesConfig[] {
  return [
    { key: CAFE_KEY, label: labels.cafe, color: chartBarColor('secondary'), format: formatCompact },
    { key: WASH_KEY, label: labels.wash, color: chartBarColor('primary'), format: formatCompact },
  ]
}

/** Compact money for axes, tooltips and the legend, like the other charts. */
export function formatCompact(value: number): string {
  return formatMinorMoney(value, { compact: true })
}

/**
 * Backend rows → chart categories, ascending by the stable `YYYY-MM` key.
 *
 * Two labels per month on purpose: the axis gets the short month name so twelve
 * of them fit, and the tooltip/export get the full "سبتمبر 2026" so a series that
 * crosses a year boundary is never ambiguous.
 */
export function toMonthlyRevenueData(
  rows: readonly SalesMonthRow[],
  locale: string,
): MonthlyComparisonDatum[] {
  return [...rows]
    .sort((left, right) => left.month.localeCompare(right.month))
    .map((row) => ({
      month: row.month,
      label: formatMonthKey(row.month, locale, { short: true }),
      fullLabel: formatMonthKey(row.month, locale),
      [CAFE_KEY]: row.cafe_sales,
      [WASH_KEY]: row.wash_sales,
    }))
}
