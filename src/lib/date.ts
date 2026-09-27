/**
 * Business-date and business-time helpers — the single place calendar dates
 * are parsed, built, stepped and rendered.
 *
 * Two distinct things live here, and they are deliberately kept apart:
 *
 * 1. **Business dates** (`YYYY-MM-DD` strings) — a shift day, an expense date, a
 *    report boundary. These are pure CALENDAR days, never instants. They are
 *    never turned into a `Date`, all arithmetic runs on UTC timestamps (no DST
 *    jumps), and all formatting is pinned to `timeZone: 'UTC'`, so `2026-09-22`
 *    stays `2026-09-22` on every machine.
 *
 * 2. **Instants** (a stored `created_at`/`opened_at`/…) — a point in time, stored
 *    by the backend as explicit UTC (`2026-09-25 14:30:00Z`). These are rendered
 *    in {@link STATION_TZ}, the Station business timezone, so the screen shows
 *    the real wall clock at the café. This mirrors exactly what the backend does
 *    when it prints a receipt, which is what keeps paper and screen in
 *    agreement.
 *
 * The browser's own timezone is never the business timezone: Station's business
 * timezone is fixed and centralized here, and in `time.rs` on the Rust side.
 *
 * Numerals are formatted with the Latin numbering system to match the rest of
 * the app (MoneyDisplay, invoice/date columns), while month and weekday names
 * follow the active locale.
 */

import { getDateSettings } from './formatting'
import i18n, { DEFAULT_LOCALE } from './i18n'

/** Days in the app are whole milliseconds — used only for UTC stepping. */
const DAY_MS = 86_400_000

/**
 * Station's business timezone.
 *
 * The single source of truth on the frontend, mirroring `time::BUSINESS_TZ` in
 * the Rust backend. An IANA zone (not `+03:00`) so Egypt's DST rule is honored
 * by the platform's timezone database.
 */
export const STATION_TZ = 'Africa/Cairo'

/**
 * Normalize a stored timestamp to an ISO-8601 UTC string suitable for
 * `Date.parse`, so an instant is never mistaken for local wall-clock time.
 *
 * Accepts the canonical explicit form (`...Z`), the legacy unmarked form, and
 * an explicit offset. Returns the input unchanged when it is not a recognized
 * timestamp, so callers can detect the failure rather than parse `NaN`.
 */
export function normalizeToUtcIso(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = value.trim()
  if (!text) return ''
  const sql = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text)
  if (!sql) return text
  // Look for a zone ONLY in the part after the time, so the date's own `-`
  // separators can never be mistaken for a UTC offset.
  const after = text.slice(sql[0].length)
  const hasZone = /^\s*(?:[Zz]|[+-]\d{2}:?\d{2})/.test(after)
  return `${sql[1]}-${sql[2]}-${sql[3]}T${sql[4]}:${sql[5]}:${sql[6] ?? '00'}${
    hasZone ? after.trim() : 'Z'
  }`
}

/**
 * Build a `Date` whose UTC components ARE the Station business wall clock.
 *
 * Excel date cells hold a timezone-neutral serial number, so a `Date` object
 * would be re-interpreted in whatever timezone the reader's machine uses. By
 * encoding the business wall clock as UTC components, the exported cell always
 * *reads* as the Station time it was generated at, on any machine.
 */
export function businessWallClockToDate(value: string): Date | null {
  const parts = parseStamp(value)
  if (!parts) return null
  return new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second),
  )
}

/**
 * The current Station business wall clock, as a `Date` for spreadsheet cells.
 * See {@link businessWallClockToDate} for why the wall clock is encoded as UTC.
 */
export function nowBusinessWallClock(): Date {
  return businessWallClockToDate(nowDbInstant()) ?? new Date()
}

/** The current instant in the canonical explicit-UTC storage format. */
export function nowDbInstant(): string {
  return `${new Date().toISOString().slice(0, 19).replace('T', ' ')}Z`
}

/** Wall-clock components of an instant, in Station business time. */
interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** Split an instant into business-time wall-clock components. */
function businessWallClock(instant: Date): WallClock | null {
  if (Number.isNaN(instant.getTime())) return null
  // `en-CA` yields ISO-ordered parts, so the fields can be read positionally
  // without depending on the runtime's locale data.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: STATION_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const hour = get('hour')
  return {
    year: get('year'),
    month: get('month'),
    // Intl renders midnight as 24 in some engines under hour12: false.
    day: get('day'),
    hour: hour === 24 ? 0 : hour,
    minute: get('minute'),
    second: get('second'),
  }
}

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

/**
 * Today's Station BUSINESS date.
 *
 * Derived from the instant in {@link STATION_TZ}, never from the browser's
 * local calendar. Using the browser date made the UI disagree with the backend
 * whenever the machine's timezone was not Cairo — and it disagrees with the OS
 * clock's own notion of the day if the machine is misconfigured.
 */
export function todayIso(): string {
  const wall = businessWallClock(new Date())
  return wall ? isoDate(wall.year, wall.month, wall.day) : isoDate(1970, 1, 1)
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

const MONTH_KEY = /^(\d{4})-(\d{2})$/

const MONTH_SHORT: Intl.DateTimeFormatOptions = {
  month: 'short',
  numberingSystem: 'latn',
  timeZone: 'UTC',
}

/**
 * A `YYYY-MM` month key rendered for a chart axis or a report table.
 *
 * The key is the stable identity of a month across years; the label is
 * presentation only. `short` drops the year for a dense axis (the tooltip and
 * the export always carry the full form, so a multi-year series stays
 * unambiguous there), and an unrecognised key is returned untouched rather than
 * rendered as "Invalid Date".
 */
export function formatMonthKey(
  monthKey: string,
  locale: string,
  { short = false }: { short?: boolean } = {},
): string {
  const parts = MONTH_KEY.exec(monthKey.trim())
  if (!parts) return monthKey
  const year = Number(parts[1])
  const month = Number(parts[2])
  if (month < 1 || month > 12) return monthKey
  if (short) {
    return formatter(locale, MONTH_SHORT).format(new Date(Date.UTC(year, month - 1, 1, 12)))
  }
  return formatMonthTitle(year, month, locale)
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

/**
 * Parse a display input into business-time wall-clock components.
 *
 * A value that carries a TIME is an INSTANT and is converted from UTC into
 * {@link STATION_TZ}. A value that is only `YYYY-MM-DD` is a BUSINESS DATE and
 * is taken at face value — never shifted, so `2026-09-25` always renders as the
 * 25th.
 */
function parseStamp(value: DisplayDateInput): ParsedStamp | null {
  if (value === null || value === undefined) return null
  // A `Date` or epoch number is already an instant.
  if (typeof value === 'number' || value instanceof Date) {
    const instant = value instanceof Date ? value : new Date(value)
    const wall = businessWallClock(instant)
    return wall ? { ...wall, hasTime: true } : null
  }
  const text = value.trim()
  if (!text) return null

  // An instant, as written by the backend: `YYYY-MM-DD[ T]HH:MM[:SS]` with an
  // optional `Z`/offset. Zone-less values are UTC, which is exactly what the
  // historical `datetime('now')` writer meant.
  const sql = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text)
  if (sql) {
    const year = Number(sql[1])
    const month = Number(sql[2])
    const day = Number(sql[3])
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
    // Normalize the separator and make the UTC zone explicit, so the platform
    // parser can never fall back to treating it as LOCAL time.
    const instant = new Date(normalizeToUtcIso(text))
    if (Number.isNaN(instant.getTime())) return null
    const wall = businessWallClock(instant)
    return wall ? { ...wall, hasTime: true } : null
  }

  // A pure business date: no time, no timezone, no conversion.
  const parts = parseIsoDate(text)
  if (parts) return { ...parts, hour: 0, minute: 0, second: 0, hasTime: false }
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
