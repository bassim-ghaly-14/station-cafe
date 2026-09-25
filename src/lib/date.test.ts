import { describe, expect, it, afterEach } from 'vitest'
import { resetFormattingPreferences, updateDateSettings } from './formatting'
import {
  addDays,
  addMonths,
  daysInMonth,
  formatIsoDate,
  formatDate,
  formatDateTime,
  formatDateTimeParts,
  formatTime,
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

describe('global display date and time formatting', () => {
  afterEach(() => resetFormattingPreferences())

  it('supports every date style and deterministic invalid values', () => {
    expect(formatDate('2026-09-25', { locale: 'en-US' })).toBe('25/09/2026')
    expect(formatDate('2026-09-25', { dateFormat: 'MM/DD/YYYY' })).toBe('09/25/2026')
    expect(formatDate('2026-09-25', { dateFormat: 'YYYY-MM-DD' })).toBe('2026-09-25')
    expect(formatDate('2026-09-25', { dateFormat: 'DD-MM-YYYY' })).toBe('25-09-2026')
    expect(formatDate('2026-09-25', { dateFormat: 'DD MMM YYYY', locale: 'en-US' })).toBe(
      '25 Sep 2026',
    )
    expect(formatDate('2026-09-25', { dateFormat: 'MMM DD, YYYY', locale: 'en-US' })).toBe(
      'Sep 25, 2026',
    )
    expect(formatDate('bad')).toBe('bad')
    expect(formatDate(null)).toBe('—')
    expect(formatDate(undefined)).toBe('—')
  })

  it('supports 12/24 hour, seconds, and combined output', () => {
    const value = '2026-09-25T14:35:27'
    expect(formatTime(value, { timeFormat: '24h' })).toBe('14:35')
    expect(formatTime(value, { timeFormat: '12h', locale: 'en-US' })).toBe('2:35 PM')
    expect(formatTime(value, { timeFormat: '24h', showSeconds: true })).toBe('14:35:27')
    expect(formatDateTime(value, { timeFormat: '24h', locale: 'en-US' })).toBe('25/09/2026 14:35')
  })

  it('reacts to the latest global preferences', () => {
    updateDateSettings({ dateFormat: 'YYYY-MM-DD', timeFormat: '12h', showSeconds: true })
    expect(formatDateTime('2026-09-25T14:35:27', { locale: 'en-US' })).toBe('2026-09-25 2:35:27 PM')
  })

  it('splits a stamp into independent date and time parts', () => {
    expect(formatDateTimeParts('2026-09-25T14:35:27', { locale: 'en-US' })).toEqual({
      date: '25/09/2026',
      time: '14:35',
    })
    // A business date carries no time, so the composition has no time slot.
    expect(formatDateTimeParts('2026-09-25')).toEqual({ date: '25/09/2026', time: null })
    expect(formatDateTimeParts(null)).toBeNull()
    // The parts always agree with the single-string formatter.
    expect(formatDateTime('2026-09-25T14:35:27', { locale: 'en-US' })).toBe('25/09/2026 14:35')
  })

  it('splits long localized dates from their 12-hour time without merging', () => {
    const parts = formatDateTimeParts('2026-09-25T09:56:00', {
      dateFormat: 'DD MMM YYYY',
      timeFormat: '12h',
      locale: 'ar-EG',
    })
    expect(parts?.date).toBe('25 سبتمبر 2026')
    // The Arabic meridiem belongs to the TIME slot only — it can never be
    // reordered into the middle of the date by the surrounding bidi context.
    expect(parts?.time).toContain('9:56')
    expect(parts?.time).toContain('ص')
  })

  it('renders against an explicit draft without touching the saved settings', () => {
    const draft = { dateFormat: 'YYYY-MM-DD', timeFormat: '12h', showSeconds: false } as const
    expect(formatDate('2026-09-25', { settings: draft })).toBe('2026-09-25')
    expect(formatTime('2026-09-25T14:35:27', { settings: draft })).toBe('2:35 م')
    // The saved preferences are unchanged by rendering a draft.
    expect(formatDate('2026-09-25')).toBe('25/09/2026')
  })
})
