/** Unit tests for the raw-material quantity formatter. */
import { describe, expect, it } from 'vitest'
import { formatQuantity } from './RawMaterialsPanel'

describe('formatQuantity', () => {
  it('shows an exact multiple of 1000 in the larger unit', () => {
    expect(formatQuantity(1000, 'GRAM', 'en-US')).toBe('1 kg')
    expect(formatQuantity(2000, 'MILLILITER', 'en-US')).toBe('2 l')
  })

  it('keeps a non-divisible gram quantity exact, never decimal', () => {
    expect(formatQuantity(1100, 'GRAM', 'en-US')).toBe('1,100 g')
  })

  it('keeps a non-divisible milliliter quantity exact', () => {
    expect(formatQuantity(1500, 'MILLILITER', 'en-US')).toBe('1,500 ml')
  })

  it('formats zero in base units', () => {
    expect(formatQuantity(0, 'GRAM', 'en-US')).toBe('0 g')
  })

  it('formats a large valid quantity without floats', () => {
    expect(formatQuantity(2_000_000, 'GRAM', 'en-US')).toBe('2,000 kg')
    expect(formatQuantity(2_000_001, 'GRAM', 'en-US')).toBe('2,000,001 g')
  })

  it('uses the active locale numerals for Arabic', () => {
    expect(formatQuantity(2000, 'GRAM', 'ar-EG')).toBe('٢ kg')
  })
})
