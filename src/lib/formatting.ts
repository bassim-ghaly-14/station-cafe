/**
 * Central display preferences — the single source of truth for all
 * screen display formatting (money + date/time) AND for the chart bar colours.
 *
 * - Only plain serializable values are persisted (never Intl instances).
 * - Persistence goes through this module only (one localStorage key).
 * - Reactivity is via a tiny subscribe/notify store + useSyncExternalStore,
 *   so Dev Settings changes re-render every subscriber immediately.
 * - Money/date formatters read this store; components never pass settings
 *   around manually.
 * - The chart colours are published the same way, except that they are also
 *   written onto the DOCUMENT (the `--chart-bar-*` custom properties) because
 *   every chart already paints through them. That is why one Dev Settings save
 *   repaints every chart without a single chart re-rendering or knowing about
 *   settings; see `lib/chart-colors.ts`.
 */

import { useSyncExternalStore } from 'react'
import {
  DEFAULT_CHART_COLORS,
  applyChartColorOverrides,
  sanitizeChartColors,
} from '@/lib/chart-colors'
import type { ChartColorSettings } from '@/lib/chart-colors-types'

export type CurrencyPosition = 'after' | 'before'

export interface MoneyFormatSettings {
  currency: 'EGP'
  decimalPlaces: 0 | 1 | 2
  useThousandsSeparator: boolean
  showCurrency: boolean
  currencyPosition: CurrencyPosition
  compactLargeValues: boolean
  compactThreshold: number
}

export type DateFormatId =
  'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'DD-MM-YYYY' | 'DD MMM YYYY' | 'MMM DD, YYYY'

export type TimeFormatId = '12h' | '24h'

export interface DateFormatSettings {
  dateFormat: DateFormatId
  timeFormat: TimeFormatId
  showSeconds: boolean
}

export interface FormattingPreferences {
  money: MoneyFormatSettings
  date: DateFormatSettings
  /** The centralized chart bar colours, edited in the same Dev Settings page. */
  charts: ChartColorSettings
}

export const FORMATTING_STORAGE_KEY = 'station.formatting.preferences.v1'

export const DEFAULT_FORMATTING: FormattingPreferences = {
  money: {
    currency: 'EGP',
    decimalPlaces: 2,
    useThousandsSeparator: true,
    showCurrency: true,
    currencyPosition: 'after',
    compactLargeValues: true,
    compactThreshold: 1000,
  },
  date: {
    dateFormat: 'DD/MM/YYYY',
    timeFormat: '24h',
    showSeconds: false,
  },
  charts: DEFAULT_CHART_COLORS,
}

export const DATE_FORMAT_OPTIONS: DateFormatId[] = [
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'YYYY-MM-DD',
  'DD-MM-YYYY',
  'DD MMM YYYY',
  'MMM DD, YYYY',
]

export const COMPACT_THRESHOLD_OPTIONS = [1000, 10_000, 100_000, 1_000_000]

function sanitizeDecimal(value: unknown): 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2 ? value : 2
}

function sanitizeThreshold(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1000 ? value : 1000
}

function sanitizeDateFormat(value: unknown): DateFormatId {
  return DATE_FORMAT_OPTIONS.includes(value as DateFormatId)
    ? (value as DateFormatId)
    : 'DD/MM/YYYY'
}

/** Merge unknown persisted data over defaults; never throws. */
export function sanitizePreferences(raw: unknown): FormattingPreferences {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const money = (typeof r.money === 'object' && r.money !== null ? r.money : {}) as Record<
    string,
    unknown
  >
  const date = (typeof r.date === 'object' && r.date !== null ? r.date : {}) as Record<
    string,
    unknown
  >
  return {
    money: {
      currency: 'EGP',
      decimalPlaces: sanitizeDecimal(money.decimalPlaces),
      useThousandsSeparator: money.useThousandsSeparator !== false,
      showCurrency: money.showCurrency !== false,
      currencyPosition: money.currencyPosition === 'before' ? 'before' : 'after',
      compactLargeValues: money.compactLargeValues !== false,
      compactThreshold: sanitizeThreshold(money.compactThreshold),
    },
    date: {
      dateFormat: sanitizeDateFormat(date.dateFormat),
      timeFormat: date.timeFormat === '12h' ? '12h' : '24h',
      showSeconds: date.showSeconds === true,
    },
    // Chart colours are sanitized by their own module — one validator for one
    // configuration, wherever it is written.
    charts: sanitizeChartColors(r.charts),
  }
}

function loadInitial(): FormattingPreferences {
  try {
    const raw = localStorage.getItem(FORMATTING_STORAGE_KEY)
    if (!raw) return structuredClone(DEFAULT_FORMATTING)
    return sanitizePreferences(JSON.parse(raw))
  } catch {
    return structuredClone(DEFAULT_FORMATTING)
  }
}

let current: FormattingPreferences = loadInitial()
const listeners = new Set<() => void>()

function persist() {
  try {
    localStorage.setItem(FORMATTING_STORAGE_KEY, JSON.stringify(current))
  } catch {
    /* storage full/blocked — settings still apply for this session */
  }
}

function notify() {
  // Publishing a preference is also applying it. The chart colours are the one
  // setting the application reads from the DOCUMENT rather than from a
  // formatter, so they are written here — once, by the store — instead of by
  // each chart.
  applyChartColorOverrides(current.charts)
  for (const fn of listeners) fn()
}

// The saved colours are already in effect at startup, before the first render,
// exactly like the money and date formats that read `current` at call time.
applyChartColorOverrides(current.charts)

export function getFormattingPreferences(): FormattingPreferences {
  return current
}

export function getMoneySettings(): MoneyFormatSettings {
  return current.money
}

export function getDateSettings(): DateFormatSettings {
  return current.date
}

export function getChartColorSettings(): ChartColorSettings {
  return current.charts
}

export function subscribeFormatting(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Replace parts of the preferences ( Dev Settings writes through here ). */
export function setFormattingPreferences(patch: {
  money?: Partial<MoneyFormatSettings>
  date?: Partial<DateFormatSettings>
}): void {
  current = sanitizePreferences({
    money: { ...current.money, ...patch.money },
    date: { ...current.date, ...patch.date },
  })
  persist()
  notify()
}

export function updateMoneySettings(patch: Partial<MoneyFormatSettings>): void {
  setFormattingPreferences({ money: patch })
}

export function updateDateSettings(patch: Partial<DateFormatSettings>): void {
  setFormattingPreferences({ date: patch })
}

/**
 * Replace ONLY the chart colours.
 *
 * A dedicated writer, not a whole-preferences write, so the Dev Settings colour
 * card can never carry a stale money/date draft back over those settings (and
 * vice versa). The sanitizing, persisting and DOM publishing all still happen
 * through this one store.
 */
export function setChartColorSettings(next: ChartColorSettings): void {
  current = sanitizePreferences({ ...current, charts: next })
  persist()
  notify()
}

/** Reset ONLY the chart colours to the theme's own values. */
export function resetChartColorSettings(): void {
  setChartColorSettings(structuredClone(DEFAULT_CHART_COLORS))
}

/** Reset ONLY formatting preferences (never unrelated settings). */
export function resetFormattingPreferences(): void {
  current = structuredClone(DEFAULT_FORMATTING)
  persist()
  notify()
}

/** Reload from storage (used by tests to simulate an app restart). */
export function reloadFormattingPreferences(): FormattingPreferences {
  current = loadInitial()
  notify()
  return current
}

/** A detached copy of the Station defaults (never the frozen shared object). */
export function defaultFormattingPreferences(): FormattingPreferences {
  return structuredClone(DEFAULT_FORMATTING)
}

/** A detached copy of whatever is currently saved. */
export function cloneFormattingPreferences(source?: FormattingPreferences): FormattingPreferences {
  return structuredClone(source ?? current)
}

/**
 * Replace the whole saved configuration in one write (Dev Settings "Save").
 *
 * The chart colours are deliberately NOT taken from `next`: they are written
 * only through `setChartColorSettings`, so saving a money/date draft can never
 * roll a colour the user changed in another card back to an older value.
 */
export function replaceFormattingPreferences(next: FormattingPreferences): void {
  current = sanitizePreferences({ ...next, charts: current.charts })
  persist()
  notify()
}

/**
 * Deep value equality — drives the Dev Settings dirty state.
 *
 * Money and date only: the chart colours are a setting of their own with their
 * own card, their own dirty state and their own writer.
 */
export function formattingPreferencesEqual(
  a: FormattingPreferences,
  b: FormattingPreferences,
): boolean {
  return (
    a.money.decimalPlaces === b.money.decimalPlaces &&
    a.money.useThousandsSeparator === b.money.useThousandsSeparator &&
    a.money.showCurrency === b.money.showCurrency &&
    a.money.currencyPosition === b.money.currencyPosition &&
    a.money.compactLargeValues === b.money.compactLargeValues &&
    a.money.compactThreshold === b.money.compactThreshold &&
    a.date.dateFormat === b.date.dateFormat &&
    a.date.timeFormat === b.date.timeFormat &&
    a.date.showSeconds === b.date.showSeconds
  )
}

/** Reactive hook — re-renders the caller the moment any preference changes. */
export function useFormattingPreferences(): FormattingPreferences {
  return useSyncExternalStore(subscribeFormatting, getFormattingPreferences)
}

export function useMoneySettings(): MoneyFormatSettings {
  return useFormattingPreferences().money
}

export function useDateSettings(): DateFormatSettings {
  return useFormattingPreferences().date
}
