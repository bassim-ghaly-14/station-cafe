import type { BadgeProps } from '@/components/ui/badge'

export type BadgeVariant = NonNullable<BadgeProps['variant']>

const fallback: Record<string, BadgeVariant> = {
  ACTIVE: 'success',
  OPEN: 'info',
  EMPTY: 'neutral',
  OCCUPIED: 'warning',
  IN_PROGRESS: 'info',
  CLOSED: 'success',
  PAID: 'success',
  PARTIALLY_PAID: 'warning',
  CREDIT: 'warning',
  PENDING_PAYMENT: 'info',
  SUSPENDED: 'warning',
  DONE: 'success',
  PRINTED: 'success',
  FAILED: 'danger',
  PRINT_FAILED: 'danger',
  PENDING: 'warning',
}

export function badgeVariantForStatus(status?: string | null): BadgeVariant {
  return fallback[status ?? ''] ?? 'neutral'
}

export const staffBadgeVariant = (status?: string | null) => badgeVariantForStatus(status)
export const dayBadgeVariant = (status?: string | null) => badgeVariantForStatus(status)
export const invoiceBadgeVariant = (status?: string | null) => badgeVariantForStatus(status)
export const printJobBadgeVariant = (status?: string | null) => badgeVariantForStatus(status)
export const tableBadgeVariant = (status?: string | null): BadgeVariant => {
  if (status === 'EMPTY') return 'danger'
  if (status === 'OPEN') return 'info'
  if (status === 'OCCUPIED') return 'success'
  return 'warning'
}
