/**
 * The catalog's shared visual identity and input helpers.
 *
 * The two departments are the catalog's business identities, and the styles
 * below are the ONLY place their accent, border and price colors are defined,
 * so a card, a dialog preview and an overview tile can never drift apart.
 */
import type { Department } from './catalogModel'

export const DEPARTMENTS = ['CAFE', 'WASH'] as const
export const TYPES = ['PRODUCT', 'SERVICE'] as const

export type DepartmentStyle = {
  accent: string
  accentText: string
  soft: string
  softStrong: string
  border: string
  mutedBorder: string
  price: string
}

export const departmentStyles: Record<Department, DepartmentStyle> = {
  CAFE: {
    accent: 'bg-primary',
    accentText: 'text-primary',
    soft: 'bg-accent',
    softStrong: 'bg-secondary',
    border: 'border-primary-border',
    mutedBorder: 'border-primary-soft',
    price: 'text-primary',
  },

  WASH: {
    accent: 'bg-info',
    accentText: 'text-info',
    soft: 'bg-info-soft',
    softStrong: 'bg-info-soft',
    border: 'border-info-border',
    mutedBorder: 'border-info-soft',
    price: 'text-info',
  },
}

/** Non-negative integer stock quantity; empty input means zero. */
export function parseStockQuantity(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return 0
  }
  if (!/^\d+$/.test(trimmed)) {
    return null
  }
  const quantity = Number(trimmed)
  return Number.isSafeInteger(quantity) ? quantity : null
}
