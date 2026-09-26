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
  is_seed: boolean
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

export interface TableView {
  id: number
  label: string
  status: 'EMPTY' | 'OPEN' | 'OCCUPIED' | 'READY_TO_PAY'
  order_id: number | null
  session_id: number | null
  items_count: number
  total_minor: number
  opened_at: string | null
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
  created_at: string
  shift_id: number | null
  business_day_id: number | null
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

/**
 * Print preview IR — the drawing operations of the document that goes to the
 * printer, in printer order. It is produced by the same Rust template run that
 * generates the ESC/POS bytes, so the preview cannot drift from the real
 * output. Text is already in printed (visual) order for RTL lines.
 */
export interface PreviewTextOp {
  kind: 'text'
  text: string
  align: 'left' | 'center' | 'right'
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
  align: 'left' | 'center' | 'right'
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
  align: 'left' | 'center' | 'right'
}

/** Authoritative financial fields formatted by the backend template. */
export interface PreviewFinancialOp {
  kind: 'financial'
  label: string
  value: string
  total: boolean
  align: 'left' | 'center' | 'right'
}

export interface PreviewCutOp {
  kind: 'cut'
}

export type PreviewOp =
  PreviewTextOp | PreviewLogoOp | PreviewItemOp | PreviewFinancialOp | PreviewFeedOp | PreviewCutOp

export interface PrintPreview {
  doc_type: string
  paper_mm: number
  width_chars: number
  ops: PreviewOp[]
}

export const api = {
  tables: () => call<TableView[]>('list_tables'),
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
      discount_password: null,
      service_charge_minor,
    }),
  /**
   * Apply a discount amount (or clear it with `null`).
   *
   * The amount is open-ended: it is not limited to the configured quick-pick
   * options, only to what the order can carry. Applying one REQUIRES the
   * cashier's own authorization credential, which the backend verifies — the
   * UI can never bypass it. Clearing a discount needs no credential.
   */
  setDiscount: (
    order_id: number,
    amount_minor: number | null,
    discount_password: string | null = null,
  ) =>
    call<PosOrder>('set_order_discount', {
      order_id,
      discount_mode: amount_minor === null ? null : 'FIXED',
      discount_value: amount_minor,
      discount_password,
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

/** Per-cashier discount-authorization flags. A boolean only, never a value. */
export interface StaffDiscountAuthorization {
  user_id: number
  configured: boolean
}

export interface CreditConfig {
  enabled: boolean
  mode: 'LIST' | 'ALL'
  allowed_customer_ids: number[]
}

export const settingsApi = {
  serviceCharge: () => call<ServiceChargeConfig>('get_service_charge'),
  setServiceCharge: (config: ServiceChargeConfig) => call<void>('set_service_charge', { config }),
  discountOptions: () => call<DiscountOptionsConfig>('get_discount_options'),
  setDiscountOptions: (config: DiscountOptionsConfig) =>
    call<void>('set_discount_options', { config }),
  credit: () => call<CreditConfig>('get_credit_config'),
  setCredit: (config: CreditConfig) => call<void>('set_credit_config', { config }),
}

/** Staff management: per-cashier discount authorization (MANAGER+). */
export const staffApi = {
  discountAuthorization: () => call<StaffDiscountAuthorization[]>('list_discount_authorization'),
  setDiscountPassword: (user_id: number, password: string) =>
    call<void>('set_staff_discount_password', { user_id, password }),
}

export interface CheckoutInput {
  order_id: number
  method: string
  discount_mode: string | null
  discount_value: number | null
  discount_password?: string | null
  service_charge_minor: number
  received: number | null
}

export interface InvoiceFilter {
  business_day_id?: number
  query?: string
  status?: string
  method?: string
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
