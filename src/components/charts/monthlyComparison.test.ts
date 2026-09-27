import { describe, expect, it } from 'vitest'
import {
  formatPercent,
  monthOverMonth,
  monthTotal,
  seriesTooltipName,
  seriesTooltipValue,
  seriesValue,
  type MonthlyComparisonDatum,
  type MonthlySeriesConfig,
} from './monthlyComparison'

/**
 * The monthly comparison is arithmetic, so it is tested as arithmetic: no
 * rendering, no recharts, no i18n. Each case below is a business situation the
 * chart must answer correctly, not a snapshot of a component.
 */

const CAFE_WASH: MonthlySeriesConfig[] = [
  { key: 'cafe', label: 'كافيه', color: 'var(--info)' },
  { key: 'wash', label: 'مغسلة', color: 'var(--primary)' },
]

function month(key: string, cafe: number, wash: number): MonthlyComparisonDatum {
  return { month: key, label: key, cafe, wash }
}

describe('seriesValue', () => {
  it('reads a numeric series and treats a missing value as zero', () => {
    expect(seriesValue(month('2026-01', 100, 50), 'cafe')).toBe(100)
    expect(seriesValue({ month: '2026-01', label: 'x' }, 'cafe')).toBe(0)
    expect(seriesValue({ month: '2026-01', label: 'x', cafe: Number.NaN }, 'cafe')).toBe(0)
  })
})

describe('monthTotal', () => {
  it('sums every configured series of the month', () => {
    // January: cafe 100 + wash 100 = 200
    expect(monthTotal(month('2026-01', 100, 100), CAFE_WASH)).toBe(200)
  })

  it('ignores series the caller did not configure', () => {
    const onlyCafe: MonthlySeriesConfig[] = [CAFE_WASH[0]]
    expect(monthTotal(month('2026-01', 100, 9_000), onlyCafe)).toBe(100)
  })
})

describe('monthOverMonth', () => {
  it('compares the TOTAL of the latest month with the total of the one before it', () => {
    // January total 200 → February total 250 = +25%. Comparing cafe against
    // cafe would have said +50%, and cafe against wash +0%: both wrong answers.
    const change = monthOverMonth(
      [month('2026-01', 100, 100), month('2026-02', 150, 100)],
      CAFE_WASH,
    )

    expect(change.currentTotal).toBe(250)
    expect(change.previousTotal).toBe(200)
    expect(change.trend).toBe('up')
    expect(change.percent).toBeCloseTo(25, 10)
  })

  it('reports a negative movement when the month got quieter', () => {
    const change = monthOverMonth(
      [month('2026-01', 100_000, 100_000), month('2026-02', 90_000, 100_000)],
      CAFE_WASH,
    )

    expect(change.trend).toBe('down')
    expect(change.percent).toBeCloseTo(-5, 10)
  })

  it('reports no movement when the total is unchanged', () => {
    const change = monthOverMonth(
      [month('2026-01', 60_000, 40_000), month('2026-02', 20_000, 80_000)],
      CAFE_WASH,
    )

    expect(change.trend).toBe('flat')
    expect(change.percent).toBe(0)
  })

  it('never divides by a zero previous month', () => {
    const change = monthOverMonth([month('2026-01', 0, 0), month('2026-02', 50_000, 0)], CAFE_WASH)

    expect(change.trend).toBe('unavailable')
    expect(change.percent).toBeNull()
    expect(change.previousTotal).toBe(0)
    expect(change.currentTotal).toBe(50_000)
  })

  it('makes no comparison when there is a single month', () => {
    const change = monthOverMonth([month('2026-01', 50_000, 0)], CAFE_WASH)

    expect(change.trend).toBe('unavailable')
    expect(change.percent).toBeNull()
    expect(change.previousTotal).toBeNull()
    expect(change.currentTotal).toBe(50_000)
  })

  it('handles an empty series without inventing a reading', () => {
    const change = monthOverMonth([], CAFE_WASH)

    expect(change.trend).toBe('unavailable')
    expect(change.percent).toBeNull()
    expect(change.currentTotal).toBe(0)
  })

  it('keeps a zero month in the series and reads it as a real month', () => {
    // The backend keeps quiet months, so the comparison must not skip them:
    // February is zero, January is 200 → -100%, not "no data".
    const change = monthOverMonth([month('2026-01', 100, 100), month('2026-02', 0, 0)], CAFE_WASH)

    expect(change.trend).toBe('down')
    expect(change.percent).toBeCloseTo(-100, 10)
  })

  it('uses the last two entries as the latest and previous month', () => {
    const change = monthOverMonth(
      [month('2025-01', 999, 999), month('2026-01', 100, 100), month('2026-02', 110, 110)],
      CAFE_WASH,
    )

    expect(change.currentTotal).toBe(220)
    expect(change.previousTotal).toBe(200)
    expect(change.percent).toBeCloseTo(10, 10)
  })
})

const CATEGORIES: MonthlySeriesConfig[] = [
  { key: 'ELECTRICITY', label: 'كهرباء', color: 'var(--primary)', format: (v) => `${v} ج.م` },
  {
    key: 'MAINTENANCE',
    label: 'صيانة أجهزة المطبخ وطاولات الجلوس',
    color: 'var(--info)',
    format: (v) => `${v} ج.م`,
  },
]

describe('seriesTooltipName', () => {
  it('resolves a SALES SECTION to its Arabic name, with no English beside it', () => {
    expect(seriesTooltipName(CAFE_WASH, 'cafe')).toBe('كافيه')
    expect(seriesTooltipName(CAFE_WASH, 'wash')).toBe('مغسلة')
    // The name is Arabic only — the series key `cafe` is never part of it.
    expect(seriesTooltipName(CAFE_WASH, 'cafe')).not.toContain('cafe')
  })

  it('resolves an EXPENSE CATEGORY to its Arabic name, never "MAINTENANCE صيانة"', () => {
    expect(seriesTooltipName(CATEGORIES, 'ELECTRICITY')).toBe('كهرباء')
    // A long Arabic name is resolved whole: truncating it would lose the category.
    expect(seriesTooltipName(CATEGORIES, 'MAINTENANCE')).toBe('صيانة أجهزة المطبخ وطاولات الجلوس')
    // The internal code is the lookup key, never the displayed text.
    expect(seriesTooltipName(CATEGORIES, 'MAINTENANCE')).not.toContain('MAINTENANCE')
  })

  it('states no name at all for a series the chart does not configure', () => {
    // A retired category has no Arabic name to print, and its slug must not be
    // promoted to one — the row shows its value only.
    expect(seriesTooltipName(CAFE_WASH, 'RETIRED_CODE')).toBe('')
  })
})

describe('seriesTooltipValue', () => {
  const formatValue = (value: number) => `${value} ج.م`

  it('states the VALUE alone — the row already prints the name', () => {
    expect(seriesTooltipValue(CAFE_WASH, 'cafe', 25_400, formatValue)).toBe('25400 ج.م')
    expect(seriesTooltipValue(CATEGORIES, 'ELECTRICITY', 8_500, formatValue)).toBe('8500 ج.م')
  })

  it('prefers the series formatter, and falls back to the chart one', () => {
    const withFormat: MonthlySeriesConfig[] = [
      { key: 'cafe', label: 'كافيه', color: 'var(--info)', format: (value) => `${value} مُصغَّر` },
    ]

    expect(seriesTooltipValue(withFormat, 'cafe', 25_400, formatValue)).toBe('25400 مُصغَّر')
    expect(seriesTooltipValue(CAFE_WASH, 'cafe', 0, formatValue)).toBe('0 ج.م')
  })

  it('still states a value for a series the chart does not configure', () => {
    // The figure is real data; only the name is missing.
    expect(seriesTooltipValue(CAFE_WASH, 'RETIRED_CODE', 4_200, formatValue)).toBe('4200 ج.م')
  })
})

describe('formatPercent', () => {
  it('renders one decimal with Latin digits and a plain sign', () => {
    expect(formatPercent(12.44)).toBe('12.4')
    // A negative reading must not smuggle an invisible bidi mark into the badge.
    expect(formatPercent(-8.74)).toBe('-8.7')
    expect(formatPercent(0)).toBe('0.0')
  })
})
