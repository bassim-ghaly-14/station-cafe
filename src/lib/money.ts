import { MINOR_PER_MAJOR } from './utils'
import { getMoneySettings, type MoneyFormatSettings } from './formatting'

/** The one human-readable currency label used throughout Station. */
export const CURRENCY_LABEL = 'ج.م'

export type MoneyInput = number | string | null | undefined

/** Semantic variant: `full` exact, `compact` abbreviated, `auto` follows global. */
export type MoneyVariant = 'full' | 'compact' | 'auto'

export type MoneyFormatOptions = {
  showCurrency?: boolean
  variant?: MoneyVariant
  /**
   * Render against an explicit configuration instead of the saved one.
   * Only the Dev Settings preview uses this — the application always reads
   * the saved preferences.
   */
  settings?: MoneyFormatSettings
}

export type MinorMoneyFormatOptions = MoneyFormatOptions & {
  compact?: boolean
}

const numberCache = new Map<string, Intl.NumberFormat>()

const MAGNITUDES = [
  { value: 1_000_000_000_000, singular: 'تريليون', plural: 'تريليونات' },
  { value: 1_000_000_000, singular: 'مليار', plural: 'مليارات' },
  { value: 1_000_000, singular: 'مليون', plural: 'ملايين' },
  { value: 1_000, singular: 'ألف', plural: 'آلاف' },
] as const

function normalize(value: MoneyInput): number | null {
  if (value === null || value === undefined) return null
  const normalized = typeof value === 'string' ? value.trim().replaceAll(',', '') : value
  if (normalized === '') return null
  const number = typeof normalized === 'number' ? normalized : Number(normalized)
  return Number.isFinite(number) ? number : null
}

function withCurrency(
  value: string,
  show: boolean | undefined,
  position: string,
  settings: MoneyFormatSettings,
): string {
  const visible = show ?? settings.showCurrency
  if (!visible) return value
  return position === 'before' ? `${CURRENCY_LABEL} ${value}` : `${value} ${CURRENCY_LABEL}`
}

function resolveVariant(
  variant: MoneyVariant | undefined,
  legacy: boolean | undefined,
): MoneyVariant {
  if (variant) return variant
  if (legacy) return 'compact'
  return 'full'
}

/** Cached full-precision formatter keyed by serializable prefs only. */
function fullFormatter(decimals: number, grouping: boolean): Intl.NumberFormat {
  const key = `full|${decimals}|${grouping}`
  const cached = numberCache.get(key)
  if (cached) return cached
  const created = new Intl.NumberFormat('en-US', {
    useGrouping: grouping,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  numberCache.set(key, created)
  return created
}

function compactScaledFormatter(): Intl.NumberFormat {
  const key = 'compact-scaled'
  const cached = numberCache.get(key)
  if (cached) return cached
  const created = new Intl.NumberFormat('en-US', {
    useGrouping: true,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })
  numberCache.set(key, created)
  return created
}

function formatCompactValue(number: number, settings: MoneyFormatSettings): string {
  const absolute = Math.abs(number)
  const threshold = settings.compactThreshold
  const magnitudes = MAGNITUDES.filter(({ value }) => value >= threshold)
  const magnitude = magnitudes.find(({ value: floor }) => absolute >= floor)
  if (!magnitude) {
    return fullFormatter(settings.decimalPlaces, settings.useThousandsSeparator).format(number)
  }
  const scaled = number / magnitude.value
  const wholeUnits = Math.floor(Math.abs(scaled))
  const unit = wholeUnits >= 3 && wholeUnits <= 10 ? magnitude.plural : magnitude.singular
  return `${compactScaledFormatter().format(scaled)} ${unit}`
}

/** Test seam: drop cached Intl instances. */
export function __clearMoneyFormatterCache(): void {
  numberCache.clear()
}

/** Format major-unit EGP. Default `full` exact; `compact`/`auto` for summaries. */
export function formatMoney(
  value: MoneyInput,
  { showCurrency, variant, settings }: MoneyFormatOptions = {},
): string {
  const number = normalize(value)
  if (number === null) return '—'
  const s = settings ?? getMoneySettings()
  const v = resolveVariant(variant, undefined)
  if (v === 'compact') {
    return withCurrency(formatCompactValue(number, s), showCurrency, s.currencyPosition, s)
  }
  if (v === 'auto' && s.compactLargeValues && Math.abs(number) >= s.compactThreshold) {
    return withCurrency(formatCompactValue(number, s), showCurrency, s.currencyPosition, s)
  }
  return withCurrency(
    fullFormatter(s.decimalPlaces, s.useThousandsSeparator).format(number),
    showCurrency,
    s.currencyPosition,
    s,
  )
}

/** Explicit compact rendering (ignores the compact on/off switch, honours the threshold). */
export function formatCompactMoney(
  value: MoneyInput,
  { showCurrency, settings }: MoneyFormatOptions = {},
): string {
  const number = normalize(value)
  if (number === null) return '—'
  const s = settings ?? getMoneySettings()
  return withCurrency(formatCompactValue(number, s), showCurrency, s.currencyPosition, s)
}

/**
 * Format an API/domain value stored in piasters. This adapter prevents pages from
 * accidentally treating a stored amount as pounds; it never mutates the value.
 */
export function formatMinorMoney(
  value: MoneyInput,
  { compact = false, showCurrency, variant, settings }: MinorMoneyFormatOptions = {},
): string {
  const number = normalize(value)
  if (number === null) return '—'
  const major = number / MINOR_PER_MAJOR
  return formatMoney(major, {
    showCurrency,
    variant: resolveVariant(variant, compact),
    settings,
  })
}

/** Format a major-unit value for an editable money field. */
export function formatMoneyInput(value: MoneyInput): string {
  const number = normalize(value)
  if (number === null) return ''
  const s = getMoneySettings()
  return fullFormatter(s.decimalPlaces, s.useThousandsSeparator).format(number)
}

/** Format an API/domain minor-unit value for an editable money field. */
export function formatMinorMoneyInput(value: MoneyInput): string {
  const number = normalize(value)
  return number === null ? '' : formatMoneyInput(number / MINOR_PER_MAJOR)
}
