/**
 * The pure model behind a monthly comparison chart.
 *
 * Everything in this file is arithmetic and typing — no React, no chart library,
 * no i18n, no money rules. It exists so the two questions a monthly comparison
 * has to answer can be tested without rendering anything:
 *
 *  1. how a row of series values is turned into a category and a bar value; and
 *  2. how the latest month compares with the one before it.
 *
 * The component that draws the bars receives a `MonthlyComparisonDatum`; whoever
 * owns the data decides what the series keys mean. This file has no idea whether
 * it is looking at Cafe vs Wash, Cash vs Card, or this year vs last year.
 */

/** One comparable series: a key into the datum, a label, and a themed color. */
export type MonthlySeriesConfig = {
  /** Property name on {@link MonthlyComparisonDatum}. */
  key: string
  label: string
  /**
   * A CENTRALIZED chart bar role (`chartBarColor(...)`, i.e. `var(--chart-bar-*)`),
   * never a raw palette value and never a per-chart brand colour — so a bar in
   * any chart of the application is themed and Dev-Settings controlled alike.
   */
  color: string
  /** Optional per-series value formatting for the tooltip and the legend. */
  format?: (value: number) => string
}

/**
 * One month of the comparison.
 *
 * `month` is the stable `YYYY-MM` identity of the month; `label` is what the
 * axis shows, and `fullLabel` what the tooltip shows (the same month, unabbreviated
 * and with its year). The index signature carries the series values.
 */
export type MonthlyComparisonDatum = {
  month: string
  label: string
  fullLabel?: string
  [seriesKey: string]: string | number | undefined
}

/** How the latest month moved against the one before it. */
export type MonthOverMonthTrend = 'up' | 'down' | 'flat' | 'unavailable'

export type MonthOverMonth = {
  trend: MonthOverMonthTrend
  /** Percentage change, or `null` when it cannot be computed. */
  percent: number | null
  currentTotal: number
  /** `null` when there is no previous month to compare against. */
  previousTotal: number | null
}

/** Read one series value off a datum as a number, treating a gap as zero. */
export function seriesValue(datum: MonthlyComparisonDatum, key: string): number {
  const raw = datum[key]
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? value : 0
}

/** The sum of every configured series for one month — the month's total. */
export function monthTotal(
  datum: MonthlyComparisonDatum,
  series: readonly MonthlySeriesConfig[],
): number {
  return series.reduce((total, item) => total + seriesValue(datum, item.key), 0)
}

/**
 * The LEAST a figure has to declare for the shared tooltip helpers to name it
 * and format its value: a key it is stored under, a localized name, and an
 * optional formatter of its own.
 *
 * It is deliberately structural rather than one of the concrete series types.
 * The daily chart's figures include things that are NOT bars — an invoice count
 * stated beside the bar that is — and copying these two lookups for them would
 * be the duplication this file exists to prevent. Anything that can state a name
 * and a value passes.
 */
export type TooltipFigure = {
  key: string
  label: string
  format?: (value: number) => string
}

/**
 * The Arabic NAME of one series — the entity a tooltip row is about: a sales
 * section, an expense category.
 *
 * The series `label` is already the Arabic domain name the chart is configured
 * with (`catalog.CAFE`, or `expense_categories.name_ar` from the backend), so
 * resolving it is a lookup and nothing more. What is deliberately NOT done here:
 * no English, no `MAINTENANCE صيانة` pairing and no key fallback. An unknown
 * series has no name to state, and the internal key is never promoted to one.
 */
export function seriesTooltipName(series: readonly TooltipFigure[], key: string): string {
  return series.find((entry) => entry.key === key)?.label ?? ''
}

/**
 * The tooltip VALUE of one series: the figure, formatted by the series' own
 * formatter when it has one, otherwise by the chart's.
 *
 * The name is NOT part of this: the tooltip row prints the entity name itself,
 * so a value that also carried the name would show it twice.
 */
export function seriesTooltipValue(
  series: readonly TooltipFigure[],
  key: string,
  value: number,
  formatValue: (value: number) => string,
): string {
  const item = series.find((entry) => entry.key === key)
  if (!item) return formatValue(value)
  return item.format ? item.format(value) : formatValue(value)
}

/**
 * Month-over-month movement of the TOTAL of all series.
 *
 * The comparison is total against total: comparing one series against another
 * (Cafe % against Wash %) would answer a different question, and comparing a
 * single series would ignore the rest of the chart.
 *
 * The three degenerate cases are explicit rather than numeric accidents:
 *  - one month only  → `previousTotal === null`, nothing to compare against;
 *  - previous month at zero → `percent === null` (never `Infinity`, never `NaN`),
 *    because "growth from nothing" has no percentage;
 *  - equal totals → `flat`, zero percent.
 */
export function monthOverMonth(
  data: readonly MonthlyComparisonDatum[],
  series: readonly MonthlySeriesConfig[],
): MonthOverMonth {
  if (data.length === 0) {
    return { trend: 'unavailable', percent: null, currentTotal: 0, previousTotal: null }
  }
  const currentTotal = monthTotal(data.at(-1) as MonthlyComparisonDatum, series)
  if (data.length < 2) {
    return { trend: 'unavailable', percent: null, currentTotal, previousTotal: null }
  }
  const previousTotal = monthTotal(data.at(-2) as MonthlyComparisonDatum, series)
  if (previousTotal === 0) {
    return { trend: 'unavailable', percent: null, currentTotal, previousTotal }
  }
  const percent = ((currentTotal - previousTotal) / previousTotal) * 100
  const trend: MonthOverMonthTrend = trendFor(percent)
  return { trend, percent, currentTotal, previousTotal }
}

/** A positive change grew, a negative one shrank, and no change at all is flat. */
function trendFor(percent: number): MonthOverMonthTrend {
  if (percent > 0) return 'up'
  if (percent < 0) return 'down'
  return 'flat'
}

const percentFormatters = new Map<number, Intl.NumberFormat>()

/**
 * One decimal, Latin digits — formatted exactly like the money formatters do.
 *
 * The Arabic locale is deliberately NOT passed to `Intl`: it wraps a negative
 * number in a left-to-right mark, which would leak an invisible control
 * character into a badge that already carries an arrow and a localized label.
 */
export function formatPercent(value: number, digits = 1): string {
  let created = percentFormatters.get(digits)
  if (!created) {
    created = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
    percentFormatters.set(digits, created)
  }
  return created.format(value)
}
