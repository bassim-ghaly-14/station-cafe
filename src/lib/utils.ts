import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Money core — the ONLY place financial arithmetic is defined on the frontend.
 * Integers in minor units (piasters; 1 EGP = 100). No floats for money.
 */
export const MINOR_PER_MAJOR = 100
/** Fixed-point scale for percentage rates: 100_000 = 100.000%. */
export const RATE_SCALE = 100_000

export type Money = number
/** A percentage rate ×1000: 10_000 = 10%. */
export type Rate = number

/** Percentage of an amount, deterministic integer rounding (half up). */
export function percentOf(amount: Money, rate: Rate): Money {
  const num = amount * rate
  const sign = num < 0 ? -1 : 1
  const abs = Math.abs(num)
  return (sign * Math.floor(abs / RATE_SCALE + 0.5)) as Money
}

/** Apply a percentage discount, floored at 0. */
export function applyPercentDiscount(amount: Money, rate: Rate): Money {
  return Math.max(0, amount - percentOf(amount, rate)) as Money
}

/** Apply a fixed minor-unit discount, floored at 0. */
export function applyFixedDiscount(amount: Money, discount: Money): Money {
  return Math.max(0, amount - discount) as Money
}

/** Parse "12.50" or "12,5" → 1250. Returns null when not a valid amount. */
export function parseMajor(input: string): Money | null {
  const m = /^\d{1,7}([.,]\d{1,2})?$/.exec(input.trim())
  if (!m) return null
  const normalized = input.trim().replace(',', '.')
  const [maj, min = ''] = normalized.split('.')
  const minor = min.padEnd(2, '0').slice(0, 2)
  return (parseInt(maj, 10) * MINOR_PER_MAJOR + parseInt(minor, 10)) as Money
}

/** Sum any list of amounts. */
export function sumAmounts(items: readonly Money[]): Money {
  return items.reduce((a, b) => a + b, 0) as Money
}

/** Merge Tailwind classes with conflict resolution (shadcn convention). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
