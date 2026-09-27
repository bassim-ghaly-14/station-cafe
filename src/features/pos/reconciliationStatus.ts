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
