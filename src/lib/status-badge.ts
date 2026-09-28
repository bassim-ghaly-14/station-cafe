import type { BadgeProps } from '@/components/ui/badge'
import type { AttendanceState } from '@/services/employeesApi'

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

export const dayBadgeVariant = (status?: string | null) => badgeVariantForStatus(status)
export const invoiceBadgeVariant = (status?: string | null) => badgeVariantForStatus(status)
export const printJobBadgeVariant = (status?: string | null) => badgeVariantForStatus(status)
export const tableBadgeVariant = (status?: string | null): BadgeVariant => {
  if (status === 'EMPTY') return 'danger'
  if (status === 'OPEN') return 'info'
  if (status === 'OCCUPIED') return 'success'
  return 'warning'
}

/**
 * The tone of an attendance state, used by both the roster and the personal card.
 *
 * The union is closed, so the mapping is a total lookup: present is the good
 * news, absent is the bad news, and leave is the in-between that must not be
 * mistaken for either.
 */
const ATTENDANCE_VARIANT: Record<AttendanceState, BadgeVariant> = {
  PRESENT: 'success',
  ABSENT: 'danger',
  LEAVE: 'warning',
}

export const attendanceBadgeVariant = (state: AttendanceState): BadgeVariant =>
  ATTENDANCE_VARIANT[state]
