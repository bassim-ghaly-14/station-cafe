/**
 * The centralized chart colour system.
 *
 * What is proved here is the CONTRACT, not the look: a chart asks for a role, a
 * role paints through one custom property, and saving a colour in the settings
 * store publishes that colour onto that property — which is the only reason one
 * Dev Settings screen can reach every chart in the application.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHART_BAR_TOKENS,
  CHART_COLOR_ROLES,
  CHART_COLOR_VARIABLES,
  DEFAULT_CHART_COLORS,
  applyChartColorOverrides,
  chartBarColor,
  chartBarColorAt,
  chartColorsEqual,
  isChartColorValue,
  resolveChartColor,
  sanitizeChartColors,
} from './chart-colors'
import {
  getChartColorSettings,
  reloadFormattingPreferences,
  resetChartColorSettings,
  setChartColorSettings,
} from './formatting'

function clearOverrides() {
  for (const role of CHART_COLOR_ROLES) {
    document.documentElement.style.removeProperty(CHART_COLOR_VARIABLES[role])
  }
}

afterEach(() => {
  resetChartColorSettings()
  clearOverrides()
})

describe('the roles', () => {
  it('are semantic names, each painting through its own custom property', () => {
    expect(CHART_COLOR_ROLES).toEqual([
      'primary',
      'secondary',
      'tertiary',
      'quaternary',
      'sales',
      'expenses',
      'expensesMultiple',
    ])
    expect(chartBarColor('primary')).toBe('var(--chart-bar-primary)')
    expect(chartBarColor('expenses')).toBe('var(--chart-bar-expenses)')
    // The multi-expense day is a SIBLING role of `expenses`, not a chart name and
    // not a literal: it is repainted from the same Dev Settings card as the rest.
    expect(chartBarColor('expensesMultiple')).toBe('var(--chart-bar-expenses-multiple)')
    expect(CHART_COLOR_VARIABLES.expensesMultiple).toBe('--chart-bar-expenses-multiple')
  })

  it('default to the tokens the charts used before, so nothing changes visually', () => {
    expect(DEFAULT_CHART_COLORS).toEqual({
      primary: 'var(--primary)',
      secondary: 'var(--info)',
      tertiary: 'var(--warning)',
      quaternary: 'var(--success)',
      sales: 'var(--success)',
      expenses: 'var(--destructive)',
      expensesMultiple: 'var(--primary)',
    })
    // A default is a REFERENCE, which is what keeps light and dark mode working.
    expect(Object.values(DEFAULT_CHART_COLORS).every((value) => value.startsWith('var(--'))).toBe(
      true,
    )
  })

  it('cycle for a chart with more series than roles, repeating rather than inventing', () => {
    expect(CHART_BAR_TOKENS).toHaveLength(4)
    expect(chartBarColorAt(0)).toBe(chartBarColor('primary'))
    expect(chartBarColorAt(4)).toBe(chartBarColor('primary'))
    expect(chartBarColorAt(5)).toBe(chartBarColor('secondary'))
    // A negative index is still a real role rather than `undefined`.
    expect(chartBarColorAt(-1)).toBe(chartBarColor('quaternary'))
  })
})

describe('validation', () => {
  it('accepts a hex, a token reference, or the blank "follow the theme" value', () => {
    expect(isChartColorValue('#fff')).toBe(true)
    expect(isChartColorValue('#B07F47')).toBe(true)
    expect(isChartColorValue('var(--info)')).toBe(true)
    expect(isChartColorValue('')).toBe(true)
  })

  it('refuses anything a browser could not paint, rather than saving it', () => {
    expect(isChartColorValue('blue')).toBe(false)
    expect(isChartColorValue('#12345')).toBe(false)
    expect(isChartColorValue('rgb(1,2,3)')).toBe(false)
  })

  it('falls back to the role default for a missing, blank or malformed value', () => {
    expect(sanitizeChartColors(undefined)).toEqual(DEFAULT_CHART_COLORS)
    expect(sanitizeChartColors({ primary: '', secondary: 'nonsense' })).toEqual(
      DEFAULT_CHART_COLORS,
    )
    expect(sanitizeChartColors({ primary: '#123456' }).primary).toBe('#123456')
  })
})

describe('publishing', () => {
  it('writes a saved colour onto the role property, so every chart follows at once', () => {
    applyChartColorOverrides({ ...DEFAULT_CHART_COLORS, primary: '#ff0000' })

    expect(document.documentElement.style.getPropertyValue('--chart-bar-primary')).toBe('#ff0000')
    // The roles nobody changed are left to the theme.
    expect(document.documentElement.style.getPropertyValue('--chart-bar-secondary')).toBe('')
  })

  it('removes the property again on reset, handing the role back to the theme', () => {
    applyChartColorOverrides({ ...DEFAULT_CHART_COLORS, primary: '#ff0000' })
    applyChartColorOverrides(DEFAULT_CHART_COLORS)

    expect(document.documentElement.style.getPropertyValue('--chart-bar-primary')).toBe('')
  })

  it('is driven by the settings store itself, not by a chart', () => {
    setChartColorSettings({ ...DEFAULT_CHART_COLORS, primary: '#00ff00' })

    expect(getChartColorSettings().primary).toBe('#00ff00')
    expect(document.documentElement.style.getPropertyValue('--chart-bar-primary')).toBe('#00ff00')

    resetChartColorSettings()

    expect(getChartColorSettings().primary).toBe('var(--primary)')
    expect(document.documentElement.style.getPropertyValue('--chart-bar-primary')).toBe('')
  })

  it('survives a reload from storage, like every other Dev Settings value', () => {
    setChartColorSettings({ ...DEFAULT_CHART_COLORS, secondary: '#0000ff' })
    clearOverrides()

    expect(reloadFormattingPreferences().charts.secondary).toBe('#0000ff')
    // Publishing happens on load, so a restart is not a reset.
    expect(document.documentElement.style.getPropertyValue('--chart-bar-secondary')).toBe('#0000ff')
  })

  it('compares by value for the dirty state', () => {
    expect(chartColorsEqual(DEFAULT_CHART_COLORS, { ...DEFAULT_CHART_COLORS })).toBe(true)
    expect(
      chartColorsEqual(DEFAULT_CHART_COLORS, { ...DEFAULT_CHART_COLORS, sales: '#111111' }),
    ).toBe(false)
  })
})

describe('resolving for a swatch', () => {
  it('returns a literal as-is and normalizes the short hex form', () => {
    expect(resolveChartColor('#ABC')).toBe('#aabbcc')
    expect(resolveChartColor('#B07F47')).toBe('#b07f47')
  })

  it('degrades to something paintable when a value cannot be resolved', () => {
    // An unresolvable reference must not render a black (invisible) swatch.
    expect(resolveChartColor('var(--does-not-exist)')).toMatch(/^#[0-9a-f]{6}$/)
  })
})
