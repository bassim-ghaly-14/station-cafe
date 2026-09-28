import type { CashStatus } from '@/services/shiftApi'

/**
 * The one Arabic label and the one semantic colour for each backend verdict.
 *
 * These live outside the section components so every panel that shows a
 * reconciliation — the shift card, the closing dialog, the day closing — uses
 * the same word and the same colour for the same backend status. The class
 * names resolve entirely to the centralized Station color tokens; no color is
 * hardcoded here.
 */
export const STATUS_LABEL: Record<CashStatus, string> = {
  BALANCED: 'shift.statusBalanced',
  SHORTAGE: 'shift.statusShortage',
  SURPLUS: 'shift.statusSurplus',
}

export const STATUS_TONE: Record<CashStatus, string> = {
  BALANCED: 'border-success-border bg-success-soft text-success-foreground',
  SHORTAGE: 'border-destructive-border bg-destructive-soft text-destructive-soft-foreground',
  SURPLUS: 'border-warning-border bg-warning-soft text-warning-foreground',
}

/** The translation key for a backend verdict. */
export function statusLabelKey(status: CashStatus): string {
  return STATUS_LABEL[status]
}

/** The semantic color classes for a backend verdict. */
export function statusTone(status: CashStatus): string {
  return STATUS_TONE[status]
}

/**
 * The magnitude that belongs to a verdict, in minor units.
 *
 * A balanced handover has no gap to show, so it shows zero. The other two
 * verdicts show the exact figure the backend already resolved — the client
 * never recomputes a difference.
 */
export function statusMagnitude(cash: {
  status: CashStatus
  shortage: number
  surplus: number
}): number {
  if (cash.status === 'SHORTAGE') return cash.shortage
  if (cash.status === 'SURPLUS') return cash.surplus
  return 0
}
