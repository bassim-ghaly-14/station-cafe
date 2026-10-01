/**
 * The target-progress presentation rules.
 *
 * These are the two rules that could quietly corrupt the business meaning if they
 * lived inside a component: the BAR is capped while the NUMBER is not, and a
 * month with no target prints no percentage at all. Both are pure functions, so
 * both are stated here rather than only being visible in a rendered card.
 */
import { describe, expect, it } from 'vitest'
import type { TargetDayRow } from '@/services/salesApi'
import { achievementText, departmentDays, fillWidth } from './targetProgress'

const day = (over: Partial<TargetDayRow> = {}): TargetDayRow => ({
  day_date: '2026-10-01',
  cafe_revenue: 100,
  wash_revenue: 200,
  cafe_cumulative: 300,
  wash_cumulative: 400,
  cafe_achievement_hundredths: 5000,
  wash_achievement_hundredths: 2500,
  ...over,
})

describe('fillWidth', () => {
  it('is the percentage for a month under its target', () => {
    expect(fillWidth(5000)).toBe(50)
    expect(fillWidth(10000)).toBe(100)
  })

  /** The DRAWING is capped; the printed figure is not. */
  it('never fills the track past one hundred', () => {
    expect(fillWidth(11429)).toBe(100)
    expect(fillWidth(25000)).toBe(100)
  })

  it('is empty for a month with no target, or no revenue yet', () => {
    expect(fillWidth(null)).toBe(0)
    expect(fillWidth(0)).toBe(0)
    expect(fillWidth(-100)).toBe(0)
  })
})

describe('achievementText', () => {
  it('passes the backend string through untouched', () => {
    expect(achievementText('114.29')).toBe('114.29')
    expect(achievementText('50.00')).toBe('50.00')
  })

  it('keeps "no target" distinct from "zero percent"', () => {
    expect(achievementText(null)).toBeNull()
    expect(achievementText('0.00')).toBe('0.00')
  })
})

describe('departmentDays', () => {
  const rows = [
    day({ day_date: '2026-10-01' }),
    day({
      day_date: '2026-10-02',
      cafe_revenue: 50,
      cafe_cumulative: 150,
      cafe_achievement_hundredths: 7500,
      wash_revenue: 25,
      wash_cumulative: 225,
      wash_achievement_hundredths: 1125,
    }),
  ]

  it('reads one department out of each row without mixing them', () => {
    expect(departmentDays(rows, 'CAFE')).toEqual([
      {
        dayDate: '2026-10-01',
        revenue: 100,
        cumulative: 300,
        achievementPercent: '50.00',
        fill: 50,
      },
      {
        dayDate: '2026-10-02',
        revenue: 50,
        cumulative: 150,
        achievementPercent: '75.00',
        fill: 75,
      },
    ])

    const wash = departmentDays(rows, 'WASH')
    expect(wash.map((line) => line.revenue)).toEqual([200, 25])
    expect(wash.map((line) => line.cumulative)).toEqual([400, 225])
    expect(wash[1].achievementPercent).toBe('11.25')
  })

  /** Each day's percentage is the CUMULATIVE one the backend already computed. */
  it('formats the backend hundredths to two decimals, including above 100', () => {
    const over = [day({ cafe_achievement_hundredths: 11429 })]
    expect(departmentDays(over, 'CAFE')[0].achievementPercent).toBe('114.29')
    expect(departmentDays(over, 'CAFE')[0].fill).toBe(100)
  })

  it('reports no percentage at all when the month has no target', () => {
    const untargeted = [
      day({ cafe_achievement_hundredths: null, wash_achievement_hundredths: null }),
    ]
    expect(departmentDays(untargeted, 'CAFE')[0].achievementPercent).toBeNull()
    expect(departmentDays(untargeted, 'WASH')[0].achievementPercent).toBeNull()
    expect(departmentDays(untargeted, 'CAFE')[0].fill).toBe(0)
  })

  it('keeps the revenue of a day with no sales, as a zero', () => {
    const quiet = [day({ cafe_revenue: 0, cafe_achievement_hundredths: 0 })]
    expect(departmentDays(quiet, 'CAFE')[0].revenue).toBe(0)
    expect(departmentDays(quiet, 'CAFE')[0].achievementPercent).toBe('0.00')
  })
})
