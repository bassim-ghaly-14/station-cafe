/**
 * The Expenses page's daily-chart configuration, tested as the DATA it hands the
 * shared chart.
 *
 * These assertions guard the one thing that must never quietly change here: the
 * bar height is the day's spend exactly as `expenses_overview` computed it. The
 * page does no aggregation of its own, and it certainly does not invent a
 * per-day category split the backend never returns.
 */
import { describe, expect, it } from 'vitest'
import { dailyBarFill } from '@/components/charts/dailyBar'
import { formatDate } from '@/lib/date'
import { chartBarColor } from '@/lib/chart-colors'
import type { ExpenseOverview } from '@/services/opsApi'
import {
  AVERAGE_EXPENSE_KEY,
  EXPENSES_COUNT_KEY,
  SPEND_KEY,
  expensesBarColor,
  expensesDailyFigures,
  toExpensesDailyData,
} from './ExpensesDailyChart'

const DAYS: ExpenseOverview['days'] = [
  { day_date: '2026-09-10', count: 3, amount: 9_000 },
  { day_date: '2026-09-09', count: 1, amount: 2_500 },
]

/** The one bar the Expenses chart plots, declared exactly as the page declares it. */
const { series } = expensesDailyFigures({
  total: 'إجمالي المصروفات',
  count: 'عدد المصروفات',
  average: 'متوسط المصروف',
})

describe('the expense days the chart plots', () => {
  it('is DAILY: one entry per day, in date order, with no aggregation', () => {
    const data = toExpensesDailyData(DAYS)

    expect(data).toHaveLength(2)
    expect(data[0]?.[SPEND_KEY]).toBe(2_500)
    expect(data[1]?.[SPEND_KEY]).toBe(9_000)
    // The sum is never folded into a single bar: a daily chart keeps its days.
    expect(data[0]?.[SPEND_KEY]).not.toBe(11_500)
  })

  it('labels every day through the central Arabic date formatter', () => {
    const data = toExpensesDailyData(DAYS)

    expect(data[0]?.label).toBe(formatDate('2026-09-09'))
    expect(data[1]?.label).toBe(formatDate('2026-09-10'))
    for (const day of data) {
      expect(day.label).not.toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('plots only the day total — it never invents a per-day category split', () => {
    // `expenses_overview` returns a per-day total and a per-category total for the
    // WHOLE period; there is no day × category cell to read. Producing one here
    // would fabricate a breakdown the database never recorded, so the datum
    // carries the figures the backend really returned for that day — the total
    // and its count — and the day's own average of them, the colour that day's
    // own count asks for, and nothing else.
    const [first] = toExpensesDailyData(DAYS)

    expect(Object.keys(first ?? {}).sort()).toEqual(
      [SPEND_KEY, EXPENSES_COUNT_KEY, AVERAGE_EXPENSE_KEY, 'color', 'fullLabel', 'label'].sort(),
    )
  })

  it('wears the companion colour ONLY on a day that recorded 2+ expenses', () => {
    // The distinction is `count === 1` against `count > 1`, read from the real
    // per-day COUNT(*) the backend already returns — never from the total, and
    // never `total > 0`, which would paint every spending day the same.
    const data = toExpensesDailyData([
      { day_date: '2026-09-09', count: 1, amount: 2_500 },
      { day_date: '2026-09-10', count: 2, amount: 9_000 },
      { day_date: '2026-09-11', count: 5, amount: 1_000 },
    ])

    // One expense: the datum says NOTHING, so the bar keeps the series colour.
    expect(data[0]?.color).toBeUndefined()
    expect(dailyBarFill(data[0]!, series[0]!)).toBe(chartBarColor('expenses'))
    // Two and five: the companion role of the same centralized system.
    expect(data[1]?.color).toBe(chartBarColor('expensesMultiple'))
    expect(data[2]?.color).toBe(chartBarColor('expensesMultiple'))
    expect(dailyBarFill(data[1]!, series[0]!)).toBe(chartBarColor('expensesMultiple'))
    expect(dailyBarFill(data[2]!, series[0]!)).toBe(chartBarColor('expensesMultiple'))
  })

  it('decides the colour from the COUNT alone, and never from the amount', () => {
    // A huge single expense is still ONE expense, and an empty day is not a
    // "multiple" day: neither is a fabricated reading.
    expect(expensesBarColor(1)).toBeUndefined()
    expect(expensesBarColor(0)).toBeUndefined()
    expect(expensesBarColor(undefined)).toBeUndefined()
    expect(expensesBarColor(2)).toBe(chartBarColor('expensesMultiple'))
    expect(expensesBarColor(5)).toBe(chartBarColor('expensesMultiple'))
    expect(expensesBarColor(2)).toMatch(/^var\(--chart-bar-/)
  })

  it("states the day's average as its own spend over its own count", () => {
    const data = toExpensesDailyData(DAYS)

    // 2,500 / 1 and 9,000 / 3 — piastres, as stored. A day with no recorded
    // expense has no average at all, so the key is absent rather than zero.
    expect(data[0]?.[AVERAGE_EXPENSE_KEY]).toBe(2_500)
    expect(data[1]?.[AVERAGE_EXPENSE_KEY]).toBe(3_000)
    const [empty] = toExpensesDailyData([{ day_date: '2026-09-11', count: 0, amount: 0 }])
    expect(empty?.[AVERAGE_EXPENSE_KEY]).toBeUndefined()
  })
})

describe('the figures the expenses chart declares', () => {
  const { metrics } = expensesDailyFigures({
    total: 'إجمالي المصروفات',
    count: 'عدد المصروفات',
    average: 'متوسط المصروف',
  })

  it('plots the day total as the ONE bar, and states the rest as metrics', () => {
    expect(series.map((s) => s.key)).toEqual([SPEND_KEY])
    expect(metrics.map((m) => m.key)).toEqual([EXPENSES_COUNT_KEY, AVERAGE_EXPENSE_KEY])
  })

  it('declares what every value MEANS, so a count can never print as money', () => {
    // THE regression: three recorded expenses printed as `0.03 ج.م`.
    expect(series[0]?.type).toBe('currency')
    expect(metrics[0]?.type).toBe('count')
    expect(metrics[1]?.type).toBe('currency')
  })

  it('takes its bar colour from the centralized chart bar roles', () => {
    expect(series[0]?.color).toBe(chartBarColor('expenses'))
    expect(series[0]?.color).toMatch(/^var\(--chart-bar-/)
  })

  it("states the day's own count, so the bar colour is always explained", () => {
    // The colour difference is legible because the tooltip prints the number it
    // came from: `عدد المصروفات: 3` under a bar that is painted differently. No
    // extra sentence is needed, and none is invented.
    expect(metrics[0]?.key).toBe(EXPENSES_COUNT_KEY)
    expect(metrics[0]?.type).toBe('count')
  })
})
