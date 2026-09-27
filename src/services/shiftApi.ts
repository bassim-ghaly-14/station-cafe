/** Typed wrappers over the shift / business-day command surface. */
import type { DayTotals } from './posApi'
import { call } from './ipc'

export interface ShiftRow {
  id: number
  business_day_id: number
  user_id: number
  user_name: string | null
  user_role?: string | null
  status: string
  opened_at: string
  opening_cash: number
  closed_at: string | null
  cash_sales: number
  card_sales: number
  credit_sales: number
  service_charges: number
  discounts: number
  invoices_count: number
  expected_cash: number
  actual_cash: number | null
  cash_difference: number | null
  cafe_invoices: number
  wash_invoices: number
  hybrid_invoices: number
  subtotal: number
  total_sales: number
  cafe_sales: number
  wash_sales: number
  expenses: number
  cash_expenses: number
}

/**
 * The reconciliation result, exactly as the backend computed it.
 *
 * `status` is the authoritative semantic verdict — BALANCED / SHORTAGE /
 * SURPLUS — so the UI never re-derives it from the signed difference. Every
 * number here comes from the backend; the UI formats and labels only.
 */
export type CashStatus = 'BALANCED' | 'SHORTAGE' | 'SURPLUS'

export interface CashReconciliation {
  opening_cash: number
  cash_inflows: number
  cash_outflows: number
  expected_cash: number
  actual_cash: number
  difference: number
  shortage: number
  surplus: number
  status: CashStatus
}

export interface ExpenseBreakdownRow {
  category: string
  category_name: string
  count: number
  amount: number
}

/** The authoritative closing report shared by the screen, preview and printer. */
export interface ShiftReconciliation {
  shift: ShiftRow
  areas: { cafe_invoices: number; wash_invoices: number; hybrid_invoices: number }
  invoices_count: number
  cafe_sales: number
  wash_sales: number
  subtotal: number
  discounts: number
  service_charges: number
  total_sales: number
  cash_sales: number
  card_sales: number
  credit_sales: number
  expenses: number
  cash_expenses: number
  expense_breakdown: ExpenseBreakdownRow[]
  cash: CashReconciliation
}

export interface DayReconciliation {
  day: { id: number; day_date: string; status: string; opened_at: string; closed_at: string | null }
  areas: { cafe_invoices: number; wash_invoices: number; hybrid_invoices: number }
  shift_count: number
  /** Shifts that were still open and therefore EXCLUDED from this closing. */
  open_shift_count: number
  invoices_count: number
  cafe_sales: number
  wash_sales: number
  subtotal: number
  discounts: number
  service_charges: number
  total_sales: number
  cash_sales: number
  card_sales: number
  credit_sales: number
  expenses: number
  cash_expenses: number
  expense_breakdown: ExpenseBreakdownRow[]
  cash: CashReconciliation
  included_shift_ids: number[]
  shifts: ShiftRow[]
}

/** An open shift the manager must be warned about before closing the day. */
export interface OpenShiftInfo {
  id: number
  user_name: string | null
  opened_at: string
  cash_sales: number
  expenses: number
}

/**
 * The manager's day-closing preview. The backend decides which shifts are
 * included; the UI only renders that decision and warns about the rest.
 */
export interface DayClosePreview {
  report: DayReconciliation
  open_shifts: OpenShiftInfo[]
  open_orders: number
}

export interface DayShiftState {
  day: { id: number; day_date: string; status: string; opened_at: string } | null
  my_shift: ShiftRow | null
  any_active_shift: boolean
}

export interface ShiftClosing {
  shift: ShiftRow
  expected_cash: number
  difference: number
  report: ShiftReconciliation
}

export interface ShiftClosingPreview {
  shift: ShiftRow
  closing_at: string
  cash_sales: number
  card_sales: number
  credit_sales: number
  invoices_count: number
  cash_expenses: number
  expenses: number
  expected_cash: number
  report: ShiftReconciliation
}

export interface SettlementPreview {
  business_day_id: number
  pending_shifts: ShiftRow[]
  totals: DayTotals
}

export interface DayClosingRecord {
  id: number
  business_day_id: number
  closed_by: number
  closed_at: string
  shift_ids: number[]
  totals: DayTotals
  final_snapshot: boolean
}

export interface DayCloseResult {
  totals: DayTotals
  report: DayReconciliation
}

export const shiftApi = {
  state: () => call<DayShiftState>('day_shift_state'),
  openDay: () => call<number>('open_business_day'),
  openShift: (opening_cash: number) => call<number>('open_shift', { opening_cash }),
  previewShiftClose: () => call<ShiftClosingPreview>('preview_shift_close'),
  closeShift: (actual_cash: number) => call<ShiftClosing>('close_shift', { actual_cash }),
  previewDaySettlement: () => call<SettlementPreview>('preview_day_settlement'),
  settleDay: () => call<DayClosingRecord>('settle_day'),
  daySettlementHistory: () => call<DayClosingRecord[]>('day_settlement_history'),
  dayReport: (day_id: number) => call<DayReconciliation>('day_report', { day_id }),
  /**
   * What the day closing WILL record, plus the open shifts it will EXCLUDE.
   * The inclusion rule is the backend's; this is read-only and drives the
   * manager's confirmation warning.
   */
  previewDayClose: () => call<DayClosePreview>('preview_day_close'),
  closeDay: () => call<DayCloseResult>('close_business_day'),
}
