import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_FORMATTING,
  reloadFormattingPreferences,
  resetFormattingPreferences,
  sanitizePreferences,
  updateMoneySettings,
} from './formatting'
import {
  CURRENCY_LABEL,
  formatCompactMoney,
  formatMoney,
  formatMoneyInput,
  formatMinorMoney,
} from './money'
import { applyFixedDiscount, applyPercentDiscount, parseMajor, percentOf } from './utils'

describe('money formatter', () => {
  it('formats full EGP amounts with separators and Station precision', () => {
    expect(formatMoney(0)).toBe(`0.00 ${CURRENCY_LABEL}`)
    expect(formatMoney(1)).toBe(`1.00 ${CURRENCY_LABEL}`)
    expect(formatMoney(10)).toBe(`10.00 ${CURRENCY_LABEL}`)
    expect(formatMoney(100)).toBe(`100.00 ${CURRENCY_LABEL}`)
    expect(formatMoney(999)).toBe(`999.00 ${CURRENCY_LABEL}`)
    expect(formatMoney(1000)).toBe(`1,000.00 ${CURRENCY_LABEL}`)
    expect(formatMoney(1250)).toBe(`1,250.00 ${CURRENCY_LABEL}`)
    expect(formatMoney(10000)).toBe(`10,000.00 ${CURRENCY_LABEL}`)
    expect(formatMoney(100000)).toBe(`100,000.00 ${CURRENCY_LABEL}`)
    expect(formatMoney(1000000)).toBe(`1,000,000.00 ${CURRENCY_LABEL}`)
  })

  it('formats compact EGP amounts with Arabic magnitude units', () => {
    expect(formatCompactMoney(1000)).toBe(`1 ألف ${CURRENCY_LABEL}`)
    expect(formatCompactMoney(1500)).toBe(`1.5 ألف ${CURRENCY_LABEL}`)
    expect(formatCompactMoney(10000)).toBe(`10 آلاف ${CURRENCY_LABEL}`)
    expect(formatCompactMoney(125000)).toBe(`125 ألف ${CURRENCY_LABEL}`)
    expect(formatCompactMoney(1000000)).toBe(`1 مليون ${CURRENCY_LABEL}`)
    expect(formatCompactMoney(1500000)).toBe(`1.5 مليون ${CURRENCY_LABEL}`)
    expect(formatCompactMoney(12500000)).toBe(`12.5 مليون ${CURRENCY_LABEL}`)
    expect(formatCompactMoney(1000000000)).toBe(`1 مليار ${CURRENCY_LABEL}`)
  })

  it('handles signs, decimals, strings, invalid input, and large values', () => {
    expect(formatMoney(-1250.5)).toBe(`-1,250.50 ${CURRENCY_LABEL}`)
    expect(formatCompactMoney(-1250000)).toBe(`-1.25 مليون ${CURRENCY_LABEL}`)
    expect(formatMoney('1250.5')).toBe(`1,250.50 ${CURRENCY_LABEL}`)
    expect(formatMoney('1,250.50')).toBe(`1,250.50 ${CURRENCY_LABEL}`)
    expect(formatMoney(1.005)).toBe(`1.01 ${CURRENCY_LABEL}`)
    expect(formatMoney(1e21)).toContain('1,000,000,000,000,000,000,000')
    expect(formatMoney(Number.MAX_SAFE_INTEGER)).toContain('9,007,199,254,740,991')
    expect(formatMoney(null)).toBe('—')
    expect(formatMoney(undefined)).toBe('—')
    expect(formatMoney('not a number')).toBe('—')
    expect(formatMoney(Number.NaN)).toBe('—')
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('uses the same presentation rules for API minor-unit values', () => {
    expect(formatMinorMoney(0)).toBe(`0.00 ${CURRENCY_LABEL}`)
    expect(formatMinorMoney(125000)).toBe(`1,250.00 ${CURRENCY_LABEL}`)
    expect(formatMinorMoney(125000000)).toBe(`1,250,000.00 ${CURRENCY_LABEL}`)
    expect(formatMinorMoney(125000000, { compact: true })).toBe(`1.25 مليون ${CURRENCY_LABEL}`)
  })

  it('formats editable major-unit values without a currency suffix', () => {
    expect(formatMoneyInput(1250)).toBe('1,250.00')
    expect(formatMoneyInput(0.5)).toBe('0.50')
    expect(formatMoneyInput(null)).toBe('')
  })
})

describe('formatting preferences integration', () => {
  afterEach(() => resetFormattingPreferences())

  it('uses defaults and safely sanitizes invalid persisted values', () => {
    expect(sanitizePreferences({ money: { decimalPlaces: 9 }, date: { timeFormat: 'x' } })).toEqual(
      DEFAULT_FORMATTING,
    )
  })

  it('reacts immediately and persists/reloads latest settings', () => {
    updateMoneySettings({ decimalPlaces: 0, useThousandsSeparator: false, showCurrency: false })
    expect(formatMoney(1250)).toBe('1250')
    expect(reloadFormattingPreferences().money.decimalPlaces).toBe(0)
    expect(formatMoney(1250)).toBe('1250')
  })

  it('supports currency position and semantic explicit compact/full variants', () => {
    updateMoneySettings({ currencyPosition: 'before' })
    expect(formatMoney(1250, { showCurrency: true })).toBe(`${CURRENCY_LABEL} 1,250.00`)
    expect(formatMoney(1250000, { variant: 'full' })).toBe(`${CURRENCY_LABEL} 1,250,000.00`)
    expect(formatMoney(1250000, { variant: 'compact' })).toBe(`${CURRENCY_LABEL} 1.25 مليون`)
  })

  it('renders a money draft without changing the saved settings', () => {
    const draft = {
      ...DEFAULT_FORMATTING.money,
      decimalPlaces: 0 as const,
      showCurrency: false,
    }
    expect(formatMoney(1250, { settings: draft })).toBe('1,250')
    // The saved configuration is untouched — only the preview reads the draft.
    expect(formatMoney(1250)).toBe(`1,250.00 ${CURRENCY_LABEL}`)
  })

  it('only compacts auto values at or above the configured threshold', () => {
    const draft = { ...DEFAULT_FORMATTING.money, compactThreshold: 10_000 }
    expect(formatMoney(9999, { settings: draft, variant: 'auto' })).toBe(
      `9,999.00 ${CURRENCY_LABEL}`,
    )
    // 10,000 is the new threshold; with no magnitude at or below it in range the
    // value stays exact until it reaches the million magnitude.
    expect(formatMoney(1250000, { settings: draft, variant: 'auto' })).toBe(
      `1.25 مليون ${CURRENCY_LABEL}`,
    )
    // Compact mode off keeps the exact value at every magnitude.
    const exact = { ...draft, compactLargeValues: false }
    expect(formatMoney(1250000, { settings: exact, variant: 'auto' })).toBe(
      `1,250,000.00 ${CURRENCY_LABEL}`,
    )
  })
})

describe('money core (frontend)', () => {
  it('computes exact percentages with half-up rounding', () => {
    expect(percentOf(200_00, 10_000)).toBe(20_00) // 10% of 200 = 20
    expect(percentOf(55_50, 15_000)).toBe(8_33) // 15% of 55.50 → 8.325 → 8.33
  })

  it('never allows negative totals after discounts', () => {
    expect(applyFixedDiscount(20_00, 25_00)).toBe(0)
    expect(applyPercentDiscount(10_00, 150_000)).toBe(0)
  })

  it('parses user amounts to minor units', () => {
    expect(parseMajor('12.50')).toBe(1250)
    expect(parseMajor('12,5')).toBe(1250)
    expect(parseMajor('200')).toBe(200_00)
    expect(parseMajor('abc')).toBeNull()
    expect(parseMajor('-5')).toBeNull()
  })
})
