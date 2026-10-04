/** Typed wrappers over the Sales management command surface. */
import type { RevenueDepartment } from './posApi'
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
  /**
   * The SAME period's invoices split by KIND. These are COUNTS of documents, not
   * money, so they are plain integers and must never be passed through a money
   * formatter. The four kinds are mutually exclusive and always sum to
   * `invoices_count`.
   */
  cafe_invoices: number
  wash_invoices: number
  hybrid_invoices: number
  takeaway_invoices: number
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

/**
 * How one department is doing against this month's target.
 *
 * EVERY financial value here is computed by the backend — the UI formats them
 * and never recomputes an achievement, a remainder or a share. That is the whole
 * point of the shape: the percentage the manager reads is the percentage the
 * domain resolved.
 */
export interface DepartmentTargetProgress {
  department: RevenueDepartment
  /** The month's effective target: its override if it has one, else the default. */
  target_minor: number
  /** Whether this month overrides the cafe-wide default for this department. */
  overridden: boolean
  /** Revenue achieved in the month so far — the invoice snapshot's own split. */
  actual_minor: number
  /** Still to earn, floored at zero: a passed target has nothing remaining. */
  remaining_minor: number
  /**
   * Achievement as a display string with two decimals ("50.00", "114.29"), or
   * `null` when there is NO target to measure against.
   *
   * `null` is the deliberate answer for a zero target — not `0`, which would
   * claim nothing was achieved, and never a fabricated `100`.
   */
  achievement_percent: string | null
  /** The same figure as hundredths of a percent, for callers needing the number. */
  achievement_hundredths: number | null
}

/** One business day of the month's progress, in Station's business timezone. */
export interface TargetDayRow {
  /** Business date, `YYYY-MM-DD`. */
  day_date: string
  cafe_revenue: number
  wash_revenue: number
  /** Revenue from the first of the month through this day. */
  cafe_cumulative: number
  wash_cumulative: number
  /**
   * Cumulative achievement against the FULL monthly target, in hundredths of a
   * percent. There is no daily target: each day reports how much of the month's
   * number has been earned by then. `null` when no target is set.
   */
  cafe_achievement_hundredths: number | null
  wash_achievement_hundredths: number | null
}

/**
 * The current business month's target progress, for both departments.
 *
 * The month is decided by the backend clock in `Africa/Cairo`, so this payload
 * can never describe a different month than the one the business is trading in,
 * whatever timezone the browser happens to be in.
 */
export interface MonthlyTargetProgress {
  /** The business month, `YYYY-MM`. */
  month: string
  /** First business date of the month, inclusive. */
  from: string
  /** Last business date read: today, so the series stops where the month has. */
  to: string
  cafe: DepartmentTargetProgress
  wash: DepartmentTargetProgress
  /** Ascending by `day_date`; a day with no business day at all is absent. */
  daily: TargetDayRow[]
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
  /**
   * The CURRENT business month's target progress for CAFE and WASH.
   *
   * It takes no period and no filter, exactly like `monthly`: a monthly target is
   * a statement about the month being traded in, and this command cannot be
   * pointed at an arbitrary range.
   */
  targetProgress: () => call<MonthlyTargetProgress>('sales_target_progress'),
}
