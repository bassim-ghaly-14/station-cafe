/**
 * Business-date helpers — the single place calendar dates are parsed, built,
 * stepped and rendered.
 *
 * A business date (a shift day, an expense date, a report boundary) must mean
 * the exact same calendar day on every machine, so business dates are plain
 * `YYYY-MM-DD` strings and are never turned into a *local* `Date`. All internal
 * math runs on UTC timestamps (which have no DST jumps) and all formatting is
 * pinned to `timeZone: 'UTC'`, so `2026-09-22` stays `2026-09-22` everywhere.
 *
 * Numerals are formatted with the Latin numbering system to match the rest of
 * the app (MoneyDisplay, invoice/date columns), while month and weekday names
 * follow the active locale.
 */

/** Days in the app are whole milliseconds — used only for UTC stepping. */
const DAY_MS = 86_400_000

export interface CalendarDate {
  year: number
  /** 1 = January … 12 = December (ISO, not the JS 0-based month). */
  month: number
  day: number
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Parse `YYYY-MM-DD` strictly. Returns null for anything else. */
export function parseIsoDate(value: string): CalendarDate | null {
  const m = ISO_DATE.exec(value)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

/** Build the API/DB representation of a business date. */
export function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Gregorian month length (UTC based, so leap years are exact). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Shift a year/month pair by whole months (December → January safe). */
export function addMonths(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta
  return { year: Math.floor(total / 12), month: (total % 12) + 1 }
}

/** Today as the user's *local* calendar date (never the UTC-shifted day). */
export function todayIso(): string {
  const now = new Date()
  return isoDate(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

/** Step a business date by whole days (UTC based, so no DST drift). */
export function addDays(value: string, delta: number): string {
  const parts = parseIsoDate(value)
  if (!parts) return value
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + delta * DAY_MS)
  return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

/** Weekday index of a date: 0 = Sunday … 6 = Saturday (UTC based). */
function weekdayIndex(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/** First day of the week for a locale: Arabic calendars start on Saturday. */
export function weekStartIndex(locale: string): number {
  return locale.startsWith('ar') ? 6 : 0
}

export interface MonthCell {
  iso: string
  day: number
  /** False for the adjacent-month days that pad the grid. */
  inMonth: boolean
}

/** A month as six full weeks (42 cells), so the grid height never jumps. */
export function monthCells(year: number, month: number, weekStart: number): MonthCell[] {
  const lead = (weekdayIndex(year, month, 1) - weekStart + 7) % 7
  const first = Date.UTC(year, month - 1, 1) - lead * DAY_MS
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(first + i * DAY_MS)
    const y = d.getUTCFullYear()
    const m = d.getUTCMonth() + 1
    const day = d.getUTCDate()
    return { iso: isoDate(y, m, day), day, inMonth: y === year && m === month }
  })
}

// Formatters are not cheap; the calendar asks for the same ones ~45× per render.
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`
  const cached = formatters.get(key)
  if (cached) return cached
  const created = new Intl.DateTimeFormat(locale, options)
  formatters.set(key, created)
  return created
}

const DATE_SHORT: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  numberingSystem: 'latn',
  timeZone: 'UTC',
}

const DATE_LONG: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  numberingSystem: 'latn',
  timeZone: 'UTC',
}

const MONTH_LONG: Intl.DateTimeFormatOptions = {
  month: 'long',
  year: 'numeric',
  numberingSystem: 'latn',
  timeZone: 'UTC',
}

const WEEKDAY_SHORT: Intl.DateTimeFormatOptions = { weekday: 'short', timeZone: 'UTC' }

function utcNoon(parts: CalendarDate): Date {
  // Noon UTC keeps the date unambiguous for any formatter timezone width.
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12))
}

/** Human-friendly date for the active locale, e.g. `22 سبتمبر 2026` / `Sep 22, 2026`. */
export function formatIsoDate(value: string, locale: string): string {
  const parts = parseIsoDate(value)
  return parts ? formatter(locale, DATE_SHORT).format(utcNoon(parts)) : value
}

/** Spoken date (includes the weekday) for accessible labels. */
export function formatIsoDateLong(value: string, locale: string): string {
  const parts = parseIsoDate(value)
  return parts ? formatter(locale, DATE_LONG).format(utcNoon(parts)) : value
}

/** Calendar header title, e.g. `سبتمبر 2026`. */
export function formatMonthTitle(year: number, month: number, locale: string): string {
  return formatter(locale, MONTH_LONG).format(new Date(Date.UTC(year, month - 1, 1, 12)))
}

/** Short weekday names in grid order, starting on the locale's first day. */
export function weekdayLabels(locale: string, weekStart: number): string[] {
  const f = formatter(locale, WEEKDAY_SHORT)
  // 2026-01-04 is a Sunday — a fixed UTC reference week.
  return Array.from({ length: 7 }, (_, i) =>
    f.format(new Date(Date.UTC(2026, 0, 4 + ((weekStart + i) % 7)))),
  )
}
