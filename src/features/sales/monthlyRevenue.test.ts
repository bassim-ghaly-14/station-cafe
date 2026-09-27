/**
 * The Sales usage of the generic chart: the DTO → chart mapping, the two series
 * it plots, and the localized labels. No aggregation is tested here — the
 * backend owns that, and the Rust tests prove it; this file only proves the
 * monthly rows arrive at the chart in the right shape and in the right order.
 */
import { describe, expect, it } from 'vitest'
import { monthTotal } from '@/components/charts/monthlyComparison'
import { formatMonthKey } from '@/lib/date'
import type { SalesMonthRow } from '@/services/salesApi'
import { CAFE_KEY, WASH_KEY, monthlyRevenueSeries, toMonthlyRevenueData } from './monthlyRevenue'

const SERIES = monthlyRevenueSeries({ cafe: 'كافيه', wash: 'مغسلة' })

function row(month: string, cafe: number, wash: number): SalesMonthRow {
  return { month, invoices_count: 1, total_sales: cafe + wash, cafe_sales: cafe, wash_sales: wash }
}

describe('monthlyRevenueSeries', () => {
  it('plots cafe and wash as two separate series on the centralized chart roles', () => {
    expect(SERIES.map((item) => item.key)).toEqual([CAFE_KEY, WASH_KEY])
    expect(SERIES.map((item) => item.label)).toEqual(['كافيه', 'مغسلة'])
    // The CENTRALIZED chart bar roles, not a hand-picked theme token: the same
    // roles the reports donuts use for these two business lines, and the ones
    // Dev Settings edits.
    expect(SERIES.map((item) => item.color)).toEqual([
      'var(--chart-bar-secondary)',
      'var(--chart-bar-primary)',
    ])
    // A hex value would bypass the theme and break dark mode.
    expect(SERIES.every((item) => item.color.startsWith('var(--'))).toBe(true)
  })
})

describe('toMonthlyRevenueData', () => {
  it('carries each month cafe and wash as separate values', () => {
    const [september] = toMonthlyRevenueData([row('2026-09', 40_000, 60_000)], 'ar-EG')

    expect(september.month).toBe('2026-09')
    expect(september[CAFE_KEY]).toBe(40_000)
    expect(september[WASH_KEY]).toBe(60_000)
    expect(monthTotal(september, SERIES)).toBe(100_000)
  })

  it('keeps the same month of two different years as two categories', () => {
    const data = toMonthlyRevenueData(
      [row('2026-01', 70_000, 0), row('2025-01', 30_000, 0)],
      'ar-EG',
    )

    expect(data.map((item) => item.month)).toEqual(['2025-01', '2026-01'])
    // Distinct full labels, so a series crossing a year is never ambiguous.
    expect(data[0].fullLabel).not.toBe(data[1].fullLabel)
    expect(data[0].fullLabel).toBe(formatMonthKey('2025-01', 'ar-EG'))
  })

  it('keeps a month with no revenue as a zero-valued category', () => {
    const data = toMonthlyRevenueData(
      [row('2026-01', 0, 0), row('2026-02', 10_000, 5_000)],
      'ar-EG',
    )

    expect(data).toHaveLength(2)
    expect(data[0][CAFE_KEY]).toBe(0)
    expect(data[0][WASH_KEY]).toBe(0)
    expect(monthTotal(data[1], SERIES)).toBe(15_000)
  })

  it('returns nothing for an empty report instead of inventing months', () => {
    expect(toMonthlyRevenueData([], 'ar-EG')).toEqual([])
  })

  it('labels the axis compactly and the tooltip with the year', () => {
    const [january] = toMonthlyRevenueData([row('2026-01', 1, 1)], 'ar-EG')

    expect(january.label).toBe(formatMonthKey('2026-01', 'ar-EG', { short: true }))
    expect(january.fullLabel).toBe(formatMonthKey('2026-01', 'ar-EG'))
    expect(january.fullLabel).toContain('2026')
  })
})
