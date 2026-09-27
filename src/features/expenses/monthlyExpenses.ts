/**
 * The Expenses page's monthly comparison configuration — spend by category.
 *
 * This file is the ONLY place that knows the series mean something. It maps the
 * backend's `YYYY-MM` × category rows onto the generic chart model, chooses the
 * localized labels, and picks the Station tokens the bars are drawn in. The
 * chart itself receives plain data and plain configuration.
 *
 * It is the direct counterpart of `features/sales/monthlyRevenue.ts`: same
 * generic chart, same mapping shape, different business meaning. The series are
 * NOT a fixed list — they are whatever categories the real `expense_categories`
 * domain actually has spend for, so a new category appears without a frontend
 * change and a retired one disappears on its own.
 *
 * No aggregation happens here: the backend already grouped the expenses by
 * calendar month and category, and this file only reshapes and labels what it
 * received.
 */
import type {
  MonthlyComparisonDatum,
  MonthlySeriesConfig,
} from '@/components/charts/monthlyComparison'
import { chartBarColorAt } from '@/lib/chart-colors'
import { formatMonthKey } from '@/lib/date'
import { formatMinorMoney } from '@/lib/money'
import type { ExpenseMonthlyReport } from '@/services/opsApi'

/**
 * The CENTRALIZED chart bar roles the bars cycle through, in the SAME order the
 * expenses category ranking already uses (`ExpensesCategoryCard`), so a category
 * cannot be one colour in the ranking and another in this chart.
 *
 * The cycle is the established fallback for "more categories than colours": the
 * role repeats rather than a colour being invented. Nothing here is a literal —
 * light and dark stay the theme's decision, and every value is editable in
 * Dev Settings.
 */
export { CHART_BAR_TOKENS as MONTHLY_EXPENSE_TONES } from '@/lib/chart-colors'

/** Compact money for axes, tooltips and the legend, like the other charts. */
export function formatCompact(value: number): string {
  return formatMinorMoney(value, { compact: true })
}

/**
 * The report's categories → chart series, in the order the backend chose
 * (largest total first, then the stable code).
 *
 * The KEY is the domain category code, never the Arabic label: a series
 * identity must survive a rename and a translation, and a localized string
 * must never be a grouping key.
 */
export function monthlyExpenseSeries(
  report: Pick<ExpenseMonthlyReport, 'categories'>,
): MonthlySeriesConfig[] {
  return report.categories.map((category, index) => ({
    key: category.code,
    label: category.name_ar,
    color: chartBarColorAt(index),
    format: formatCompact,
  }))
}

/**
 * Backend rows → chart categories, ascending by the stable `YYYY-MM` key.
 *
 * Two labels per month on purpose: the axis gets the short month name so twelve
 * of them fit, and the tooltip/export get the full "سبتمبر 2026" so a series that
 * crosses a year boundary is never ambiguous.
 *
 * A month with no spend is KEPT as a zero-valued category rather than dropped,
 * matching the sales monthly chart: a quiet month is a fact, not a gap. Every
 * configured series is written onto every month (missing as `0`), so a category
 * that simply was not used in one month reads as zero and not as a hole.
 */
export function toMonthlyExpenseData(
  report: Pick<ExpenseMonthlyReport, 'months'>,
  series: readonly MonthlySeriesConfig[],
  locale: string,
): MonthlyComparisonDatum[] {
  const months = [...new Set(report.months.map((row) => row.month))].sort((left, right) =>
    left.localeCompare(right),
  )

  // One index of the rows per month, built once so the cost stays linear in the
  // response and is never repeated per series.
  const byMonth = new Map<string, Map<string, number>>()
  for (const row of report.months) {
    // The category-less row is the marker that keeps a spend-free month in the
    // series; it carries no value for any category.
    if (!row.category) continue
    const bucket = byMonth.get(row.month) ?? new Map<string, number>()
    // Two rows for the same month and category would be a backend bug; summing
    // keeps the total truthful either way instead of letting one overwrite the
    // other.
    bucket.set(row.category, (bucket.get(row.category) ?? 0) + row.amount)
    byMonth.set(row.month, bucket)
  }

  return months.map((month) => {
    const bucket = byMonth.get(month)
    const datum: MonthlyComparisonDatum = {
      month,
      label: formatMonthKey(month, locale, { short: true }),
      fullLabel: formatMonthKey(month, locale),
    }
    for (const item of series) {
      datum[item.key] = bucket?.get(item.key) ?? 0
    }
    return datum
  })
}
