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

import { getDateSettings } from './formatting'
import i18n, { DEFAULT_LOCALE } from './i18n'

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
export type DisplayDateInput = string | Date | number | null | undefined

export interface DisplayFormatOptions {
  locale?: string
  dateFormat?: import('./formatting').DateFormatId
  timeFormat?: '12h' | '24h'
  showSeconds?: boolean
  /**
   * Render against an explicit configuration instead of the saved one.
   * Only the Dev Settings preview uses this — the application always reads
   * the saved preferences.
   */
  settings?: import('./formatting').DateFormatSettings
}

interface ParsedStamp {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  hasTime: boolean
}

function parseStamp(value: DisplayDateInput): ParsedStamp | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return null
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
      hasTime: true,
    }
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return {
      year: value.getFullYear(),
      month: value.getMonth() + 1,
      day: value.getDate(),
      hour: value.getHours(),
      minute: value.getMinutes(),
      second: value.getSeconds(),
      hasTime: true,
    }
  }
  const text = value.trim()
  if (!text) return null
  const sql = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text)
  if (sql) {
    const year = Number(sql[1])
    const month = Number(sql[2])
    const day = Number(sql[3])
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
    return {
      year,
      month,
      day,
      hour: Number(sql[4]),
      minute: Number(sql[5]),
      second: Number(sql[6] ?? '0'),
      hasTime: true,
    }
  }
  const parts = parseIsoDate(text.slice(0, 10))
  if (parts && text.length <= 10) {
    return { ...parts, hour: 0, minute: 0, second: 0, hasTime: false }
  }
  return null
}
function activeLocale(explicit?: string): string {
  if (explicit) return explicit
  try {
    const lang = i18n.language
    if (typeof lang === 'string' && lang) return lang
  } catch {
    /* fall through to default */
  }
  return DEFAULT_LOCALE
}

function shortMonthName(year: number, month: number, locale: string): string {
  return formatter(locale, {
    month: 'short',
    numberingSystem: 'latn',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1, 12)))
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
function renderDisplayDate(
  p: ParsedStamp,
  format: import('./formatting').DateFormatId,
  locale: string,
): string {
  const y = String(p.year).padStart(4, '0')
  const m = pad2(p.month)
  const d = pad2(p.day)
  if (format === 'MM/DD/YYYY') return `${m}/${d}/${y}`
  if (format === 'YYYY-MM-DD') return `${y}-${m}-${d}`
  if (format === 'DD-MM-YYYY') return `${d}-${m}-${y}`
  if (format === 'DD MMM YYYY') return `${d} ${shortMonthName(p.year, p.month, locale)} ${y}`
  if (format === 'MMM DD, YYYY') return `${shortMonthName(p.year, p.month, locale)} ${d}, ${y}`
  return `${d}/${m}/${y}`
}

function renderDisplayTime(
  p: ParsedStamp,
  timeFormat: '12h' | '24h',
  showSeconds: boolean,
  locale: string,
): string {
  if (timeFormat === '24h') {
    const base = `${pad2(p.hour)}:${pad2(p.minute)}`
    return showSeconds ? `${base}:${pad2(p.second)}` : base
  }
  const key = `${locale}|12h|${showSeconds}`
  let f = formatters.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: '2-digit',
      ...(showSeconds ? { second: '2-digit' as const } : {}),
      hour12: true,
      numberingSystem: 'latn',
    })
    formatters.set(key, f)
  }
  return f.format(new Date(2026, 0, 1, p.hour, p.minute, p.second))
}

/** The date and time of one stamp rendered separately, for composable layouts. */
export interface DateTimeParts {
  date: string
  /** Null when the source value carried no time component. */
  time: string | null
}

function resolveDateOptions(options: DisplayFormatOptions) {
  const prefs = options.settings ?? getDateSettings()
  return {
    dateFormat: options.dateFormat ?? prefs.dateFormat,
    timeFormat: options.timeFormat ?? prefs.timeFormat,
    showSeconds: options.showSeconds ?? prefs.showSeconds,
    locale: activeLocale(options.locale),
  }
}

function parseForDisplay(value: DisplayDateInput): ParsedStamp | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  return parseStamp(value)
}

/** The date and time of one stamp, each already formatted. */
export function formatDateTimeParts(
  value: DisplayDateInput,
  options: DisplayFormatOptions = {},
): DateTimeParts | null {
  const parsed = parseForDisplay(value)
  if (!parsed) return null
  const { dateFormat, timeFormat, showSeconds, locale } = resolveDateOptions(options)
  return {
    date: renderDisplayDate(parsed, dateFormat, locale),
    time: parsed.hasTime ? renderDisplayTime(parsed, timeFormat, showSeconds, locale) : null,
  }
}

/** Central date formatter (ISO / SQLite / Date → display date). */
export function formatDate(value: DisplayDateInput, options: DisplayFormatOptions = {}): string {
  const parsed = parseForDisplay(value)
  if (!parsed) return typeof value === 'string' && value.trim() !== '' ? value : '—'
  const { dateFormat, locale } = resolveDateOptions(options)
  return renderDisplayDate(parsed, dateFormat, locale)
}

/** Central time formatter (`14:35` / `2:35 م` depending on prefs). */
export function formatTime(value: DisplayDateInput, options: DisplayFormatOptions = {}): string {
  const parsed = parseForDisplay(value)
  if (!parsed) return typeof value === 'string' && value.trim() !== '' ? value : '—'
  const { timeFormat, showSeconds, locale } = resolveDateOptions(options)
  return renderDisplayTime(parsed, timeFormat, showSeconds, locale)
}

/**
 * Central date+time formatter. Prefer `formatDateTimeParts` + `DisplayDateTime`
 * in layouts that need to control the date and time independently — a single
 * string cannot be laid out without depending on where punctuation lands.
 */
export function formatDateTime(
  value: DisplayDateInput,
  options: DisplayFormatOptions = {},
): string {
  const parts = formatDateTimeParts(value, options)
  if (parts) return parts.time ? `${parts.date} ${parts.time}` : parts.date
  return typeof value === 'string' && value.trim() !== '' ? value : '—'
}

/** Test seam: drop cached Intl instances. */
export function __clearDateFormatterCache(): void {
  formatters.clear()
}
