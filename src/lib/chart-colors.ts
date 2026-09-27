/**
 * Chart bar colours — the ONE source of truth for every data mark a chart
 * draws, in every chart of the application.
 *
 * HOW IT WORKS
 * ------------
 * `colors.css` defines one custom property per role (`--chart-bar-primary`,
 * `--chart-bar-secondary`, …) in BOTH the light and the dark theme, each one
 * pointing at an existing semantic token. A chart therefore never hardcodes a
 * colour: it asks for a ROLE and gets `var(--chart-bar-<role>)` back.
 *
 * That indirection is what makes Dev Settings possible. Saving a colour writes
 * the value onto the same custom property on the document element
 * (`applyChartColorOverrides`), so a single write repaints every bar in the
 * application — with no per-chart logic, no re-render plumbing and no
 * chart-specific state. Clearing an override hands the property back to the
 * theme, so light and dark keep being the theme's decision.
 *
 * WHY ROLES AND NOT COLOURS
 * -------------------------
 * The roles are SEMANTIC, never chart-specific: there is no `washChartColor`
 * here, only "the second series colour". A new chart picks a role; it never
 * invents a palette. The four-step ramp (`CHART_BAR_TOKENS`) is the established
 * fallback for a chart with more series than roles — a tone repeats rather than
 * a colour being invented.
 *
 * FUTURE CHARTS: pass `chartBarColor('primary')` (or any other role) as a
 * series `color` / a bar's `background` and it is themed and Dev-Settings
 * controlled for free. Never write a hex, a `bg-*` class, or a raw palette
 * reference into a chart.
 */
import {
  CHART_COLOR_ROLES,
  type ChartColorRole,
  type ChartColorSettings,
} from '@/lib/chart-colors-types'

/**
 * Every role a chart can ask for, in the order Dev Settings lists them.
 * Re-exported so consumers have a single import for the whole colour system.
 */
export { CHART_COLOR_ROLES }

/** The custom property each role is painted through, defined in `colors.css`. */
export const CHART_COLOR_VARIABLES: Record<ChartColorRole, string> = {
  primary: '--chart-bar-primary',
  secondary: '--chart-bar-secondary',
  tertiary: '--chart-bar-tertiary',
  quaternary: '--chart-bar-quaternary',
  sales: '--chart-bar-sales',
  expenses: '--chart-bar-expenses',
  expensesMultiple: '--chart-bar-expenses-multiple',
}

/**
 * The saved defaults: every role simply follows the theme token it already
 * used before this system existed, so installing it changes no pixel. A
 * `var(--token)` value is a REFERENCE — it stays theme-aware; only a literal a
 * developer types in Dev Settings is a fixed value in both themes.
 */
export const DEFAULT_CHART_COLORS: ChartColorSettings = {
  primary: 'var(--primary)',
  secondary: 'var(--info)',
  tertiary: 'var(--warning)',
  quaternary: 'var(--success)',
  sales: 'var(--success)',
  expenses: 'var(--destructive)',
  // The companion of `expenses`, and deliberately NOT a status colour: red would
  // read as "something is wrong with this day", which is not what a day with
  // three ordinary expenses is. The Station brown is a related, calm tone that
  // is unmistakably not the expenses red and carries no error or warning
  // meaning — and because it is a role, a developer who wants another tone
  // repaints it in Dev Settings like any other.
  expensesMultiple: 'var(--primary)',
}

/** The CSS value a chart draws a role with: a reference, never a literal. */
export function chartBarColor(role: ChartColorRole): string {
  return `var(${CHART_COLOR_VARIABLES[role]})`
}

/**
 * The ordered ramp for a chart whose series count is not known in advance (the
 * expense categories are the real case). It is the SAME sequence the category
 * ranking has always used, so a category cannot be one colour in the ranking
 * and another in the chart.
 */
export const CHART_BAR_TOKENS: readonly string[] = [
  chartBarColor('primary'),
  chartBarColor('secondary'),
  chartBarColor('tertiary'),
  chartBarColor('quaternary'),
]

/** The ramp colour for the nth series of a chart with an open series count. */
export function chartBarColorAt(index: number): string {
  const size = CHART_BAR_TOKENS.length
  return CHART_BAR_TOKENS[((index % size) + size) % size]
}

/**
 * What a Dev Settings value may be: a hex literal, a reference to a theme
 * token, or empty (the theme's own colour). Anything else is refused rather
 * than painted, so a typo can never leave a chart with an invisible bar.
 */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const TOKEN = /^var\(--[a-zA-Z0-9_-]+\)$/

export function isChartColorValue(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === '' || HEX.test(trimmed) || TOKEN.test(trimmed)
}

/**
 * Merge unknown persisted data over the defaults; never throws.
 *
 * An absent, blank or malformed value falls back to the role's DEFAULT rather
 * than to an empty string: a blank field in Dev Settings means "follow the
 * theme", and the default IS the theme-following value, so storing `''` would
 * only add a second spelling of the same thing.
 */
export function sanitizeChartColors(raw: unknown): ChartColorSettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const pick = (role: ChartColorRole): string => {
    const value = typeof r[role] === 'string' ? r[role].trim() : ''
    return isChartColorValue(value) && value !== '' ? value : DEFAULT_CHART_COLORS[role]
  }
  return {
    primary: pick('primary'),
    secondary: pick('secondary'),
    tertiary: pick('tertiary'),
    quaternary: pick('quaternary'),
    sales: pick('sales'),
    expenses: pick('expenses'),
    expensesMultiple: pick('expensesMultiple'),
  }
}

/** Deep value equality — drives the Dev Settings dirty state. */

/** Only ever a neutral placeholder for a colour that cannot be resolved. */
const DEFAULT_HEX_FALLBACK = '#96673a'

function toHex(value: string): string | null {
  const text = value.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(text)) {
    return `#${text
      .slice(1)
      .split('')
      .map((char) => char + char)
      .join('')}`.toLowerCase()
  }
  return null
}

/**
 * The literal colour a value currently paints as, for a swatch or a preview.
 *
 * A reference is read out of the LIVE document, so a Dev Settings swatch shows
 * the colour the chart really draws in the current theme, and a value that
 * cannot be resolved degrades to the role's own default rather than to black.
 */
export function resolveChartColor(value: string, role?: ChartColorRole): string {
  const token = /^var\((--[^)]+)\)$/.exec(value.trim())?.[1]
  if (!token) return toHex(value) ?? DEFAULT_HEX_FALLBACK
  if (typeof document === 'undefined') return DEFAULT_HEX_FALLBACK
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  return (
    toHex(resolved) ??
    (role ? toHex(resolveChartColor(DEFAULT_CHART_COLORS[role])) : null) ??
    DEFAULT_HEX_FALLBACK
  )
}

/**
 * Publish the saved colours onto the document.
 *
 * Called by the central settings store whenever the preferences it holds are
 * published — never by a chart. A value that is empty or identical to the
 * default REMOVES the inline property, so the theme's own light/dark value
 * takes over again: that is what makes "back to the system colour" a real reset
 * rather than a frozen copy of today's colour.
 */
export function applyChartColorOverrides(settings: ChartColorSettings): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const role of CHART_COLOR_ROLES) {
    const property = CHART_COLOR_VARIABLES[role]
    const value = settings[role]?.trim() ?? ''
    if (value === '' || value === DEFAULT_CHART_COLORS[role]) root.style.removeProperty(property)
    else root.style.setProperty(property, value)
  }
}

export function chartColorsEqual(a: ChartColorSettings, b: ChartColorSettings): boolean {
  return CHART_COLOR_ROLES.every((role) => a[role] === b[role])
}
