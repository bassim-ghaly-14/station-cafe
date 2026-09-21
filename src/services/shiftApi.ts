/** Typed wrappers over the shift / business-day command surface. */
import type { DayTotals } from './posApi'
import { call } from './ipc'

export interface ShiftRow {
  id: number
  business_day_id: number
  user_id: number
  user_name: string | null
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

export const shiftApi = {
  state: () => call<DayShiftState>('day_shift_state'),
  openDay: () => call<number>('open_business_day'),
  openShift: (opening_cash: number) => call<number>('open_shift', { opening_cash }),
  closeShift: (actual_cash: number) => call<ShiftClosing>('close_shift', { actual_cash }),
  closeDay: () => call<DayTotals>('close_business_day'),
}
