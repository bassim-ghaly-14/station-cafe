import { describe, expect, it } from 'vitest'
import {
  addDays,
  addMonths,
  daysInMonth,
  formatIsoDate,
  formatIsoDateLong,
  formatMonthTitle,
  isoDate,
  monthCells,
  parseIsoDate,
  todayIso,
  weekStartIndex,
  weekdayLabels,
} from './date'

describe('business dates are plain YYYY-MM-DD strings', () => {
  it('parses valid dates and rejects anything else', () => {
    expect(parseIsoDate('2026-09-22')).toEqual({ year: 2026, month: 9, day: 22 })
    expect(parseIsoDate('2026-02-30')).toBeNull()
    expect(parseIsoDate('2026-13-01')).toBeNull()
    expect(parseIsoDate('2026-00-10')).toBeNull()
    expect(parseIsoDate('22/09/2026')).toBeNull()
    expect(parseIsoDate('')).toBeNull()
  })

  it('builds zero-padded ISO dates', () => {
    expect(isoDate(2026, 1, 5)).toBe('2026-01-05')
    expect(isoDate(2026, 12, 31)).toBe('2026-12-31')
  })

  it('renders the exact calendar day, never a timezone-shifted one', () => {
    // Formatting is pinned to UTC, so 2026-09-01 can never become Aug 31.
    expect(formatIsoDate('2026-09-01', 'en-US')).toBe('Sep 01, 2026')
    expect(formatIsoDate('2026-01-01', 'en-US')).toBe('Jan 01, 2026')
    expect(formatIsoDate('2026-09-01', 'ar-EG')).toBe('01 سبتمبر 2026')
    expect(formatIsoDateLong('2026-09-22', 'ar-EG')).toContain('22 سبتمبر 2026')
    expect(formatIsoDate('nonsense', 'en-US')).toBe('nonsense')
  })

  it('reads today from the local calendar, not from UTC', () => {
    const now = new Date()
    expect(todayIso()).toBe(isoDate(now.getFullYear(), now.getMonth() + 1, now.getDate()))
  })

  it('steps business dates by whole days, also across months and years', () => {
    expect(addDays('2026-09-22', -6)).toBe('2026-09-16')
    expect(addDays('2026-09-01', -1)).toBe('2026-08-31')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDays('2026-09-22', 0)).toBe('2026-09-22')
    expect(addDays('nonsense', 1)).toBe('nonsense')
  })
})

describe('calendar math', () => {
  it('knows month lengths including leap years', () => {
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2026, 9)).toBe(30)
    expect(daysInMonth(2026, 12)).toBe(31)
  })

  it('shifts months across year boundaries', () => {
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 })
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 })
    expect(addMonths(2026, 9, 0)).toEqual({ year: 2026, month: 9 })
    expect(addMonths(2026, 9, -13)).toEqual({ year: 2025, month: 8 })
  })

  it('starts the week on Saturday for Arabic locales', () => {
    expect(weekStartIndex('ar-EG')).toBe(6)
    expect(weekStartIndex('en-US')).toBe(0)
  })

  it('builds a fixed six-week grid, padded with adjacent-month days', () => {
    // September 2026 starts on a Tuesday.
    const arabicWeeks = monthCells(2026, 9, weekStartIndex('ar-EG'))
    expect(arabicWeeks).toHaveLength(42)
    expect(arabicWeeks[0]).toEqual({ iso: '2026-08-29', day: 29, inMonth: false })
    expect(arabicWeeks[3]).toEqual({ iso: '2026-09-01', day: 1, inMonth: true })
    expect(arabicWeeks.filter((c) => c.inMonth)).toHaveLength(30)

    const ltrWeeks = monthCells(2026, 9, weekStartIndex('en-US'))
    expect(ltrWeeks).toHaveLength(42)
    expect(ltrWeeks[0].iso).toBe('2026-08-30')
    expect(ltrWeeks[0].inMonth).toBe(false)
    expect(ltrWeeks[2].iso).toBe('2026-09-01')
  })

  it('localizes month titles and weekday names', () => {
    expect(formatMonthTitle(2026, 9, 'en-US')).toBe('September 2026')
    expect(formatMonthTitle(2026, 9, 'ar-EG')).toBe('سبتمبر 2026')
    expect(weekdayLabels('en-US', 0)).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
    expect(weekdayLabels('ar-EG', 6)).toEqual([
      'السبت',
      'الأحد',
      'الاثنين',
      'الثلاثاء',
      'الأربعاء',
      'الخميس',
      'الجمعة',
    ])
  })
})
