import { describe, expect, it, afterEach, vi } from 'vitest'
import { resetFormattingPreferences, updateDateSettings } from './formatting'
import {
  addDays,
  addMonths,
  businessWallClockToDate,
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
  normalizeToUtcIso,
  parseIsoDate,
  STATION_TZ,
  todayIso,
  weekStartIndex,
  weekdayLabels,
} from './date'

describe('canonical Station time model', () => {
  afterEach(() => resetFormattingPreferences())

  const utc24 = { timeFormat: '24h', locale: 'en-GB' } as const

  it('renders a stored UTC instant as Cairo business time', () => {
    // The regression this whole module exists for: the stored digits are UTC
    // and must never be shown as if they were the wall clock at the café.
    expect(formatTime('2026-09-25 14:30:00Z', utc24)).toBe('17:30')
    // Egypt is UTC+3 in September (EEST) and UTC+2 in January (EET). A hardcoded
    // +03:00 would render the winter value an hour late.
    expect(formatTime('2026-01-15 14:30:00Z', utc24)).toBe('16:30')
  })

  it('reads a legacy unmarked timestamp as the same instant', () => {
    // Values written before migration 19 had no `Z`. They must still render
    // identically, so historical documents never appear to change.
    expect(formatTime('2026-09-25 14:30:00', utc24)).toBe('17:30')
    expect(formatTime('2026-09-25T14:30:00', utc24)).toBe('17:30')
    expect(formatTime('2026-09-25 14:30:00Z', utc24)).toBe('17:30')
    // An explicit offset is honored, not assumed to be UTC.
    expect(formatTime('2026-09-25T17:30:00+03:00', utc24)).toBe('17:30')
  })

  it('never shifts a pure business date', () => {
    // A calendar date is not an instant: it must survive untouched.
    expect(formatDate('2026-09-25')).toBe('25/09/2026')
    expect(formatTime('2026-09-25', utc24)).toBe('00:00')
    // Even a date at the very edge of the month.
    expect(formatDate('2026-01-01')).toBe('01/01/2026')
    expect(formatDate('2026-12-31')).toBe('31/12/2026')
  })

  it('keeps a late-night transaction on its own Cairo business date', () => {
    // 20:30 UTC is 23:30 in Cairo: still the 25th.
    expect(formatDate('2026-09-25 20:30:00Z')).toBe('25/09/2026')
    // 21:30 UTC is 00:30 on the 26th in Cairo: the next business day, even
    // though the UTC date is still the 25th.
    expect(formatDate('2026-09-25 21:30:00Z')).toBe('26/09/2026')
  })

  it('crosses midnight correctly in both directions', () => {
    expect(formatTime('2026-09-25 21:29:00Z', utc24)).toBe('00:29')
    expect(formatTime('2026-09-25 21:30:00Z', utc24)).toBe('00:30')
    expect(formatTime('2026-09-25 20:59:00Z', utc24)).toBe('23:59')
  })

  it('rejects malformed instants instead of guessing', () => {
    expect(formatTime('not-a-timestamp', utc24)).toBe('not-a-timestamp')
    expect(formatDate('')).toBe('—')
    expect(formatDate(null)).toBe('—')
    expect(formatDate(undefined)).toBe('—')
    expect(formatDateTimeParts('garbage')).toBeNull()
  })

  it('normalizes a stored timestamp to an explicit UTC instant', () => {
    expect(normalizeToUtcIso('2026-09-25 14:30:00')).toBe('2026-09-25T14:30:00Z')
    // The `Z` must survive — the date's own dashes are not a UTC offset.
    expect(normalizeToUtcIso('2026-09-25 14:30:00Z')).toBe('2026-09-25T14:30:00Z')
    expect(normalizeToUtcIso('2026-09-25T14:30:00Z')).toBe('2026-09-25T14:30:00Z')
    // Seconds are optional in the legacy shape.
    expect(normalizeToUtcIso('2026-09-25 14:30')).toBe('2026-09-25T14:30:00Z')
    // A non-timestamp is returned untouched so callers can detect it.
    expect(normalizeToUtcIso('2026-09-25')).toBe('2026-09-25')
    expect(normalizeToUtcIso('')).toBe('')
  })

  it('round-trips an instant through storage and back to the same wall clock', () => {
    // Storage -> transport -> screen must not shift the instant.
    const stored = '2026-09-25 14:30:00Z'
    const asEpoch = Date.parse(normalizeToUtcIso(stored))
    expect(formatTime(new Date(asEpoch), utc24)).toBe('17:30')
    expect(formatTime(stored, utc24)).toBe(formatTime(new Date(asEpoch), utc24))
  })

  it('builds spreadsheet cells that read as Station time anywhere', () => {
    // Excel serial dates are timezone-neutral, so the business wall clock is
    // encoded as UTC components.
    const cell = businessWallClockToDate('2026-09-25 14:30:00Z')
    expect(cell?.toISOString()).toBe('2026-09-25T17:30:00.000Z')
    // A business date is a calendar day, so its cell is that day's midnight and
    // is never shifted.
    expect(businessWallClockToDate('2026-09-25')?.toISOString()).toBe('2026-09-25T00:00:00.000Z')
    expect(businessWallClockToDate('nonsense')).toBeNull()
  })

  it('derives today from the Station business date, not the browser zone', () => {
    // `todayIso` is a business date, so it must be stable regardless of the
    // machine's timezone or the instant's UTC day. The clock is pinned because
    // `todayIso()` and the `Date` read below are separate instants.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-25T22:30:00Z'))
      const today = todayIso()
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      // It agrees with the Cairo calendar date of the same instant.
      const cairoDay = new Intl.DateTimeFormat('en-CA', {
        timeZone: STATION_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date())
      expect(today).toBe(cairoDay)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pins the business timezone to one IANA zone', () => {
    // A single constant, never a hardcoded offset.
    expect(STATION_TZ).toBe('Africa/Cairo')
  })
})

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

  it('reads today from the business calendar, not the machine or UTC', () => {
    // `todayIso` is the STATION business date, so it follows Cairo — not the
    // machine's own timezone and not the UTC day. The clock is pinned because
    // `todayIso()` and any later `Date` read are separate instants.
    vi.useFakeTimers()
    try {
      // 22:30 UTC on the 25th: still the 25th in New York, already the 26th in
      // Cairo. The business date must be the Cairo one, which is exactly the
      // behaviour a machine-local assertion could never pin down.
      vi.setSystemTime(new Date('2026-09-25T22:30:00Z'))
      expect(todayIso()).toBe('2026-09-26')

      // Earlier the same UTC day, Cairo is still on the 25th.
      vi.setSystemTime(new Date('2026-09-25T10:00:00Z'))
      expect(todayIso()).toBe('2026-09-25')
    } finally {
      vi.useRealTimers()
    }
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
    // 14:35 UTC is 17:35 in Cairo (EEST, UTC+3) — the screen must show the
    // business wall clock, not the stored UTC digits.
    const value = '2026-09-25T14:35:27Z'
    expect(formatTime(value, { timeFormat: '24h' })).toBe('17:35')
    expect(formatTime(value, { timeFormat: '12h', locale: 'en-US' })).toBe('5:35 PM')
    expect(formatTime(value, { timeFormat: '24h', showSeconds: true })).toBe('17:35:27')
    expect(formatDateTime(value, { timeFormat: '24h', locale: 'en-US' })).toBe('25/09/2026 17:35')
  })

  it('reacts to the latest global preferences', () => {
    updateDateSettings({ dateFormat: 'YYYY-MM-DD', timeFormat: '12h', showSeconds: true })
    expect(formatDateTime('2026-09-25T14:35:27Z', { locale: 'en-US' })).toBe(
      '2026-09-25 5:35:27 PM',
    )
  })

  it('splits a stamp into independent date and time parts', () => {
    expect(formatDateTimeParts('2026-09-25T14:35:27Z', { locale: 'en-US' })).toEqual({
      date: '25/09/2026',
      time: '17:35',
    })
    // A business date carries no time, so the composition has no time slot.
    expect(formatDateTimeParts('2026-09-25')).toEqual({ date: '25/09/2026', time: null })
    expect(formatDateTimeParts(null)).toBeNull()
    // The parts always agree with the single-string formatter.
    expect(formatDateTime('2026-09-25T14:35:27Z', { locale: 'en-US' })).toBe('25/09/2026 17:35')
  })

  it('splits long localized dates from their 12-hour time without merging', () => {
    const parts = formatDateTimeParts('2026-09-25T06:56:00Z', {
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
    expect(formatTime('2026-09-25T14:35:27Z', { settings: draft })).toBe('5:35 م')
    // The saved preferences are unchanged by rendering a draft.
    expect(formatDate('2026-09-25')).toBe('25/09/2026')
  })
})
