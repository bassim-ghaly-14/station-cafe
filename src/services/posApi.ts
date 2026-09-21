/** Typed wrappers over the POS/cashier command surface. */
import { call } from './ipc'

export interface Product {
  id: number
  name: string
  item_type: 'PRODUCT' | 'SERVICE'
  department: 'CAFE' | 'WASH'
  price_minor: number
  is_active: boolean
  track_inventory: boolean
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
  table_id: number
  user_id: number
  status: string
  customer_id: number | null
  opened_at: string
  waiting_no: number | null
  shift_id: number | null
  lines: OrderLine[]
}

export interface TableView {
  id: number
  label: string
  status: 'EMPTY' | 'OPEN' | 'READY_TO_PAY'
  order_id: number | null
  items_count: number
  total_minor: number
  opened_at: string | null
}

export interface OrderPreview {
  subtotal: number
  discount_mode: string | null
  discount_value: number | null
  discount_minor: number
  service_charge_mode: string
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

export const api = {
  tables: () => call<TableView[]>('list_tables'),
  openTable: (table_id: number) => call<number>('open_table', { table_id }),
  getOrder: (order_id: number) => call<PosOrder>('get_order', { order_id }),
  addLine: (order_id: number, product_id: number, quantity: number) =>
    call<PosOrder>('add_order_line', { order_id, product_id, quantity }),
  setQty: (order_id: number, line_id: number, quantity: number) =>
    call<PosOrder>('set_line_quantity', { order_id, line_id, quantity }),
  removeLine: (order_id: number, line_id: number) =>
    call<PosOrder>('remove_order_line', { order_id, line_id }),
  readyToPay: (order_id: number) => call<void>('mark_ready_to_pay', { order_id }),
  products: (department?: string) =>
    call<Product[]>('list_products', { department: department ?? null, active_only: true }),
  preview: (order_id: number, discount_mode: string | null, discount_value: number | null) =>
    call<OrderPreview>('preview_order', { order_id, discount_mode, discount_value }),
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
  ticket: (order_id: number) => call<TicketData>('issue_wash_ticket', { order_id }),
  printInvoice: (invoice_id: number, force?: boolean) =>
    call<PrintOutcome>('print_invoice', { invoice_id, force: force ?? null }),
  printTicket: (order_id: number, force?: boolean) =>
    call<PrintOutcome>('print_wash_ticket', { order_id, force: force ?? null }),
  creditAccounts: () => call<CreditAccount[]>('list_credit_accounts'),
  settleCredit: (customer_id: number, amount: number) =>
    call<string>('settle_credit', { customer_id, amount }),
  printShift: (shift_id: number, force?: boolean) =>
    call<PrintOutcome>('print_shift_report', { shift_id, force: force ?? null }),
  printDay: (day_id: number, force?: boolean) =>
    call<PrintOutcome>('print_day_report_cmd', { day_id, force: force ?? null }),
}

export interface CheckoutInput {
  order_id: number
  method: string
  discount_mode: string | null
  discount_value: number | null
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
