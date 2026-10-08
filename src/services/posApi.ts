/** Typed wrappers over the POS/cashier command surface. */
import { call } from './ipc'

export interface Product {
  id: number
  name: string
  item_type: 'PRODUCT' | 'SERVICE'
  department: 'CAFE' | 'WASH'
  category_id: number
  category_name: string
  price_minor: number
  is_active: boolean
  track_inventory: boolean
  stock_quantity: number
  /**
   * Persisted minimum-stock threshold. Older payloads omit it; the catalog
   * edit dialog falls back to `0` rather than inventing a value.
   */
  min_quantity?: number
  is_seed: boolean
  /** Recent addition — a catalog presentation flag, independent of `is_active`. */
  is_new: boolean
}

export interface OrderLine {
  id: number
  order_id: number
  product_id: number
  department: string
  product_name: string
  unit_price: number
  quantity: number
  discount_minor: number
  line_total: number
}

export interface PosOrder {
  id: number
  order_type: 'TABLE' | 'TAKEAWAY'
  table_id: number | null
  user_id: number
  status: string
  customer_id: number | null
  discount_mode: string | null
  discount_value: number | null
  opened_at: string
  waiting_no: number | null
  takeaway_no: number | null
  shift_id: number | null
  /** Authoritative table label from the backend; null for TAKEAWAY. */
  table_label: string | null
  lines: OrderLine[]
}

/**
 * The lifecycle counters of the caller's OWN ACTIVE shift.
 *
 * `closed_empty` is the empty-close count, read from persisted `table_sessions`
 * by the backend scoped through `shift_id` — the SAME read the close-shift
 * dialog reports. It is deliberately NOT summed from the per-table cards here:
 * a sum over the active grid loses any close belonging to a table that has
 * since been retired, and it is a second, competing definition of one number.
 *
 * A newly opened shift owns no sessions yet, so this naturally reports zero
 * without deleting any historical rows.
 */
export interface TableCounters {
  opens: number
  closed_empty: number
}

export interface TableView {
  id: number
  label: string
  status: 'EMPTY' | 'OPEN' | 'OCCUPIED' | 'READY_TO_PAY'
  order_id: number | null
  session_id: number | null
  items_count: number
  total_minor: number
  opened_at: string | null
  /**
   * Per-table lifecycle counters for the caller's ACTIVE SHIFT (`shift_id`
   * scope, like the band). Historical `*_today` names are kept for API
   * stability; a new shift naturally reads 0/0 with history intact.
   */
  opens_today: number
  closed_empty_today: number
}

/** Open (unpaid) takeaway order — discoverable/reopenable from the POS. */
export interface TakeawayView {
  id: number
  status: string
  opened_at: string
  items_count: number
  total_minor: number
}

export interface OrderPreview {
  subtotal: number
  discount_mode: string | null
  discount_value: number | null
  discount_minor: number
  service_charge_minor: number
  total: number
  has_wash: boolean
}

export interface CheckoutResult {
  invoice_id: number
  invoice_no: number
  total: number
  change_given: number | null
  status: string
}

export interface InvoiceLine {
  department: string
  product_name: string
  unit_price: number
  quantity: number
  discount_minor: number
  line_total: number
}

export interface InvoiceRow {
  id: number
  invoice_no: number
  table_label: string | null
  order_type: 'TABLE' | 'TAKEAWAY'
  takeaway_no: number | null
  status: string
  total: number
  paid_amount: number
  service_charge: number
  discount_minor: number
  subtotal: number
  cafe_total: number
  wash_total: number
  customer_name: string | null
  customer_phone: string | null
  car_plate: string | null
  car_model: string | null
  /** Immutable snapshot of the cashier's name at the moment of the sale. */
  cashier_name: string | null
  created_at: string
  shift_id: number | null
  business_day_id: number | null
}

export interface WashTicketRow {
  id: number
  waiting_no: number
  day_date: string
  issued_at: string
  order_id: number
  /** The ORDER's own status — the domain has no wash-ticket status. */
  order_status: string
  customer_name: string | null
  customer_phone: string | null
  car_plate: string | null
  car_model: string | null
  services: string | null
  /** The related receipt, through the persisted `invoices.order_id`. */
  invoice_id: number | null
  invoice_no: number | null
  invoice_status: string | null
  invoice_total: number | null
}

export interface CustomerWithCars {
  id: number
  name: string
  phone: string | null
  notes: string | null
  cars: Car[]
}

export interface Car {
  id: number
  customer_id: number
  plate_no: string
  car_model: string | null
  notes: string | null
}

export interface CreditAccount {
  id: number
  customer_id: number
  original_total: number
  paid_total: number
  status: string
  created_at: string
  customer_name: string | null
}

export interface TicketData {
  waiting_no: number
  customer_name: string
  customer_phone: string | null
  car_plate: string
  car_model: string | null
  services: string[]
  entry_time: string
}

export interface PrintOutcome {
  doc_type: string
  target: string
  bytes: number
  duplicate_suppressed: boolean
}

/** Horizontal alignment of a printed preview line (ESC/POS ESC a n). */
export type PreviewTextAlign = 'left' | 'center' | 'right'

/**
 * Print preview IR — the drawing operations of the document that goes to the
 * printer, in printer order. It is produced by the same Rust template run that
 * generates the ESC/POS bytes, so the preview cannot drift from the real
 * output. Text is already in printed (visual) order for RTL lines.
 */
export interface PreviewTextOp {
  kind: 'text'
  text: string
  align: PreviewTextAlign
  bold: boolean
  /** Character-width multiplier (ESC/POS GS ! n). */
  width: number
  /** Character-height multiplier. */
  height: number
}

/** Monochrome raster (brand logo): 1 bit per dot, MSB first, packed rows. */
export interface PreviewLogoOp {
  kind: 'logo'
  width_dots: number
  height_dots: number
  bits_hex: string
  align: PreviewTextAlign
}

export interface PreviewFeedOp {
  kind: 'feed'
  lines: number
}

/** Authoritative item fields formatted by the backend template. */
export interface PreviewItemOp {
  kind: 'item'
  name: string
  quantity: string
  unit_price: string
  line_total: string
  align: PreviewTextAlign
}

/** Authoritative financial fields formatted by the backend template. */
export interface PreviewFinancialOp {
  kind: 'financial'
  label: string
  value: string
  total: boolean
  align: PreviewTextAlign
}

/**
 * Authoritative invoice/receipt metadata row (date, time, invoice number,
 * customer, table, car …), emitted by the backend's invoice print layer.
 *
 * The backend prints the identical 42-cell physical line it always printed;
 * this op exists so the screen can lay the identity block out across the full
 * printable width as a real two-column row instead of a right-aligned string.
 */
export interface PreviewMetaOp {
  kind: 'meta'
  label: string
  value: string
  /** Print emphasis — the document's own moment is set apart by weight. */
  emphasis: boolean
  align: PreviewTextAlign
}

export interface PreviewCutOp {
  kind: 'cut'
}

export type PreviewOp =
  | PreviewTextOp
  | PreviewLogoOp
  | PreviewItemOp
  | PreviewFinancialOp
  | PreviewMetaOp
  | PreviewFeedOp
  | PreviewCutOp

export interface PrintPreview {
  doc_type: string
  paper_mm: number
  /**
   * The authoritative printable width in printer character cells (42 on 80mm).
   * Every section of the document — header, metadata, items, totals — is laid
   * out on this one canvas, so no section can occupy less paper than another.
   */
  width_chars: number
  ops: PreviewOp[]
}

/**
 * Runtime guard for a `preview_*` answer.
 *
 * `invoke<T>` is a compile-time claim, not a guarantee: a backend that changes
 * its shape, a future command, or a serialization failure can deliver
 * `undefined`, `null`, or an object whose `ops` is not an array. The preview
 * renders `ops` and reads `doc_type` directly, so an unchecked payload would
 * either throw inside the renderer or — worse — be mistaken for an empty
 * document. Callers must treat a false result as a failure.
 */
export function isPrintPreview(value: unknown): value is PrintPreview {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<PrintPreview>
  return (
    typeof candidate.doc_type === 'string' &&
    typeof candidate.paper_mm === 'number' &&
    typeof candidate.width_chars === 'number' &&
    Array.isArray(candidate.ops)
  )
}

export const api = {
  tables: () => call<TableView[]>('list_tables'),
  tableCounters: () => call<TableCounters>('table_lifecycle_counters'),
  /**
   * The tables KPI read: the SAME shift-scoped `table_sessions` counters the
   * close-shift dialog reports. The day-scoped `tableCounters` above stays for
   * any day-level consumer; the band must never use it.
   */
  shiftCounters: () => call<TableCounters>('shift_lifecycle_counters'),
  setTableCount: (count: number) => call<void>('set_table_count', { count }),
  openTakeaways: () => call<TakeawayView[]>('list_open_takeaway_orders'),
  openTable: (table_id: number) => call<number>('open_table', { table_id }),
  closeEmptyTable: (table_id: number) => call<void>('close_empty_table', { table_id }),
  startOrder: (table_id: number) => call<number>('start_order', { table_id }),
  startTakeaway: () => call<number>('start_takeaway'),
  discardOrder: (order_id: number) => call<void>('discard_order', { order_id }),
  getOrder: (order_id: number) => call<PosOrder>('get_order', { order_id }),
  addLine: (order_id: number, product_id: number, quantity: number) =>
    call<PosOrder>('add_order_line', { order_id, product_id, quantity }),
  setQty: (order_id: number, line_id: number, quantity: number) =>
    call<PosOrder>('set_line_quantity', { order_id, line_id, quantity }),
  removeLine: (order_id: number, line_id: number) =>
    call<PosOrder>('remove_order_line', { order_id, line_id }),
  products: (department?: string) =>
    call<Product[]>('list_products', { department: department ?? null, active_only: true }),
  preview: (
    order_id: number,
    discount_mode: string | null,
    discount_value: number | null,
    service_charge_minor: number,
  ) =>
    call<OrderPreview>('preview_order', {
      order_id,
      discount_mode,
      discount_value,
      discount_pin: null,
      service_charge_minor,
    }),
  /**
   * Apply a discount amount (or clear it with `null`).
   *
   * The amount is open-ended: it is not limited to the configured quick-pick
   * options, only to what the order can carry. Applying one REQUIRES the cafe's
   * ONE shared 4-digit discount PIN, which the backend verifies — the UI can
   * never bypass it. Clearing a discount needs no PIN.
   */
  setDiscount: (
    order_id: number,
    amount_minor: number | null,
    discount_pin: string | null = null,
  ) =>
    call<PosOrder>('set_order_discount', {
      order_id,
      discount_mode: amount_minor === null ? null : 'FIXED',
      discount_value: amount_minor,
      discount_pin,
    }),
  checkout: (input: CheckoutInput) => call<CheckoutResult>('checkout_order', { input }),
  getInvoice: (invoice_id: number) =>
    call<[InvoiceRow, InvoiceLine[]]>('get_invoice', { invoice_id }),
  invoices: (args: InvoiceFilter) =>
    call<InvoiceRow[]>('search_invoices', {
      business_day_id: args.business_day_id ?? null,
      query: args.query ?? null,
      status: args.status ?? null,
      method: args.method ?? null,
    }),
  /**
   * The issued wash tickets of a business day — the twin of `invoices`, read
   * through the same business-day resolution so the two pages can never
   * disagree about which day they are showing.
   */
  washTickets: (args: WashTicketFilter) =>
    call<WashTicketRow[]>('list_daily_wash_tickets', {
      business_day_id: args.business_day_id ?? null,
      query: args.query ?? null,
      order_status: args.order_status ?? null,
    }),
  customers: (query: string) => call<CustomerWithCars[]>('search_customers', { query }),
  createCustomer: (input: { name: string; phone?: string | null; notes?: string | null }) =>
    call<number>('create_customer', { input }),
  createCar: (input: {
    customer_id: number
    plate_no: string
    car_model?: string | null
    notes?: string | null
  }) => call<number>('create_car', { input }),
  attachCustomer: (input: { order_id: number; customer_id: number; car_plate?: string | null }) =>
    call<void>('attach_customer', { input }),
  detachCustomer: (order_id: number) => call<void>('detach_customer', { order_id }),
  orderCustomer: (order_id: number) =>
    call<{ id: number; name: string; phone: string | null } | null>('get_order_customer', {
      order_id,
    }),
  ticket: (order_id: number) => call<TicketData>('issue_wash_ticket', { order_id }),
  printInvoice: (invoice_id: number, force?: boolean) =>
    call<PrintOutcome>('print_invoice', { invoice_id, force: force ?? null }),
  printTicket: (order_id: number, force?: boolean) =>
    call<PrintOutcome>('print_wash_ticket', { order_id, force: force ?? null }),
  /** Read-only preview of the current, unfinalized order. */
  printPreviewOrder: (
    order_id: number,
    discount_mode?: string | null,
    discount_value?: number | null,
    service_charge_minor?: number,
  ) =>
    call<PrintPreview>('preview_order_document', {
      order_id,
      discount_mode: discount_mode ?? null,
      discount_value: discount_value ?? null,
      service_charge_minor: service_charge_minor ?? 0,
    }),
  /** Read-only preview of a persisted invoice (never prints, never records). */
  printPreviewInvoice: (invoice_id: number) =>
    call<PrintPreview>('preview_invoice', { invoice_id }),
  /** Read-only preview of an issued wash ticket (never allocates a number). */
  printPreviewTicket: (order_id: number) => call<PrintPreview>('preview_wash_ticket', { order_id }),
  printPreviewShift: (shift_id: number) => call<PrintPreview>('preview_shift_report', { shift_id }),
  printPreviewDay: (day_id: number) => call<PrintPreview>('preview_day_report_cmd', { day_id }),
  creditAccounts: () => call<CreditAccount[]>('list_credit_accounts'),
  settleCredit: (customer_id: number, amount: number) =>
    call<string>('settle_credit', { customer_id, amount }),
  printShift: (shift_id: number, force?: boolean) =>
    call<PrintOutcome>('print_shift_report', { shift_id, force: force ?? null }),
  printDay: (day_id: number, force?: boolean) =>
    call<PrintOutcome>('print_day_report_cmd', { day_id, force: force ?? null }),
}

export interface DiscountSel {
  mode: string | null
  value: number | null
}

export interface OrderCustomer {
  id: number
  name: string
  phone: string | null
}

export interface ServiceChargeConfig {
  amounts: number[]
}

/**
 * Admin-configured discount QUICK-PICK amounts (minor units). These are
 * shortcuts the POS offers the cashier — NOT a whitelist and NOT a ceiling:
 * any positive amount up to the order subtotal can be applied once authorized.
 */
export interface DiscountOptionsConfig {
  amounts: number[]
}

/**
 * Administrator-facing status of the ONE shared discount-authorization PIN.
 * A boolean only, never the PIN: the Argon2id hash stays in the backend.
 */
export interface DiscountAuthorizationConfig {
  configured: boolean
}

export interface CreditConfig {
  enabled: boolean
  mode: 'LIST' | 'ALL'
  allowed_customer_ids: number[]
}

/**
 * How many calendar months the monthly sales comparison chart covers.
 *
 * The supported windows are a closed set configured in Dev Settings; the backend
 * owns that set and validates every value, so this is a mirror of it, not a
 * second source of truth.
 */
export interface MonthlySalesPeriodConfig {
  months: number
}

/** The windows Dev Settings offers, mirroring the backend's accepted set. */
export const MONTHLY_SALES_PERIOD_MONTHS = [6, 12, 18, 24] as const

/**
 * The two revenue departments a monthly target exists for.
 *
 * A CLOSED SET, matching the backend exactly. It is deliberately NOT the set of
 * order types: `TAKEAWAY` and `HYBRID` are not revenue departments, and a
 * takeaway's money is counted against the department its invoice lines are in.
 */
export type RevenueDepartment = 'CAFE' | 'WASH'

/** The cafe-wide default monthly targets, used by every month with no override. */
export interface RevenueTargetDefaults {
  cafe_minor: number
  wash_minor: number
}

/**
 * The ACTIVE month's own overrides. Each department is independently absent,
 * which is what "override the cafe figure only" means: an absent department
 * follows the default, and only that department.
 */
export interface MonthTargetOverride {
  cafe_minor: number | null
  wash_minor: number | null
}

/** One department's effective target for one month, and where it came from. */
export interface MonthlyTarget {
  /** `YYYY-MM`, resolved by the backend clock in the business timezone. */
  month: string
  department: RevenueDepartment
  /** Effective target: the month's override if it has one, else the default. */
  target_minor: number
  /** Whether THIS month overrides the default — stated, never inferred. */
  overridden: boolean
}

/**
 * Everything Dev Settings needs to show the target group: the defaults, the
 * active month's own overrides, and the effective pair they resolve to.
 *
 * The month travels with the read, so the screen labels the month the BACKEND
 * considers active rather than asking the browser which month it thinks it is.
 */
export interface RevenueTargetsView {
  month: string
  defaults: RevenueTargetDefaults
  overrides: MonthTargetOverride
  targets: MonthlyTarget[]
}

export const settingsApi = {
  serviceCharge: () => call<ServiceChargeConfig>('get_service_charge'),
  setServiceCharge: (config: ServiceChargeConfig) => call<void>('set_service_charge', { config }),
  discountOptions: () => call<DiscountOptionsConfig>('get_discount_options'),
  setDiscountOptions: (config: DiscountOptionsConfig) =>
    call<void>('set_discount_options', { config }),
  /** MANAGER+ status of the ONE shared discount PIN (never the PIN itself). */
  discountAuthorization: () => call<DiscountAuthorizationConfig>('get_discount_authorization'),
  /** MANAGER+ sets/changes the ONE shared 4-digit discount PIN, cafe-wide. */
  setDiscountPin: (pin: string) => call<void>('set_discount_authorization_pin', { pin }),
  credit: () => call<CreditConfig>('get_credit_config'),
  setCredit: (config: CreditConfig) => call<void>('set_credit_config', { config }),
  /** The configured monthly sales chart window (12 months when never set). */
  monthlySalesPeriod: () => call<MonthlySalesPeriodConfig>('get_monthly_sales_period'),
  setMonthlySalesPeriod: (config: MonthlySalesPeriodConfig) =>
    call<void>('set_monthly_sales_period', { config }),
  /** ADMIN reads the monthly revenue targets: defaults, this month's overrides, and the effective pair. */
  revenueTargets: () => call<RevenueTargetsView>('get_revenue_targets'),
  /** ADMIN saves the cafe-wide DEFAULT targets. It can never touch a month's override. */
  setRevenueTargets: (defaults: RevenueTargetDefaults) =>
    call<void>('set_revenue_targets', { defaults }),
  /**
   * ADMIN sets — or, with `null`, clears — ONE department's override for the
   * CURRENT month. The month is not an argument: the backend decides which month
   * is active, so a stale client cannot write an override into the wrong month.
   */
  setRevenueTargetOverride: (department: RevenueDepartment, amountMinor: number | null) =>
    call<void>('set_revenue_target_override', { department, amount_minor: amountMinor }),
}

export interface CheckoutInput {
  order_id: number
  method: string
  discount_mode: string | null
  discount_value: number | null
  discount_pin?: string | null
  service_charge_minor: number
  received: number | null
}

export interface InvoiceFilter {
  business_day_id?: number
  query?: string
  status?: string
  method?: string
}

/**
 * The daily wash-ticket read. The day and the free text are resolved by the
 * BACKEND, exactly like `InvoiceFilter` — the page never filters a list it
 * already downloaded, because that would be a second, drifting rule about
 * what belongs to the day.
 */
export interface WashTicketFilter {
  business_day_id?: number
  query?: string
  order_status?: string
}

export interface DayTotals {
  invoices_count: number
  cafe_sales: number
  wash_sales: number
  subtotal: number
  discounts: number
  service_charges: number
  total_sales: number
  cash: number
  card: number
  credit: number
  expenses: number
}

export interface TodaySummary {
  day: { id: number; day_date: string; status: string } | null
  totals: DayTotals
}
