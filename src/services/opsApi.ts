/**
 * Typed wrappers over the inventory / expenses / reports / audit command surface.
 *
 * The sales reads are NOT here: they live in `salesApi`, backed by
 * `repositories::sales_analytics`, which is the single authoritative sales
 * aggregation for the whole application. This module used to expose
 * `salesByDay` and `productSales`; both were superseded and removed, so no
 * second — and subtly different — sales rule can survive.
 */
import { call } from './ipc'
import type { DayTotals, PrintOutcome } from './posApi'

export interface AnalyticsCategoryValue {
  id: string
  value: number
}
export interface AnalyticsChartValue {
  id: string
  total: number
  has_data: boolean
  categories: AnalyticsCategoryValue[]
}
export interface AnalyticsCharts {
  charts: AnalyticsChartValue[]
}

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
  /** Resolved from the backend category table — never hardcoded in the UI. */
  category_name: string
  amount: number
  description: string | null
  expense_date: string
  is_recurring: boolean
  recurrence: string | null
  business_day_id: number | null
  shift_id: number | null
  /** Whether the money physically left the drawer. */
  paid_from_cash: boolean
  user_name: string | null
  user_role: string | null
  created_at: string
}

export interface ExpenseCategory {
  code: string
  name_ar: string
  is_system: boolean
  is_active: boolean
  /**
   * Whether an expense in this category must name an employee.
   *
   * This is DATA from the backend, not a code the UI recognises: the form shows
   * the employee selector from this flag, so a future employee-linked category
   * needs no change here. Nothing in the frontend may branch on a category code.
   */
  requires_employee: boolean
}

/** One `YYYY-MM` × category cell of the monthly expenses report. */
export interface ExpenseMonthRow {
  /** The STABLE `YYYY-MM` grouping key — never a localized month name. */
  month: string
  /** The domain category code — the stable series key. */
  category: string
  /** The Arabic label resolved from the category table, for display only. */
  category_name: string
  count: number
  amount: number
}

/** One expense category as a chart series, as the report ordered it. */
export interface ExpenseMonthlyCategory {
  code: string
  name_ar: string
  total: number
}

export interface ExpenseMonthlyReport {
  months: ExpenseMonthRow[]
  categories: ExpenseMonthlyCategory[]
}

/**
 * The monthly series AND the calendar window it describes.
 *
 * The window travels with the data on purpose: this report states its own
 * trailing period, so the chart labels what it shows instead of borrowing the
 * page's business-day filter.
 */
export interface ExpenseMonthlyWindow {
  from: string
  to: string
  report: ExpenseMonthlyReport
}

/**
 * One department's month, as the backend resolved it.
 *
 * `target_minor` is the month's EFFECTIVE target — a per-month override is
 * already applied by the one resolver, so the UI never re-resolves it. There is
 * deliberately no combined/global target anywhere in this payload: Cafe and Wash
 * are independent targets and must never be summed or averaged.
 */
export interface MonthlyPerformance {
  /** Revenue the department earned in the month (piastres). */
  actual_minor: number
  /** The month's effective target (piastres). */
  target_minor: number
  /** Whether this month overrides the cafe-wide default. */
  overridden: boolean
  /**
   * Two-decimal percentage string, or `null` when there is NO target. `null` is
   * the established "no target" answer everywhere in Station — never `0`, which
   * would claim nothing was achieved when nothing was measured.
   */
  achievement_percent: string | null
}

/** One month's money. `net_minor` is `revenue_minor - expenses_minor`. */
export interface MonthlyMoney {
  revenue_minor: number
  expenses_minor: number
  net_minor: number
}

/**
 * The one-page executive summary of a single business month.
 *
 * Every figure is already calculated by the backend from the existing monthly
 * aggregation, the existing expense period total and the existing target
 * resolver. This payload carries nothing else — no chart series, no category
 * ranking, no payment split — because those already exist elsewhere and a
 * second copy of them would only be free to disagree.
 */
export interface MonthlyExecutiveReport {
  /** `YYYY-MM`. */
  month: string
  from: string
  to: string
  /** The month immediately before `month`. */
  previous_month: string
  cafe: MonthlyPerformance
  wash: MonthlyPerformance
  money: MonthlyMoney
  previous: MonthlyMoney
}

/** One category's share of the period's spend. */
export interface ExpenseCategoryTotal {
  category: string
  /** Resolved from the backend category table — never hardcoded in the UI. */
  category_name: string
  count: number
  amount: number
  /** Whole percent of the period total, rounded server-side. */
  share: number
}

/** One business day of the selected period. */
export interface ExpenseDayTotal {
  day_date: string
  count: number
  amount: number
}

/**
 * Everything the expenses workspace shows for ONE period, in one read.
 *
 * Mirrors the backend `ExpenseOverview`. The KPIs, the trend, the category
 * ranking and the list are all driven by the SAME `from`/`to` the page sends, so
 * no section can describe a different window than its neighbour.
 *
 * A period with no expenses is a real answer, not an error: every figure is `0`
 * and both lists are empty.
 */
export interface ExpenseOverview {
  total_amount: number
  expenses_count: number
  /** The part that physically left the drawer — what a closing reconciles. */
  cash_amount: number
  cash_count: number
  recurring_amount: number
  recurring_count: number
  largest_amount: number
  average_amount: number
  /** Largest amount first, exactly as the backend ranked them. */
  categories: ExpenseCategoryTotal[]
  /** Oldest day first — the order a time axis needs. */
  days: ExpenseDayTotal[]
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

/**
 * Printer configuration owned by the printing service. `target` is the only
 * field the UI reasons about (`none`/empty = printing is not set up on this
 * device); the rest is device/runtime detail.
 */
export interface PrintConfig {
  target: string
  arabic_mode: string
  codepage: number
  logo: boolean
  duplicate_window_secs: number
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

/**
 * Stock-adjustment reasons. These are a fixed operational vocabulary enforced
 * by the backend, so the constant is a mirror of the domain rule rather than a
 * place to invent values. (Expense categories are deliberately NOT here: they
 * are data and come from the backend `expense_categories` table.)
 */
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
  /**
   * The whole period's analytics in ONE read: KPIs, the daily trend and the
   * category ranking, all scoped to the same bounds as {@link expenses}. One
   * filter change therefore costs one round trip, and no section can drift onto a
   * different window than another.
   *
   * It also REPLACED the old `expense_total` read: the period total now arrives
   * inside this payload, so the page can no longer show a headline that disagrees
   * with the chart beside it.
   */
  expensesOverview: (from?: string, to?: string) =>
    call<ExpenseOverview>('expenses_overview', { from: from ?? null, to: to ?? null }),
  /**
   * The monthly expenses comparison: spend per calendar month, broken down by
   * expense category.
   *
   * It takes NO `from`/`to`, for the same reason `salesApi.monthly` takes no
   * filter: a calendar comparison is not a range-filtered report. The window is
   * the persisted Dev Settings monthly period, and `months` merely states that
   * configured value explicitly so the screen and the query cannot disagree.
   * When it is absent the backend applies its own stored setting.
   */
  expensesMonthly: (months?: number) =>
    call<ExpenseMonthlyWindow>('expenses_monthly', { months: months ?? null }),
  /** Categories come from the backend table, never from a hardcoded list. */
  expenseCategories: () => call<ExpenseCategory[]>('list_expense_categories'),
  /**
   * MANAGER+ category creation. Only the Arabic name is sent: the backend owns
   * the stable `code` every expense references, so renaming a category later
   * can never break a record that already points at it.
   */
  createExpenseCategory: (name: string) => call<string>('create_expense_category', { name }),
  /**
   * MANAGER+ rename — a normal edit, not a privileged one. The `code` is
   * unchanged, so historical expenses keep their link and only today's label
   * moves.
   */
  renameExpenseCategory: (code: string, name: string) =>
    call<void>('rename_expense_category', { code, name }),
  /**
   * ADMIN-only removal. The backend refuses a MANAGER here even if this call is
   * made directly, and refuses a category that still holds expenses — nothing
   * is ever cascaded.
   */
  deleteExpenseCategory: (code: string) => call<void>('delete_expense_category', { code }),
  /** The caller's own open-shift expenses, for the POS panel. */
  shiftExpenses: () => call<Expense[]>('list_shift_expenses'),
  /**
   * Record an expense. The ONE creation path: the Manager page, the cashier shift
   * panel and the LAN bridge all call this same command, so every rule below holds
   * identically for every role.
   *
   * `employee_id` is required by the backend whenever the chosen category reports
   * `requires_employee` (an advance), and ignored for every other category. It is
   * the stable employee id — never a typed name.
   */
  createExpense: (input: {
    category: string
    amount: number
    description?: string | null
    expense_date?: string | null
    is_recurring: boolean
    recurrence?: string | null
    paid_from_cash?: boolean
    employee_id?: number | null
  }) => call<number>('create_expense', { input }),

  audit: (limit = 100, actionLike?: string) =>
    call<AuditEntry[]>('list_audit', { limit, action_like: actionLike ?? null }),
  printJobs: (limit = 30) => call<PrintJobRow[]>('list_print_jobs', { limit }),
  /** Printer configuration — read-only; `target: "none"` means not set up. */
  printConfig: () => call<PrintConfig>('get_print_config'),
  closedShifts: (from?: string, to?: string) =>
    call<import('@/services/shiftApi').ShiftRow[]>('list_closed_shifts', {
      from: from ?? null,
      to: to ?? null,
    }),
  analyticsCharts: (from?: string, to?: string) =>
    call<AnalyticsCharts>('analytics_charts', { from: from ?? null, to: to ?? null }),
  /**
   * The executive summary of ONE business month.
   *
   * `month` is optional and absent means "the current business month", decided by
   * the backend clock. There is deliberately no `from`/`to` pair: a monthly target
   * is a statement about a calendar month, so this read cannot be narrowed to an
   * arbitrary range the way the analytics charts can.
   */
  monthlyExecutive: (month?: string) =>
    call<MonthlyExecutiveReport>('monthly_executive_report', { month: month ?? null }),

  closedBusinessDays: (from?: string, to?: string) =>
    call<ClosedBusinessDay[]>('list_closed_business_days', { from: from ?? null, to: to ?? null }),
  printTest: () => call<PrintOutcome>('print_test'),
  /**
   * MANAGER+ printer configuration — the existing `set_print_config` command.
   *
   * The printing service is the only thing that reads `target`, so this writes
   * the same setting on both transports (Tauri and the browser) with no second
   * code path: the value is validated and audited server-side either way.
   */
  setPrintConfig: (config: PrintConfig) => call<void>('set_print_config', { config }),
}
