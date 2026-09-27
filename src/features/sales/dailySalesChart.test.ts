/**
 * The Sales page's daily-chart configuration, tested as the DATA it hands the
 * shared chart — never as rendered bars.
 *
 * The point of these assertions is that the mapping is lossless: the bar height
 * is the figure the backend computed, the axis is the day in the app's own date
 * form, and the series are painted through the centralized chart colour roles so
 * Dev Settings can recolour them like any other bar.
 */
import { describe, expect, it } from 'vitest'
import { formatDate } from '@/lib/date'
import { chartBarColor } from '@/lib/chart-colors'
import type { SalesDayRow } from '@/services/salesApi'
import {
  INVOICES_KEY,
  AVERAGE_INVOICE_KEY,
  REVENUE_KEY,
  salesDailySeries,
  toSalesDailyData,
} from './SalesDailyChart'

const DAYS: SalesDayRow[] = [
  {
    day_id: 2,
    day_date: '2026-09-10',
    invoices_count: 5,
    total_sales: 24_000,
    cafe_sales: 15_000,
    wash_sales: 9_000,
    cash: 12_000,
    card: 5_000,
    credit: 7_000,
  },
  {
    day_id: 1,
    day_date: '2026-09-09',
    invoices_count: 2,
    total_sales: 15_000,
    cafe_sales: 9_000,
    wash_sales: 6_000,
    cash: 8_000,
    card: 7_000,
    credit: 0,
  },
]

describe('the sales days the chart plots', () => {
  it('is DAILY: one entry per day, in date order, never a month bucket', () => {
    const data = toSalesDailyData(DAYS)

    expect(data).toHaveLength(2)
    // Sorted ascending, so the x-axis reads as a calendar whatever the backend
    // returned. Two days in, two days out — no aggregation anywhere.
    expect(data[0]?.[REVENUE_KEY]).toBe(15_000)
    expect(data[1]?.[REVENUE_KEY]).toBe(24_000)
  })

  it('carries the revenue and the invoice count the backend computed', () => {
    const data = toSalesDailyData(DAYS)

    expect(data[0]?.[REVENUE_KEY]).toBe(15_000)
    expect(data[0]?.[INVOICES_KEY]).toBe(2)
    expect(data[1]?.[REVENUE_KEY]).toBe(24_000)
    expect(data[1]?.[INVOICES_KEY]).toBe(5)
  })

  it('labels every day through the central Arabic date formatter', () => {
    const data = toSalesDailyData(DAYS)

    // Each label is exactly what the app's own formatter produces for that day,
    // so the axis, the tooltip and the rest of the UI can never disagree.
    expect(data[0]?.label).toBe(formatDate('2026-09-09'))
    expect(data[1]?.label).toBe(formatDate('2026-09-10'))
    expect(data[0]?.fullLabel).toBe(formatDate('2026-09-09'))
    for (const day of data) {
      // A raw ISO date is never what the axis or the tooltip shows.
      expect(day.label).not.toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

describe('the figures the sales chart declares', () => {
  const { series, metrics } = salesDailySeries({
    revenue: 'إجمالي المبيعات',
    invoices: 'عدد الفواتير',
    average: 'متوسط قيمة الفاتورة',
  })

  it('plots the revenue as the ONE bar, named in Arabic only', () => {
    expect(series.map((s) => s.label)).toEqual(['إجمالي المبيعات'])
    expect(series.map((s) => s.key)).toEqual([REVENUE_KEY])
  })

  it('states the count and the average as metrics, in that order', () => {
    // Primary first, then the count, then the average — the reading order the
    // tooltip follows. The count is not a bar: two invoices beside 24,000
    // piastres would be an invisible bar.
    expect(metrics.map((m) => m.key)).toEqual([INVOICES_KEY, AVERAGE_INVOICE_KEY])
    expect(metrics.map((m) => m.label)).toEqual(['عدد الفواتير', 'متوسط قيمة الفاتورة'])
  })

  it('declares what every value MEANS, so a count can never print as money', () => {
    // THE regression this configuration exists to prevent: a count of 2 printed
    // as `0.02 ج.م`. The declaration is what makes that impossible.
    expect(series[0]?.type).toBe('currency')
    expect(metrics[0]?.type).toBe('count')
    expect(metrics[1]?.type).toBe('currency')
  })

  it('takes its bar colour from the centralized chart bar roles', () => {
    // Not a literal: the value must be a `var(--chart-bar-*)` reference, so the
    // theme decides light/dark and Dev Settings repaints it.
    expect(series[0]?.color).toBe(chartBarColor('sales'))
    expect(series[0]?.color).toMatch(/^var\(--chart-bar-/)
  })
})

describe('the average invoice value of a day', () => {
  it("is the day's own revenue over the day's own count", () => {
    const data = toSalesDailyData(DAYS)

    // 15,000 / 2 and 24,000 / 5 — piastres, exactly as the backend stored them.
    expect(data[0]?.[AVERAGE_INVOICE_KEY]).toBe(7_500)
    expect(data[1]?.[AVERAGE_INVOICE_KEY]).toBe(4_800)
  })

  it('is ABSENT, not zero, on a day with no invoices', () => {
    const data = toSalesDailyData([
      { ...DAYS[0]!, day_date: '2026-09-11', invoices_count: 0, total_sales: 0 },
    ])

    // The tooltip prints no average row for this day; a `0.00 ج.م` would state a
    // measurement nobody made.
    expect(data[0]?.[AVERAGE_INVOICE_KEY]).toBeUndefined()
  })
})
