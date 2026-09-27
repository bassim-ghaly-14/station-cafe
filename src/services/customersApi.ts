/** Typed wrappers over the customer management command surface. */

import { call } from './ipc'
import type { Car } from './posApi'

/** Inclusive business-date bounds; empty means unbounded, like the reports. */
export interface CustomerPeriod {
  from?: string | null
  to?: string | null
}

/**
 * Aggregated activity of one customer for the requested period.
 *
 * It is `null` for a role the backend does not send money to — the value is
 * absent from the payload, so the UI renders what it was actually given.
 */
export interface CustomerStats {
  invoices_count: number
  total: number
  paid: number
  discounts: number
  service_charges: number
  average_order: number
  cafe_orders: number
  cafe_total: number
  wash_orders: number
  wash_total: number
  takeaway_orders: number
  table_orders: number
  first_at: string | null
  last_at: string | null
  credit_outstanding: number
  credit_original: number
  credit_paid: number
  credit_status: string | null
}

export interface CustomerRow {
  id: number
  name: string
  phone: string | null
  notes: string | null
  created_at: string
  updated_at: string
  plates: string[]
  cars_count: number
  stats: CustomerStats | null
}

/** `financial_visible` is decided by the backend role gate, not by the UI. */
export interface CustomerList {
  financial_visible: boolean
  customers: CustomerRow[]
}

export interface CustomerRank {
  customer_id: number
  name: string
  value: number
}

export interface CustomerOverview {
  total_customers: number
  active_customers: number
  total_orders: number
  total_paid: number
  average_spend: number
  cafe_orders: number
  wash_orders: number
  takeaway_orders: number
  table_orders: number
  outstanding_credit: number
  top_by_orders: CustomerRank | null
  top_by_spend: CustomerRank | null
}

export interface CustomerActivity {
  invoice_no: number
  order_type: string
  table_label: string | null
  takeaway_no: number | null
  status: string
  total: number
  paid_amount: number
  cafe_total: number
  wash_total: number
  created_at: string
}

export interface CustomerDetails {
  customer: { id: number; name: string; phone: string | null; notes: string | null }
  created_at: string
  cars: Car[]
  stats: CustomerStats
  activity: CustomerActivity[]
}

function period(period?: CustomerPeriod) {
  return { from: period?.from ?? null, to: period?.to ?? null }
}

export const customersApi = {
  /** The page list. Open to every role; the backend decides what else it holds. */
  list: (query = '', range?: CustomerPeriod) =>
    call<CustomerList>('list_customers', { query: query.trim(), period: period(range) }),
  /** Manager-level: the KPI band. A cashier is refused by the backend. */
  overview: (range?: CustomerPeriod) =>
    call<CustomerOverview>('customer_overview', { period: period(range) }),
  /** Manager-level: one customer's drawer payload. */
  details: (customerId: number, range?: CustomerPeriod) =>
    call<CustomerDetails>('customer_details', {
      customer_id: customerId,
      period: period(range),
    }),

  create: (input: { name: string; phone?: string | null; notes?: string | null }) =>
    call<number>('create_customer', { input }),
  /** Manager-level in the existing authorization model (see DECISIONS/audit). */
  update: (
    customerId: number,
    input: { name: string; phone?: string | null; notes?: string | null },
  ) => call<void>('update_customer', { customer_id: customerId, input }),
  createCar: (input: { customer_id: number; plate_no: string; car_model?: string | null }) =>
    call<number>('create_car', { input }),
  /**
   * ADMIN-only PERMANENT delete of a customer, together with the vehicles it
   * owns (a plate is a registration, not history).
   *
   * A customer with orders, invoices or a credit account is REFUSED by the
   * backend with a domain error rather than being force-deleted, because their
   * financial history must survive. The refusal surfaces through the normal
   * Arabic error mapping, and nothing is removed.
   */
  remove: (customerId: number) => call<void>('delete_customer', { customer_id: customerId }),
}
