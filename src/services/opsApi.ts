/** Typed wrappers over inventory / expenses / reports / audit commands. */
import { call } from './ipc'
import type { DayTotals } from './posApi'

export interface StockRow {
  product_id: number
  product_name: string
  department: string
  category_name: string
  item_type: 'PRODUCT' | 'SERVICE'
  quantity: number
  min_quantity: number
}

export interface MovementRow {
  id: number
  product_name: string
  change: number
  reason: string
  note: string | null
  created_at: string
}

export interface Expense {
  id: number
  category: string
  amount: number
  description: string | null
  expense_date: string
  is_recurring: boolean
  recurrence: string | null
  user_name: string | null
  user_role: string | null
  created_at: string
}

export interface SalesByDay {
  day_id: number
  day_date: string
  invoices_count: number
  cafe_sales: number
  wash_sales: number
  total_sales: number
  cash: number
  card: number
  credit: number
  service_charges: number
  discounts: number
  expenses: number
}

export interface ProductSales {
  product_name: string
  department: string
  quantity: number
  total: number
}

export interface AuditEntry {
  id: number
  actor_id: number | null
  actor_name: string | null
  actor_role: string | null
  action: string
  entity_type: string
  entity_id: string | null
  after_json: string | null
  created_at: string
}

export interface PrintJobRow {
  id: number
  doc_type: string
  status: string
  attempts: number
  error: string | null
  created_at: string
}

export interface ClosedBusinessDay {
  closing_id: number
  business_day_id: number
  day_date: string
  status: string
  opened_at: string
  closed_at: string
  closed_by: number
  shift_count: number
  totals: DayTotals
}

export interface InventoryReasons {
  PURCHASE: string
  ADJUSTMENT: string
  WASTE: string
}

export const EXPENSE_CATEGORIES = [
  'MAINTENANCE',
  'SUPPLIES',
  'UTILITY',
  'SALARY',
  'EMERGENCY',
  'OTHER',
] as const

export const STOCK_REASONS = ['PURCHASE', 'ADJUSTMENT', 'WASTE'] as const

export const opsApi = {
  stock: () => call<StockRow[]>('list_stock'),
  movements: (limit = 50) => call<MovementRow[]>('list_stock_movements', { limit }),
  adjustStock: (product_id: number, change: number, reason: string, note?: string | null) =>
    call<void>('adjust_stock', { product_id, change, reason, note: note ?? null }),
  setStockMinimum: (product_id: number, min_quantity: number) =>
    call<void>('set_stock_minimum', { product_id, min_quantity }),

  expenses: (from?: string, to?: string) =>
    call<Expense[]>('list_expenses', { from: from ?? null, to: to ?? null, recurring_only: false }),
  createExpense: (input: {
    category: string
    amount: number
    description?: string | null
    expense_date?: string | null
    is_recurring: boolean
    recurrence?: string | null
  }) => call<number>('create_expense', { input }),

  salesByDay: (from?: string, to?: string) =>
    call<SalesByDay[]>('sales_by_day', { from: from ?? null, to: to ?? null }),
  productSales: (from?: string, to?: string) =>
    call<ProductSales[]>('product_sales', { from: from ?? null, to: to ?? null }),
  audit: (limit = 100, actionLike?: string) =>
    call<AuditEntry[]>('list_audit', { limit, action_like: actionLike ?? null }),
  printJobs: (limit = 30) => call<PrintJobRow[]>('list_print_jobs', { limit }),
  closedShifts: (from?: string, to?: string) =>
    call<import('@/services/shiftApi').ShiftRow[]>('list_closed_shifts', {
      from: from ?? null,
      to: to ?? null,
    }),
  closedBusinessDays: (from?: string, to?: string) =>
    call<ClosedBusinessDay[]>('list_closed_business_days', { from: from ?? null, to: to ?? null }),
  printTest: () => call<{ duplicate_suppressed: boolean }>('print_test'),
}
