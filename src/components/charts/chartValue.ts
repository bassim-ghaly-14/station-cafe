/**
 * chartValue — the SEMANTIC value formatter every Station chart formats through.
 *
 * THE PROBLEM IT EXISTS TO SOLVE
 * -----------------------------
 * A chart receives numbers, and a formatter that treats "a number" as "money"
 * is what produced a tooltip reading `عدد الفواتير 0.04 ج.م`: an invoice count of
 * 2 piastres, because the one formatter the chart owned was the money one. The
 * fix is not a special case on the label — a chart that has to recognise
 * `عدد الفواتير` by its spelling has already lost the plot. The fix is that the
 * value's MEANING travels with the value: a series declares `type: 'count'`, and
 * this module is the only place that knows what a count looks like.
 *
 * So the contract is deliberately small and total:
 *  - `currency` — the shared Station money formatter (`lib/money`), which also
 *    means the app's decimal places, grouping, currency label and currency
 *    position come from Dev Settings and not from a chart. Station stores money
 *    in MINOR units, so a currency value is a stored amount and the formatter
 *    converts it exactly as `MoneyDisplay` does.
 *  - `count`    — a whole number of things, grouped, and NEVER a currency label
 *    and never a decimal (`42`, not `42.00` and not `0.42 ج.م`).
 *  - `percent`  — a percentage, with the shared `formatPercent` and a `%` sign
 *    and no currency label.
 *  - `number`   — anything else: grouped, decimals allowed, no unit at all.
 *
 * There is no `formatEverythingAsMoney` and no fallback to currency: a type a
 * caller did not declare formats as a plain number, so the wrong answer is
 * always the harmless one.
 */
import { formatMinorMoney } from '@/lib/money'
import { getMoneySettings } from '@/lib/formatting'
import { formatPercent } from './monthlyComparison'

/** What a chart value MEANS — the only thing the formatter is allowed to branch on. */
export type ChartValueType = 'currency' | 'count' | 'percent' | 'number'

/**
 * How a value is rendered for a given surface: exactly (a tooltip, an export),
 * abbreviated (an axis, where the scale is the message), or `auto` (a bar label,
 * which is exact until the figure gets long enough to crowd its own bar).
 */
export type ChartValueStyle = 'exact' | 'compact' | 'auto'

const numberFormatters = new Map<string, Intl.NumberFormat>()

function numberFormatter(fractionDigits: number, grouping: boolean): Intl.NumberFormat {
  const key = `${fractionDigits}|${grouping}`
  let created = numberFormatters.get(key)
  if (!created) {
    created = new Intl.NumberFormat('en-US', {
      useGrouping: grouping,
      minimumFractionDigits: 0,
      maximumFractionDigits: fractionDigits,
    })
    numberFormatters.set(key, created)
  }
  return created
}

/** Test seam: drop cached Intl instances. */
export function __clearChartValueFormatterCache(): void {
  numberFormatters.clear()
}

function money(value: number, style: ChartValueStyle): string {
  if (style === 'compact') return formatMinorMoney(value, { compact: true })
  if (style === 'auto') return formatMinorMoney(value, { variant: 'auto' })
  return formatMinorMoney(value)
}

/**
 * Format one value AS WHAT IT IS.
 *
 * A value that is not a number has no reading, and says so with the project's
 * em dash rather than with a `0` that would be a measurement nobody made.
 */
export function formatChartValue(
  value: number | null | undefined,
  type: ChartValueType = 'number',
  style: ChartValueStyle = 'exact',
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (type === 'currency') return money(value, style)
  if (type === 'percent') return `${formatPercent(value)}%`
  const { useThousandsSeparator } = getMoneySettings()
  // A COUNT is a whole number of things: it is grouped like the money figures
  // around it, and it never carries a fraction or a currency label.
  const fractionDigits = chartFractionDigits(type, style)
  return numberFormatter(fractionDigits, useThousandsSeparator).format(value)
}

/** Counts are whole; every other type follows the requested rounding style. */
function chartFractionDigits(type: ChartValueType, style: ChartValueStyle): number {
  if (type === 'count') return 0
  return style === 'exact' ? 2 : 0
}

/** The workbook column format an exported column of this type wears. */
export type ChartValueColumnFormat = 'currency' | 'integer' | 'percent' | 'text'

/** How a value of this type is written into a Station workbook column. */
export function chartValueColumnFormat(type: ChartValueType = 'number'): ChartValueColumnFormat {
  if (type === 'currency') return 'currency'
  if (type === 'percent') return 'percent'
  if (type === 'count') return 'integer'
  return 'text'
}

/**
 * Whether a value of this type is an AMOUNT, and therefore the one thing a
 * stored minor-unit figure has to be converted from before it is written.
 *
 * A count is not money, so it is never divided by 100 on the way out — which is
 * exactly how a 42-invoice day used to reach the workbook as `0.42`.
 */
export function isMoneyValue(type: ChartValueType = 'number'): boolean {
  return type === 'currency'
}
