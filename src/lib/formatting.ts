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

/**
 * How a worked DURATION is written on screen.
 *
 * This is a PRESENTATION choice about a value the backend already computed in
 * minutes. It is emphatically not a change to what is stored: an employee who
 * worked 485 minutes still has 485 minutes in `attendance_days`, and payroll,
 * reports and every calculation keep reading that number. Only the rendering
 * differs.
 *
 *  - `minutes` — the raw total: `485 د`. Exact, and what the column used to
 *    imply for a sub-hour day.
 *  - `hours` — an APPROXIMATE decimal number of hours: `8.1 س`, never
 *    `8س 06د`. The point of the mode is a single glance-readable figure, so the
 *    minute remainder is deliberately dropped rather than appended.
 */
export type WorkDurationDisplay = 'minutes' | 'hours'

export interface WorkDurationSettings {
  display: WorkDurationDisplay
}

export const WORK_DURATION_DISPLAY_OPTIONS: readonly WorkDurationDisplay[] = ['minutes', 'hours']

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
  /** How worked durations are written, edited in the same Dev Settings page. */
  workDuration: WorkDurationSettings
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
  // `hours`, not `minutes`, and deliberately so.
  //
  // The rule asked for a sensible default "based on the current behavior, so
  // existing installations do not unexpectedly change presentation". Before this
  // setting existed, Station rendered a worked duration as `8س 10د` — that is,
  // it was HOUR-LED, with the hour the prominent figure and the minutes a
  // trailing detail. `hours` preserves that: an existing café still reads its
  // hours column as a number of hours, just rounded to one decimal instead of
  // carrying a second figure. Choosing `minutes` would instead re-present a
  // familiar 8-hour day as the unfamiliar `485`, which is the larger surprise.
  workDuration: { display: 'hours' },
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

/**
 * An unrecognised or missing display mode falls back to the DEFAULT, never to a
 * hardcoded literal.
 *
 * The default is read from `DEFAULT_FORMATTING` rather than repeated, so the
 * "no stored value" path and the documented default can never disagree — which
 * is what makes an installation that predates this setting keep its behaviour
 * after the sanitizing round-trip that adds the key.
 */
function sanitizeWorkDurationDisplay(value: unknown): WorkDurationDisplay {
  return WORK_DURATION_DISPLAY_OPTIONS.includes(value as WorkDurationDisplay)
    ? (value as WorkDurationDisplay)
    : DEFAULT_FORMATTING.workDuration.display
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
  const workDuration = (
    typeof r.workDuration === 'object' && r.workDuration !== null ? r.workDuration : {}
  ) as Record<string, unknown>
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
    // An installation saved before this setting existed has no `workDuration`
    // key at all; the sanitizer supplies the default rather than the caller
    // having to migrate its stored blob.
    workDuration: { display: sanitizeWorkDurationDisplay(workDuration.display) },
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

/**
 * Replace ONLY the worked-duration display mode.
 *
 * A dedicated writer, for exactly the reason the chart colours have one: this
 * setting has its own card on the Dev Settings page with its own Save, so
 * committing a money/date draft must never drag along a stale duration mode —
 * and saving the duration must never roll back a money setting the user changed
 * a moment earlier. Sanitizing, persisting and notifying all still happen through
 * this one store, like every other writer here.
 */
export function setWorkDurationSettings(next: WorkDurationSettings): void {
  current = sanitizePreferences({ ...current, workDuration: next })
  persist()
  notify()
}

/** Reset ONLY the worked-duration display mode to the Station default. */
export function resetWorkDurationSettings(): void {
  setWorkDurationSettings({ display: DEFAULT_FORMATTING.workDuration.display })
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
 * roll a colour the user changed in another card back to an older value. The
 * worked-duration mode is preserved for the same reason — it has its own card
 * and its own Save, so it is never a passenger in this write.
 */
export function replaceFormattingPreferences(next: FormattingPreferences): void {
  current = sanitizePreferences({
    ...next,
    charts: current.charts,
    workDuration: current.workDuration,
  })
  persist()
  notify()
}

/**
 * Deep value equality — drives the Dev Settings dirty state.
 *
 * The chart colours and the worked-duration mode are settings of their own,
 * each with its own card, its own dirty state and its own writer, so neither is
 * compared here.
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

/**
 * The worked-duration display mode, reactively.
 *
 * Every duration consumer — the employee KPI, the roster column, the details
 * drawer and the personal attendance card — reads the mode through this hook
 * rather than importing the store directly, so the setting is subscribed in one
 * place and a change in Dev Settings repaints all of them at once.
 */
export function useWorkDurationSettings(): WorkDurationSettings {
  return useFormattingPreferences().workDuration
}
