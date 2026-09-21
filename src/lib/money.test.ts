import { describe, expect, it } from 'vitest'
import {
  applyFixedDiscount,
  applyPercentDiscount,
  formatMinor,
  parseMajor,
  percentOf,
} from './utils'

describe('money core (frontend)', () => {
  it('computes exact percentages with half-up rounding', () => {
    expect(percentOf(200_00, 10_000)).toBe(20_00) // 10% of 200 = 20
    expect(percentOf(55_50, 15_000)).toBe(8_33) // 15% of 55.50 → 8.325 → 8.33
  })

  it('never allows negative totals after discounts', () => {
    expect(applyFixedDiscount(20_00, 25_00)).toBe(0)
    expect(applyPercentDiscount(10_00, 150_000)).toBe(0)
  })

  it('formats minor units', () => {
    expect(formatMinor(240_00)).toBe('240.00')
    expect(formatMinor(5)).toBe('0.05')
    expect(formatMinor(-350)).toBe('-3.50')
  })

  it('parses user amounts to minor units', () => {
    expect(parseMajor('12.50')).toBe(1250)
    expect(parseMajor('12,5')).toBe(1250)
    expect(parseMajor('200')).toBe(200_00)
    expect(parseMajor('abc')).toBeNull()
    expect(parseMajor('-5')).toBeNull()
  })
})
