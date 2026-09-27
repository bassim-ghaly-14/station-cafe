import { formatMinorMoney } from '@/lib/money'
import { formatDate } from '@/lib/date'
import type { AuditEntry } from '@/services/opsApi'
import { actionLabel } from './operationTypes'

/**
 * Operation presentation — the ONE place where a recorded audit row is turned
 * into something a person can read.
 *
 * The audit table stores a technical snapshot (`after_json`) whose shape is
 * decided by whichever service wrote the row, so it cannot be rendered as an
 * interface: part of it is English codes, piastre amounts, internal row ids and
 * column names. This module is the boundary between that storage and the screen.
 *
 * Three rules it enforces:
 *
 *  1. ALLOW-LIST, NOT DENY-LIST. `OPERATION_FIELDS` says, per recorded action,
 *     exactly which stored keys are safe and meaningful to show. A key nobody
 *     declared can never reach a user, so a payload written by a future version
 *     of the app degrades to "no details" instead of dumping itself on screen.
 *  2. NO CODE EVER LEAKS. A stored code (`CASH`, `TAKEAWAY`, `REVERSED`, an
 *     expense category) is resolved through a translation and DROPPED when it has
 *     no Arabic name. The raw code stays available to ADMIN through the
 *     technical section, which is the only place it belongs.
 *  3. NO INTERNAL IDS. Database primary keys (`session_id`, `wash_employee_id`,
 *     `category_id`) are deliberately absent from the allow-list; business
 *     numbers a manager actually uses (`invoice_no`, `plate`) are present.
 *
 * The same helpers serve both audiences: MANAGER sees the summary and the
 * business rows, ADMIN additionally gets the raw technical block.
 */

/** Translator shape used across this module (i18next's `t` satisfies it). */
export type AuditTranslate = (key: string, options?: Record<string, unknown>) => string

/** How one stored value is rendered once it is known to be safe. */
type ValueKind = 'text' | 'money' | 'count' | 'date' | 'flag' | 'code'

type FieldPresentation = {
  labelKey: string
  kind: ValueKind
  /**
   * Candidate translation-key prefixes for a coded value, tried in order. A
   * code with no Arabic name under any of them is dropped, never rendered raw.
   */
  codePrefixes?: readonly string[]
}

/**
 * Presentation of every stored key this feature is allowed to show.
 *
 * `money` values are piastres, exactly as the backend stores them, and go
 * through the shared `formatMinorMoney` so they can never be mistaken for
 * pounds. `code` values are domain constants whose Arabic names already exist
 * elsewhere in the app (payment methods, item types, departments, attendance
 * states) and are REUSED here rather than re-invented.
 */
const FIELD_PRESENTATION: Record<string, FieldPresentation> = {
  name: { labelKey: 'audit.fields.name', kind: 'text' },
  phone: { labelKey: 'audit.fields.phone', kind: 'text' },
  plate: { labelKey: 'audit.fields.plate', kind: 'text' },
  car_model: { labelKey: 'audit.fields.car_model', kind: 'text' },
  price_minor: { labelKey: 'audit.fields.price_minor', kind: 'money' },
  department: { labelKey: 'audit.fields.department', kind: 'code', codePrefixes: ['catalog'] },
  type: { labelKey: 'audit.fields.type', kind: 'code', codePrefixes: ['catalog'] },
  is_active: { labelKey: 'audit.fields.is_active', kind: 'flag' },
  stock_quantity: { labelKey: 'audit.fields.stock_quantity', kind: 'count' },
  min_quantity: { labelKey: 'audit.fields.min_quantity', kind: 'count' },
  invoice_no: { labelKey: 'audit.fields.invoice_no', kind: 'text' },
  total: { labelKey: 'audit.fields.total', kind: 'money' },
  method: { labelKey: 'audit.fields.method', kind: 'code', codePrefixes: ['pay.method'] },
  discount: { labelKey: 'audit.fields.discount', kind: 'money' },
  discount_minor: { labelKey: 'audit.fields.discount_minor', kind: 'money' },
  service_charge: { labelKey: 'audit.fields.service_charge', kind: 'money' },
  order_type: {
    labelKey: 'audit.fields.order_type',
    kind: 'code',
    codePrefixes: ['audit.values.orderType'],
  },
  takeaway_no: { labelKey: 'audit.fields.takeaway_no', kind: 'text' },
  reason: { labelKey: 'audit.fields.reason', kind: 'code', codePrefixes: ['inventory.reason'] },
  note: { labelKey: 'audit.fields.note', kind: 'text' },
  amount: { labelKey: 'audit.fields.amount', kind: 'money' },
  status: {
    labelKey: 'audit.fields.status',
    kind: 'code',
    codePrefixes: ['audit.values.status', 'invoice.status', 'employees.status', 'employees.state'],
  },
  change: { labelKey: 'audit.fields.change', kind: 'count' },
  category: {
    labelKey: 'audit.fields.category',
    kind: 'code',
    codePrefixes: ['audit.values.category'],
  },
  date: { labelKey: 'audit.fields.date', kind: 'date' },
  recurring: { labelKey: 'audit.fields.recurring', kind: 'flag' },
  paid_from_cash: { labelKey: 'audit.fields.paid_from_cash', kind: 'flag' },
  opening_cash: { labelKey: 'audit.fields.opening_cash', kind: 'money' },
  expected_cash: { labelKey: 'audit.fields.expected_cash', kind: 'money' },
  actual_cash: { labelKey: 'audit.fields.actual_cash', kind: 'money' },
  difference: { labelKey: 'audit.fields.difference', kind: 'money' },
  cash_expenses: { labelKey: 'audit.fields.cash_expenses', kind: 'money' },
  expenses: { labelKey: 'audit.fields.expenses', kind: 'money' },
  invoices_count: { labelKey: 'audit.fields.invoices_count', kind: 'count' },
  total_sales: { labelKey: 'audit.fields.total_sales', kind: 'money' },
  cash: { labelKey: 'audit.fields.cash', kind: 'money' },
  card: { labelKey: 'audit.fields.card', kind: 'money' },
  credit: { labelKey: 'audit.fields.credit', kind: 'money' },
  business_date: { labelKey: 'audit.fields.business_date', kind: 'date' },
  action: {
    labelKey: 'audit.fields.action',
    kind: 'code',
    codePrefixes: ['audit.values.attendance'],
  },
  employee_type: {
    labelKey: 'audit.fields.employee_type',
    kind: 'code',
    codePrefixes: ['employees.type'],
  },
  base_salary: { labelKey: 'audit.fields.base_salary', kind: 'money' },
  period: { labelKey: 'audit.fields.period', kind: 'text' },
  attendance_days: { labelKey: 'audit.fields.attendance_days', kind: 'count' },
  absence_days: { labelKey: 'audit.fields.absence_days', kind: 'count' },
  leave_days: { labelKey: 'audit.fields.leave_days', kind: 'count' },
  advances: { labelKey: 'audit.fields.advances', kind: 'money' },
  deductions: { labelKey: 'audit.fields.deductions', kind: 'money' },
  net_salary: { labelKey: 'audit.fields.net_salary', kind: 'money' },
  active_count: { labelKey: 'audit.fields.active_count', kind: 'count' },
}

/**
 * The safe, ordered business fields of every action the backend records today.
 *
 * Mirrored from the `after_json` objects passed to `services::audit::record`, so
 * every key listed here is one the log really stores. An action absent from this
 * table is not an error: it is either a delete (whose business values live in
 * `before_json`, which the log reader does not expose) or a record written by an
 * older/newer build — either way the user gets the safe generic description.
 */
const OPERATION_FIELDS: Record<string, readonly string[]> = {
  // catalog
  'catalog.product_created': ['name', 'price_minor', 'department', 'type', 'stock_quantity'],
  'catalog.product_updated': ['name', 'price_minor', 'stock_quantity'],
  'catalog.product_renamed': ['name'],
  'catalog.price_changed': ['name', 'price_minor'],
  'catalog.product_activation_changed': ['name', 'is_active'],
  'catalog.product_deleted': ['name', 'price_minor', 'department'],
  'catalog.category_created': ['name'],
  // customers
  'customer.created': ['name', 'phone'],
  'customer.updated': ['name', 'phone'],
  // A delete stores its business values in `before_json`, which the log read does
  // not expose — so there is nothing safe to show and nothing to invent.
  'customer.deleted': [],
  'car.created': ['plate', 'car_model'],
  // sales floor
  'table.opened': [],
  'table.closed_empty': [],
  'table.count_changed': ['active_count'],
  'order.discarded': ['order_type'],
  // invoices & money
  'invoice.created': [
    'invoice_no',
    'total',
    'method',
    'discount',
    'service_charge',
    'order_type',
    'takeaway_no',
  ],
  'invoice.wash_employee_assigned': [],
  'credit.settled': ['amount', 'status'],
  'discount.authorized': ['discount_minor'],
  // stock
  'inventory.adjusted': ['change', 'reason', 'note'],
  'inventory.min_changed': ['min_quantity'],
  // expenses
  'expense.created': ['category', 'amount', 'date', 'recurring', 'paid_from_cash'],
  // day & shift
  'shift.opened': ['opening_cash'],
  'shift.closed': [
    'expected_cash',
    'actual_cash',
    'difference',
    'expenses',
    'cash_expenses',
    'invoices_count',
    'status',
  ],
  'day.settled': ['total_sales', 'cash', 'card', 'credit', 'expenses'],
  'day.opened': [],
  'day.closed': [
    'total_sales',
    'cash',
    'card',
    'credit',
    'expenses',
    'expected_cash',
    'actual_cash',
    'status',
  ],
  // employees, attendance, advances, payroll
  'employee.created': ['name', 'employee_type', 'base_salary'],
  'employee.updated': ['name', 'phone'],
  'employee.deleted': [],
  'employee.salary_changed': ['base_salary'],
  'employee.activated': ['status'],
  'employee.deactivated': ['status'],
  'attendance.check_in': ['business_date', 'action'],
  'attendance.check_out': ['business_date', 'action'],
  'attendance.absent': ['business_date', 'action'],
  'attendance.leave': ['business_date', 'action'],
  'attendance.corrected': ['business_date', 'action'],
  'attendance.override': ['business_date', 'action'],
  'advance.created': ['amount', 'date', 'reason'],
  'advance.reversed': ['status'],
  'payroll.created': [
    'period',
    'base_salary',
    'attendance_days',
    'absence_days',
    'leave_days',
    'advances',
    'deductions',
    'net_salary',
  ],
  'payroll.finalized': ['status', 'net_salary'],
  // auth & settings: the records exist, but they carry no business value a
  // manager can act on — the safe generic description is the honest answer.
  'auth.login': [],
  'user.password_changed': [],
  'settings.service_charge_changed': [],
  'settings.discount_authorization_changed': [],
  'settings.discount_options_changed': [],
  'settings.monthly_sales_period_changed': [],
  'settings.printer_changed': [],
  'settings.credit_rules_changed': [],
}

/** The safe business fields declared for a recorded action, in display order. */
export function operationFields(action: string): readonly string[] {
  return OPERATION_FIELDS[action] ?? []
}

/** One business row of the details view: an Arabic label and a readable value. */
export type BusinessDetail = { label: string; value: string }

/**
 * The business rows of one record, in the declared order.
 *
 * Returns an empty list — never a raw dump — when the record carries no payload,
 * an unparseable payload, only unknown keys, or only codes with no Arabic name.
 */
export function businessDetails(t: AuditTranslate, entry: AuditEntry): BusinessDetail[] {
  const payload = parsePayload(entry.after_json)
  if (!payload) return []
  const details: BusinessDetail[] = []
  for (const key of operationFields(entry.action)) {
    const presentation = FIELD_PRESENTATION[key]
    if (!presentation) continue
    const value = formatValue(t, presentation, payload[key])
    if (value === null) continue
    details.push({ label: t(presentation.labelKey), value })
  }
  return details
}

/**
 * One plain sentence describing what happened, in the operation's own words.
 *
 * Built from the same translated operation name the table shows, so the details
 * view can never describe something the list did not already say — and an
 * unrecognised action still produces a safe sentence rather than a code.
 */
export function operationSummary(t: AuditTranslate, entry: AuditEntry): string {
  return t('audit.details.summaryText', { action: actionLabel(t, entry.action) })
}

/**
 * A single scannable line for the table's "التفاصيل" column.
 *
 * Deliberately value-only (no labels): at row density the labels cost more width
 * than they carry meaning, and the same values are spelled out with their labels
 * when the row is opened.
 */
export function businessHighlights(t: AuditTranslate, entry: AuditEntry, limit = 2): string {
  return businessDetails(t, entry)
    .slice(0, limit)
    .map((detail) => detail.value)
    .join(' · ')
}

/**
 * The ADMIN-only technical section: the recorded codes and the stored payload.
 *
 * Returned as a single pre-formatted block so the raw viewer stays in ONE place
 * (the existing pretty-printer) instead of being rebuilt per audience.
 */
export function technicalSnapshot(raw: string | null): string {
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    // A payload that does not parse is still a recorded value: show it as stored
    // rather than losing the information to a formatting problem.
    return raw
  }
}

/**
 * Whether this viewer may see the technical section.
 *
 * ADMIN only, and it FAILS CLOSED: a missing/loading/unknown session is treated
 * as "not technical". The backend keeps its own MANAGER-level gate on `list_audit`
 * — this is the presentation half of the same rule, not a replacement for it.
 */
export function canViewTechnicalDetails(role: string | null | undefined): boolean {
  return role === 'ADMIN'
}

/** Parse the stored payload, tolerating null, malformed and non-object values. */
function parsePayload(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}
/** Render one declared value, or `null` when it must not be shown. */
function formatValue(
  t: AuditTranslate,
  presentation: FieldPresentation,
  value: unknown,
): string | null {
  switch (presentation.kind) {
    case 'text': {
      if (typeof value !== 'string' && typeof value !== 'number') return null
      const text = String(value).trim()
      return text === '' ? null : text
    }
    case 'money': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      return formatMinorMoney(value)
    }
    case 'count': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      return new Intl.NumberFormat('en-US').format(value)
    }
    case 'date': {
      if (typeof value !== 'string' || value.trim() === '') return null
      return formatDate(value)
    }
    case 'flag': {
      if (typeof value !== 'boolean') return null
      return value ? t('app.enabled') : t('app.disabled')
    }
    case 'code': {
      if (typeof value !== 'string' || value.trim() === '') return null
      return codeLabel(t, presentation.codePrefixes ?? [], value)
    }
  }
}

/**
 * Resolve a stored constant to its Arabic name, or drop it.
 *
 * The comparison against the key is how i18next reports "no translation here",
 * which is the only reliable signal available — and it is what keeps an
 * unrecognised constant off the screen instead of printing `SOMETHING_NEW`.
 */
function codeLabel(t: AuditTranslate, prefixes: readonly string[], code: string): string | null {
  for (const prefix of prefixes) {
    const key = `${prefix}.${code}`
    const label = t(key)
    if (label !== key && label !== '') return label
  }
  return null
}
