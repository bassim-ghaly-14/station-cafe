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
}

export interface ShiftClosingPreview {
  shift: ShiftRow
  closing_at: string
  cash_sales: number
  card_sales: number
  credit_sales: number
  invoices_count: number
  expected_cash: number
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

export interface DayReportData {
  day: { id: number; day_date: string; status: string; opened_at: string; closed_at: string | null }
  totals: DayTotals
  shifts: ShiftRow[]
  expected_drawer_cash: number
  cash_differences: number
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
  dayReport: (day_id: number) => call<DayReportData>('day_report', { day_id }),
  closeDay: () => call<DayTotals>('close_business_day'),
}
