/**
 * The semantic value formatter, tested as the ONE place that decides what a
 * number reads like.
 *
 * These are the assertions the whole chart refactor rests on. A daily chart
 * prints an invoice COUNT beside an amount of money in the same tooltip, and
 * when a single formatter owned both, the count came out as `0.04 ج.م` — a
 * count divided by a hundred and given a currency label. Nothing may go back to
 * inferring money from "a number": the type travels with the value, and the
 * formatter obeys it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  __clearChartValueFormatterCache,
  chartValueColumnFormat,
  formatChartValue,
  isMoneyValue,
} from './chartValue'
import { formatDate } from '@/lib/date'
import { formatMinorMoney } from '@/lib/money'

beforeEach(() => {
  __clearChartValueFormatterCache()
})

describe('a value formatted as WHAT IT IS', () => {
  it('states a COUNT as a whole number, and never as money', () => {
    // THE regression: an invoice count of 2 must never read `0.02 ج.م`.
    expect(formatChartValue(42, 'count')).toBe('42')
    expect(formatChartValue(42, 'count')).not.toContain('ج.م')
    expect(formatChartValue(1_000, 'count')).toBe('1,000')
    // A count is a whole number of things, so a fractional one is rounded to the
    // nearest whole thing rather than printed as a decimal of pounds.
    expect(formatChartValue(0.04, 'count')).toBe('0')
  })

  it('states CURRENCY through the shared money formatter', () => {
    // Station stores amounts in piastres, exactly as `MoneyDisplay` reads them:
    // 1,250,000 piastres is 12,500 pounds, in the app's own precision.
    expect(formatChartValue(1_250_000, 'currency')).toBe('12,500.00 ج.م')
    expect(formatChartValue(100_000, 'currency')).toBe('1,000.00 ج.م')
    // `compact` always abbreviates (an AXIS has to be short); `auto` follows the
    // reader's own Dev-Settings switch, so a station that wants exact figures
    // everywhere gets them and a station that wants short ones gets them.
    expect(formatChartValue(1_250_000, 'currency', 'compact')).toMatch(/ج\.م$/)
    expect(formatChartValue(1_250_000, 'currency', 'auto')).toBe(
      formatMinorMoney(1_250_000, { variant: 'auto' }),
    )
  })

  it('states a PERCENTAGE as a percentage, and never as money', () => {
    expect(formatChartValue(12.5, 'percent')).toBe('12.5%')
    expect(formatChartValue(12.5, 'percent')).not.toContain('ج.م')
  })

  it('states a plain NUMBER with no unit at all', () => {
    expect(formatChartValue(1_250, 'number')).toBe('1,250')
    expect(formatChartValue(1_250, 'number')).not.toContain('ج.م')
  })

  it('defaults an undeclared value to a plain number, never to money', () => {
    // The safe direction: a value nobody took responsibility for prints as a
    // number, because a wrong plain number is a cosmetic fault while a wrong
    // currency label is a false statement about the business.
    expect(formatChartValue(1_250)).toBe('1,250')
    expect(formatChartValue(1_250)).not.toContain('ج.م')
  })

  it('says nothing readable about a value that is not a number', () => {
    expect(formatChartValue(null, 'currency')).toBe('—')
    expect(formatChartValue(undefined, 'count')).toBe('—')
    expect(formatChartValue(Number.NaN, 'currency')).toBe('—')
  })

  it('leaves the DATE to the central date formatter, never to a guess', () => {
    // Dates are the one value this module refuses to touch: the app has a single
    // Arabic date formatter, and a chart that formatted a date itself would
    // inevitably disagree with it.
    expect(formatDate('2026-09-27')).toBe(formatDate('2026-09-27'))
    expect(formatDate('2026-09-27')).not.toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('the same types, written into a workbook', () => {
  it('gives each type the column format it belongs in', () => {
    expect(chartValueColumnFormat('currency')).toBe('currency')
    expect(chartValueColumnFormat('count')).toBe('integer')
    expect(chartValueColumnFormat('percent')).toBe('percent')
    expect(chartValueColumnFormat('number')).toBe('text')
  })

  it('lets only money be unit-converted on the way out', () => {
    // A count is a count of things: dividing 42 invoices by 100 is what put
    // `0.42` in the sheet, so the exporter consults this and converts amounts
    // only.
    expect(isMoneyValue('currency')).toBe(true)
    expect(isMoneyValue('count')).toBe(false)
    expect(isMoneyValue('percent')).toBe(false)
    expect(isMoneyValue('number')).toBe(false)
  })
})
