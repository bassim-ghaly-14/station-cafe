import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Money core — the ONLY place financial arithmetic is defined on the frontend.
 * Integers in minor units (piasters; 1 EGP = 100). No floats for money.
 */
export const MINOR_PER_MAJOR = 100
/** Fixed-point scale for percentage rates: 100_000 = 100.000%. */
export const RATE_SCALE = 100_000

/**
 * Money and rate values below are plain `number`s on purpose. They are never
 * branded, because every one of them crosses the Tauri IPC boundary as a JSON
 * number, so a brand could only ever be asserted away at the API edge and would
 * buy no real safety while forcing casts through the POS money paths.
 *
 * The unit contract is therefore carried by the names and the arithmetic
 * itself, and must mirror `src-tauri/src/money.rs`:
 * - an amount is an INTEGER number of minor units (piasters; 1 EGP = 100)
 * - a rate is a fixed-point integer ×1000 (`RATE_SCALE` = 100.000%)
 * - no float ever represents money
 */

/** Percentage of an amount, deterministic integer rounding (half up). */
export function percentOf(amount: number, rate: number): number {
  const num = amount * rate
  const sign = num < 0 ? -1 : 1
  const abs = Math.abs(num)
  return sign * Math.floor(abs / RATE_SCALE + 0.5)
}

/** Apply a percentage discount, floored at 0. */
export function applyPercentDiscount(amount: number, rate: number): number {
  return Math.max(0, amount - percentOf(amount, rate))
}

/** Apply a fixed minor-unit discount, floored at 0. */
export function applyFixedDiscount(amount: number, discount: number): number {
  return Math.max(0, amount - discount)
}

/** Parse "12.50" or "12,5" → 1250. Returns null when not a valid amount. */
export function parseMajor(input: string): number | null {
  const m = /^\d{1,7}([.,]\d{1,2})?$/.exec(input.trim())
  if (!m) return null
  const normalized = input.trim().replace(',', '.')
  const [maj, min = ''] = normalized.split('.')
  const minor = min.padEnd(2, '0').slice(0, 2)
  return Number.parseInt(maj, 10) * MINOR_PER_MAJOR + Number.parseInt(minor, 10)
}

/** Sum any list of amounts. */
export function sumAmounts(items: readonly number[]): number {
  return items.reduce((a, b) => a + b, 0)
}

/** Merge Tailwind classes with conflict resolution (shadcn convention). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
