/**
 * Central formatting preferences — the single source of truth for all
 * screen display formatting (money + date/time).
 *
 * - Only plain serializable values are persisted (never Intl instances).
 * - Persistence goes through this module only (one localStorage key).
 * - Reactivity is via a tiny subscribe/notify store + useSyncExternalStore,
 *   so Dev Settings changes re-render every subscriber immediately.
 * - Money/date formatters read this store; components never pass settings
 *   around manually.
 */

import { useSyncExternalStore } from 'react'

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
  for (const fn of listeners) fn()
}

export function getFormattingPreferences(): FormattingPreferences {
  return current
}

export function getMoneySettings(): MoneyFormatSettings {
  return current.money
}

export function getDateSettings(): DateFormatSettings {
  return current.date
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

/** Replace the whole saved configuration in one write (Dev Settings "Save"). */
export function replaceFormattingPreferences(next: FormattingPreferences): void {
  current = sanitizePreferences(next)
  persist()
  notify()
}

/** Deep value equality — drives the Dev Settings dirty state. */
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
