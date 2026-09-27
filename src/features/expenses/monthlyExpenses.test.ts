/**
 * The Expenses usage of the generic chart: the report → chart mapping, the
 * dynamic category series, and the localized labels.
 *
 * No aggregation is tested here — the backend owns that, and the Rust tests prove
 * it; this file only proves the monthly rows arrive at the chart in the right
 * shape, in the right order, with the right series, and that the indicator reads
 * the TOTAL of the spend rather than any single category.
 */
import { describe, expect, it } from 'vitest'
import { monthOverMonth, monthTotal } from '@/components/charts/monthlyComparison'
import { formatMonthKey } from '@/lib/date'
import type { ExpenseMonthlyReport, ExpenseMonthRow } from '@/services/opsApi'
import {
  MONTHLY_EXPENSE_TONES,
  monthlyExpenseSeries,
  toMonthlyExpenseData,
} from './monthlyExpenses'

function cell(month: string, category: string, amount: number, name = category): ExpenseMonthRow {
  return { month, category, category_name: name, count: 1, amount }
}

/** A report carrying the categories the real domain would have spend for. */
function report(months: ExpenseMonthRow[], categories?: ExpenseMonthlyReport['categories']) {
  return {
    months,
    categories: categories ?? [
      { code: 'SALARY', name_ar: 'رواتب', total: 20_000 },
      { code: 'SUPPLIES', name_ar: 'مشتريات', total: 10_000 },
    ],
  }
}

describe('monthlyExpenseSeries', () => {
  it('turns the real domain categories into series keyed by their stable code', () => {
    const series = monthlyExpenseSeries(
      report(
        [],
        [
          { code: 'SALARY', name_ar: 'رواتب', total: 20_000 },
          { code: 'SUPPLIES', name_ar: 'مشتريات', total: 10_000 },
        ],
      ),
    )

    // The key is the domain code, never the Arabic label.
    expect(series.map((item) => item.key)).toEqual(['SALARY', 'SUPPLIES'])
    expect(series.map((item) => item.label)).toEqual(['رواتب', 'مشتريات'])
  })

  it('draws the bars with the centralized chart roles, never raw colours', () => {
    const series = monthlyExpenseSeries(report([]))

    expect(series.map((item) => item.color)).toEqual([
      'var(--chart-bar-primary)',
      'var(--chart-bar-secondary)',
    ])
    // A hex value would bypass the theme and break dark mode.
    expect(series.every((item) => item.color.startsWith('var(--'))).toBe(true)
  })

  it('cycles the established role sequence when there are more categories than colours', () => {
    const series = monthlyExpenseSeries(
      report(
        [],
        Array.from({ length: 6 }, (_, index) => ({
          code: `C${index}`,
          name_ar: `فئة ${index}`,
          total: 1_000 - index,
        })),
      ),
    )

    expect(series).toHaveLength(6)
    // The fallback is the documented cycle, not an invented colour: the sixth
    // category reuses the first role.
    expect(series.map((item) => item.color)).toEqual([
      'var(--chart-bar-primary)',
      'var(--chart-bar-secondary)',
      'var(--chart-bar-tertiary)',
      'var(--chart-bar-quaternary)',
      'var(--chart-bar-primary)',
      'var(--chart-bar-secondary)',
    ])
    expect(series.every((item) => MONTHLY_EXPENSE_TONES.includes(item.color as never))).toBe(true)
  })

  it('plots no series at all for a window with no spend', () => {
    expect(monthlyExpenseSeries({ categories: [] })).toEqual([])
  })
})

describe('toMonthlyExpenseData', () => {
  it('carries each month broken down by expense category', () => {
    const series = monthlyExpenseSeries(report([]))
    const [january] = toMonthlyExpenseData(
      report([cell('2026-01', 'SALARY', 100, 'رواتب'), cell('2026-01', 'SUPPLIES', 50, 'مشتريات')]),
      series,
      'ar-EG',
    )

    expect(january.month).toBe('2026-01')
    expect(january.SALARY).toBe(100)
    expect(january.SUPPLIES).toBe(50)
    // The total is every category of the month, which is what the indicator reads.
    expect(monthTotal(january, series)).toBe(150)
  })

  it('keeps the same month of two different years as two categories', () => {
    const series = monthlyExpenseSeries(report([]))
    const data = toMonthlyExpenseData(
      report([cell('2026-01', 'SALARY', 70_000), cell('2025-01', 'SALARY', 30_000)]),
      series,
      'ar-EG',
    )

    expect(data.map((item) => item.month)).toEqual(['2025-01', '2026-01'])
    // Distinct full labels, so a series crossing a year is never ambiguous.
    expect(data[0].fullLabel).not.toBe(data[1].fullLabel)
    expect(data[0].fullLabel).toBe(formatMonthKey('2025-01', 'ar-EG'))
  })

  it('keeps a month with no spending as a zero-valued category', () => {
    const series = monthlyExpenseSeries(report([]))
    const data = toMonthlyExpenseData(
      // The backend's month-preserving marker row: a month, and no category.
      report([
        { month: '2026-01', category: '', category_name: '', count: 0, amount: 0 },
        cell('2026-02', 'SALARY', 10_000),
        cell('2026-02', 'SUPPLIES', 5_000),
      ]),
      series,
      'ar-EG',
    )

    expect(data).toHaveLength(2)
    // A quiet month is a fact, not a gap: it is present and it is zero.
    expect(data[0].month).toBe('2026-01')
    expect(data[0].SALARY).toBe(0)
    expect(data[0].SUPPLIES).toBe(0)
    expect(monthTotal(data[1], series)).toBe(15_000)
  })

  it('fills a category that was unused in one month with zero, not a hole', () => {
    const series = monthlyExpenseSeries(report([]))
    const [january] = toMonthlyExpenseData(
      report([cell('2026-01', 'SALARY', 100)]),
      series,
      'ar-EG',
    )

    expect(january.SALARY).toBe(100)
    expect(january.SUPPLIES).toBe(0)
  })

  it('returns nothing for an empty report instead of inventing months', () => {
    expect(toMonthlyExpenseData(report([]), monthlyExpenseSeries(report([])), 'ar-EG')).toEqual([])
  })

  it('labels the axis compactly and the tooltip with the year', () => {
    const [january] = toMonthlyExpenseData(report([cell('2026-01', 'SALARY', 1)]), [], 'ar-EG')

    expect(january.label).toBe(formatMonthKey('2026-01', 'ar-EG', { short: true }))
    expect(january.fullLabel).toBe(formatMonthKey('2026-01', 'ar-EG'))
    expect(january.fullLabel).toContain('2026')
  })
})

describe('the month-over-month reading of total expenses', () => {
  const series = monthlyExpenseSeries(report([]))
  const data = (rows: ExpenseMonthRow[]) => toMonthlyExpenseData(report(rows), series, 'ar-EG')

  it('reads a rise in the total spend, summing every category', () => {
    // Three real categories, each its own series.
    const series = [
      ...monthlyExpenseSeries(report([])),
      { key: 'UTILITIES', label: 'مرافق', color: 'var(--warning)' },
    ]
    // 100+50+50 = 200 → 120+60+70 = 250 is +25%.
    const change = monthOverMonth(
      toMonthlyExpenseData(
        report([
          cell('2026-01', 'SALARY', 100),
          cell('2026-01', 'SUPPLIES', 50),
          cell('2026-01', 'UTILITIES', 50),
          cell('2026-02', 'SALARY', 120),
          cell('2026-02', 'SUPPLIES', 60),
          cell('2026-02', 'UTILITIES', 70),
        ]),
        series,
        'ar-EG',
      ),
      series,
    )

    expect(change.trend).toBe('up')
    expect(change.currentTotal).toBe(250)
    expect(change.previousTotal).toBe(200)
    expect(change.percent).toBeCloseTo(25)
  })

  it('reads a fall in the total spend', () => {
    const change = monthOverMonth(
      data([cell('2026-01', 'SALARY', 100), cell('2026-02', 'SALARY', 80)]),
      series,
    )

    expect(change.trend).toBe('down')
    expect(change.percent).toBeCloseTo(-20)
  })

  it('reads an unchanged total as flat, not as a rise', () => {
    const change = monthOverMonth(
      data([cell('2026-01', 'SALARY', 100), cell('2026-02', 'SUPPLIES', 100)]),
      series,
    )

    expect(change.trend).toBe('flat')
    expect(change.percent).toBe(0)
  })

  it('never produces a percentage when the previous month spent nothing', () => {
    const change = monthOverMonth(
      data([
        // The previous month is present but spent nothing: there is no
        // percentage for "growth from nothing", and no Infinity/NaN either.
        { month: '2026-01', category: '', category_name: '', count: 0, amount: 0 },
        cell('2026-02', 'SALARY', 500),
      ]),
      series,
    )

    expect(change.trend).toBe('unavailable')
    expect(change.percent).toBeNull()
    expect(change.previousTotal).toBe(0)
  })

  it('has nothing to compare against with a single month', () => {
    const change = monthOverMonth(data([cell('2026-01', 'SALARY', 100)]), series)

    expect(change.trend).toBe('unavailable')
    expect(change.percent).toBeNull()
    expect(change.previousTotal).toBeNull()
  })

  it('has nothing to plot, and nothing to compare, for an empty report', () => {
    const change = monthOverMonth([], series)

    expect(change.trend).toBe('unavailable')
    expect(change.percent).toBeNull()
  })
})
