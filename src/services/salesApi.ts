/** Typed wrappers over the Sales management command surface. */
import { call } from './ipc'

/** Inclusive business-date bounds; empty means unbounded, like the reports. */
export interface SalesPeriod {
  from?: string | null
  to?: string | null
}

/**
 * The narrowing inputs of the whole page. Every field is resolved by the
 * backend, so the UI never filters a dataset it already downloaded.
 */
export interface SalesFilter extends SalesPeriod {
  /** `CASH` | `CARD` | `CREDIT`. */
  method?: string | null
  /** Invoice status. */
  status?: string | null
  /** Cashier / user id. */
  user_id?: number | null
  /** Free-text match on the snapshotted customer name. */
  customer?: string | null
}

/** How the item analysis is ordered. The backend owns the ordering. */
export type SalesItemSort = 'revenue' | 'quantity'

export interface SalesSummary {
  invoices_count: number
  /** Invoice subtotals: line revenue before discount and service charge. */
  subtotal: number
  discounts: number
  service_charges: number
  /** The authoritative revenue: subtotal - discounts + service charges. */
  total_sales: number
  average_invoice: number
  cafe_sales: number
  wash_sales: number
  cash: number
  card: number
  credit: number
  cash_share: number
  card_share: number
  credit_share: number
}

export interface SalesDayRow {
  day_id: number
  day_date: string
  invoices_count: number
  total_sales: number
  cafe_sales: number
  wash_sales: number
  cash: number
  card: number
  credit: number
}

export interface SalesItemRow {
  product_name: string
  department: 'CAFE' | 'WASH'
  quantity: number
  revenue: number
  share_percent: number
}

export interface SalesInvoiceRow {
  id: number
  invoice_no: number
  day_date: string
  created_at: string
  order_type: 'TABLE' | 'TAKEAWAY'
  table_label: string | null
  takeaway_no: number | null
  status: string
  subtotal: number
  discount_minor: number
  service_charge: number
  total: number
  paid_amount: number
  cafe_total: number
  wash_total: number
  customer_name: string | null
  car_plate: string | null
  user_name: string | null
  user_role: string | null
  payment_method: 'CASH' | 'CARD' | 'CREDIT' | null
}

export interface SalesOverview {
  summary: SalesSummary
  trend: SalesDayRow[]
  items: SalesItemRow[]
}

/**
 * One calendar month of the monthly comparison report.
 *
 * `month` is the stable `YYYY-MM` grouping key, never a display name — that is
 * what keeps January 2025 and January 2026 in two buckets.
 */
export interface SalesMonthRow {
  month: string
  invoices_count: number
  total_sales: number
  cafe_sales: number
  wash_sales: number
}

/**
 * The monthly series AND the calendar window it describes.
 *
 * The window travels with the data on purpose: this report states its own
 * trailing period, so the chart labels what it shows instead of borrowing the
 * page's business-day filter.
 */
export interface SalesMonthlyReport {
  from: string
  to: string
  months: SalesMonthRow[]
}

export interface SalesCashier {
  id: number
  name: string
  role: string
}

/** The filter exactly as the backend expects it: absent, never empty. */
function filterArg(filter?: SalesFilter) {
  return {
    from: filter?.from?.trim() || null,
    to: filter?.to?.trim() || null,
    method: filter?.method || null,
    status: filter?.status || null,
    user_id: filter?.user_id ?? null,
    customer: filter?.customer?.trim() || null,
  }
}

export const salesApi = {
  /** KPIs + daily trend + top items, in a single manager-level read. */
  overview: (filter?: SalesFilter, sort: SalesItemSort = 'revenue') =>
    call<SalesOverview>('sales_overview', { filter: filterArg(filter), sort }),
  /** The invoices behind those numbers, under the very same filter. */
  invoices: (filter?: SalesFilter) =>
    call<SalesInvoiceRow[]>('sales_invoices', { filter: filterArg(filter) }),
  /** Cashier options for the filter. */
  cashiers: () => call<SalesCashier[]>('sales_cashiers'),
  /**
   * The monthly revenue series over its OWN trailing calendar window.
   *
   * It takes no `SalesFilter` — that is deliberate, not an omission: a calendar
   * comparison is not a range-filtered report, and the command cannot be handed
   * the page's date range in the first place.
   */
  monthly: (months?: number) =>
    call<SalesMonthlyReport>('sales_monthly', { months: months ?? null }),
}
