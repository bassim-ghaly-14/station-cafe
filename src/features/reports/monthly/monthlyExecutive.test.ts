/**
 * The monthly executive report's presentation rules.
 *
 * These are the three things that could quietly corrupt what the owner reads if
 * they lived inside a component: a movement percentage that divides by zero, a
 * note list that grows past the page, and a note that judges the business. All
 * three are pure functions, so all three are stated here rather than only being
 * visible in a rendered sheet.
 */
import { describe, expect, it } from 'vitest'
import type { MonthlyExecutiveReport, MonthlyMoney } from '@/services/opsApi'
import { keyNotes, MAX_KEY_NOTES, monthOverMonth, moneyMovement } from './monthlyExecutive'

const money = (revenue: number, expenses: number): MonthlyMoney => ({
  revenue_minor: revenue,
  expenses_minor: expenses,
  net_minor: revenue - expenses,
})

const report = (over: Partial<MonthlyExecutiveReport> = {}): MonthlyExecutiveReport => ({
  month: '2026-09',
  from: '2026-09-01',
  to: '2026-09-30',
  comparison_month: '2026-08',
  comparison: 'PREVIOUS_MONTH',
  cafe: {
    actual_minor: 8_240_000,
    target_minor: 8_000_000,
    overridden: false,
    achievement_percent: '103.00',
  },
  wash: {
    actual_minor: 4_300_000,
    target_minor: 4_500_000,
    overridden: false,
    achievement_percent: '95.56',
  },
  money: money(12_540_000, 3_240_000),
  comparison_figures: money(11_820_000, 2_980_000),
  ...over,
})

describe('monthOverMonth', () => {
  it('states a rise and a fall with one decimal', () => {
    expect(monthOverMonth(110, 100)).toEqual({ trend: 'up', percent: 10 })
    expect(monthOverMonth(90, 100)).toEqual({ trend: 'down', percent: -10 })
    expect(monthOverMonth(101, 100).percent).toBe(1)
  })

  it('states no change as zero rather than as a missing figure', () => {
    expect(monthOverMonth(100, 100)).toEqual({ trend: 'flat', percent: 0 })
  })

  /**
   * Growth from nothing has no percentage. This is the case that would otherwise
   * print `Infinity%` on a page an owner hands to a bank.
   */
  it('refuses a percentage when the previous month was zero or absent', () => {
    expect(monthOverMonth(500, 0)).toEqual({ trend: 'unavailable', percent: null })
    expect(monthOverMonth(500, null)).toEqual({ trend: 'unavailable', percent: null })
  })

  it('never produces NaN or Infinity for any pair of figures', () => {
    for (const previous of [0, 1, 1_000, 999_999]) {
      for (const current of [0, 1, 7, 1_000_000]) {
        const { percent } = monthOverMonth(current, previous)
        if (percent !== null) {
          expect(Number.isFinite(percent)).toBe(true)
        }
      }
    }
  })
})

describe('moneyMovement', () => {
  it('moves all three figures against the previous month', () => {
    const movement = moneyMovement(money(120, 90), money(100, 80))
    expect(movement.revenue.percent).toBe(20)
    expect(movement.expenses.percent).toBe(12.5)
    // Net 30 against 20 — the derived figure moves with its own two inputs, not
    // with either of them alone.
    expect(movement.net.percent).toBe(50)
    expect(movement.net.trend).toBe('up')
  })

  /**
   * A month that ended at zero has no percentage to grow from, even when the
   * revenue and expense lines around it both moved.
   */
  it('states no net movement when the previous month ended at zero', () => {
    const movement = moneyMovement(money(110, 90), money(100, 100))
    expect(movement.net).toEqual({ trend: 'unavailable', percent: null })
  })

  /**
   * The comparison period is the ONLY thing the mode changes — the movement
   * arithmetic itself is the same function over the same figures, so the new
   * mode introduces no new percentage semantics.
   */
  it('measures a positive, negative and equal change identically for either period', () => {
    const rise = moneyMovement(money(110, 100), money(100, 80))
    const fall = moneyMovement(money(90, 100), money(100, 80))
    expect(rise.revenue.percent).toBe(10)
    expect(fall.revenue.percent).toBe(-10)
    // Equal values are flat, not a hidden zero change.
    expect(moneyMovement(money(100, 100), money(100, 100)).revenue).toEqual({
      trend: 'flat',
      percent: 0,
    })
  })

  it('reports the whole set as unavailable when the comparison month was empty', () => {
    const movement = moneyMovement(money(500, 100), money(0, 0))
    expect(Object.values(movement).map((entry) => entry.percent)).toEqual([null, null, null])
  })
})

describe('keyNotes', () => {
  it('states both departments against their own targets', () => {
    const notes = keyNotes(report())
    expect(notes.map((note) => note.key)).toEqual([
      'reports.monthly.notes.cafeTarget',
      'reports.monthly.notes.washTarget',
      // Expenses moved further (+8.7%) than revenue (+6.1%), so the third note
      // names the movement that actually happened rather than a fixed one.
      'reports.monthly.notes.expensesMovement',
    ])
    expect(notes[0].values.percent).toBe('103.00')
  })

  it('never states a percentage for a department that has no target', () => {
    const notes = keyNotes(
      report({
        wash: { actual_minor: 0, target_minor: 0, overridden: false, achievement_percent: null },
      }),
    )
    expect(notes.some((note) => note.key === 'reports.monthly.notes.washTarget')).toBe(false)
    expect(notes.every((note) => !note.values.percent?.includes('NaN'))).toBe(true)
  })

  it('never prints more notes than the page has room for', () => {
    expect(keyNotes(report()).length).toBeLessThanOrEqual(MAX_KEY_NOTES)
    expect(MAX_KEY_NOTES).toBe(3)
  })

  /** The same month must always produce the same notes. */
  it('is deterministic', () => {
    expect(keyNotes(report())).toEqual(keyNotes(report()))
  })

  it('picks the largest movement, and names no figure it cannot compare', () => {
    const notes = keyNotes(report({ comparison_figures: money(0, 0) }))
    expect(notes).toHaveLength(2)
    expect(notes.some((note) => note.key.endsWith('Movement'))).toBe(false)
  })

  /**
   * A note may only carry a translation key and its numbers. It can therefore
   * never contain a judgement: there is no sentence here that could be phrased
   * as "excellent", "weak" or "needs improvement".
   */
  it('carries no prose at all — only keys and figures', () => {
    const allowed = ['percent', 'department', 'direction', 'period']
    for (const note of keyNotes(report())) {
      expect(Object.keys(note.values).every((key) => allowed.includes(key))).toBe(true)
      // Every value is a slug or a number: nothing a judgement could hide in.
      for (const value of Object.values(note.values)) {
        expect(value).toMatch(/^[a-z][a-zA-Z]*$|^-?\d+(\.\d+)?$/)
      }
      expect(note.key).toMatch(/^reports\.monthly\.notes\.[a-zA-Z]+$/)
    }
  })
})
