import {
  Boxes,
  ClipboardList,
  Clock,
  Lock,
  Package,
  Percent,
  Receipt,
  ScrollText,
  Settings,
  Store,
  User,
  Users,
  Wallet,
  type LucideIcon,
} from '@/components/ui/icon'

/**
 * Operation-type presentation — the single source of truth for how a recorded
 * operation is identified, named and coloured across the operations history.
 *
 * It is derived from what the backend actually records: every `action` string
 * passed to `services::audit::record` is `<namespace>.<verb>` (e.g.
 * `invoice.created`, `shift.closed`), and every `entity_type` is one of the
 * entity names in that same call. This module groups those namespaces into a
 * small number of human-facing operation types, so the table can give each row
 * a clear visual identity without inventing values the log does not contain.
 *
 * Rules this module exists to enforce:
 *   - the raw action/entity code never reaches the screen;
 *   - colour is assigned per TYPE, not per row, so the list stays calm;
 *   - an unrecognised code still renders — it falls into a neutral "other"
 *     bucket and a generic Arabic label rather than leaking the code.
 *
 * Every label is referenced as a translation key; nothing here is display text.
 */

/** The operation-type buckets an action namespace can fall into. */
export type OperationGroupId =
  | 'auth'
  | 'user'
  | 'staff'
  | 'catalog'
  | 'customer'
  | 'tables'
  | 'invoices'
  | 'credit'
  | 'discount'
  | 'inventory'
  | 'expenses'
  | 'operations'
  | 'settings'
  | 'other'

/**
 * A namespace (the part of the action before the first dot) maps to exactly one
 * operation type. These are the namespaces the backend writes today.
 */
const NAMESPACE_GROUP: Record<string, OperationGroupId> = {
  auth: 'auth',
  user: 'user',
  employee: 'staff',
  attendance: 'staff',
  advance: 'staff',
  payroll: 'staff',
  catalog: 'catalog',
  customer: 'customer',
  car: 'customer',
  table: 'tables',
  order: 'tables',
  invoice: 'invoices',
  credit: 'credit',
  discount: 'discount',
  inventory: 'inventory',
  expense: 'expenses',
  shift: 'operations',
  day: 'operations',
  settings: 'settings',
}

/** The operation type a recorded action belongs to. */
export function operationGroupOf(action: string): OperationGroupId {
  const namespace = action.split('.')[0] ?? ''
  return NAMESPACE_GROUP[namespace] ?? 'other'
}

/** Translation key for an operation type's Arabic name. */
export function operationGroupLabelKey(group: OperationGroupId): string {
  return `audit.groups.${group}`
}

/** Translation key for an entity type's Arabic name, with a safe fallback. */
export function entityLabelKey(entityType: string): string {
  return `audit.entities.${entityType}`
}

/** True when the catalogue has a real Arabic name for this entity type. */
export function isKnownEntity(entityType: string): boolean {
  return KNOWN_ENTITIES.has(entityType)
}

/** Minimal translator shape, satisfied by i18next's `t`. */
type LabelTranslator = (key: string) => string

/**
 * Localised label for a recorded entity type, degrading to a neutral noun.
 *
 * The entity type is a table name (`business_day`, `credit_account`), so an
 * unmapped one must NOT be echoed: it degrades to a generic Arabic noun and the
 * raw code stays in the ADMIN-only technical section.
 */
export function entityLabel(t: LabelTranslator, entityType: string): string {
  if (!entityType) return t('audit.entityFallback')
  return isKnownEntity(entityType) ? t(entityLabelKey(entityType)) : t('audit.entityFallback')
}

/**
 * Localised label for a recorded action, degrading to a generic noun.
 *
 * This is the central operation-name mapping: every surface (table, filter,
 * search, details, summary) names an operation through this function, so a
 * technical code such as `invoice.created` can never be rendered directly.
 */
export function actionLabel(t: LabelTranslator, action: string): string {
  const key = `audit.actions.${action}`
  const label = t(key)
  // i18next echoes the key back when a translation is missing, so that echo is
  // exactly the signal that the catalogue has no Arabic name for this action.
  return label === key ? t('audit.actionFallback') : label
}

/**
 * Entity types the backend records, mirrored from the audit call sites. Kept
 * as a set so an unrecognised entity degrades to a neutral label instead of
 * rendering its raw English name.
 */
export const KNOWN_ENTITIES = new Set([
  'product',
  'category',
  'invoice',
  'order',
  'table',
  'shift',
  'business_day',
  'day_closing',
  'credit_account',
  'expense',
  'customer',
  'car',
  'user',
  'employee',
  'employee_advance',
  'payroll_run',
  'attendance_day',
  'settings',
])

/**
 * Icons and tones per operation type.
 *
 * The icon is the operation's own affordance (a receipt, a shift clock, a
 * stock box), not decoration, so a reader can scan the log by shape. The tone
 * is deliberately limited to the existing Badge vocabulary — colour carries
 * grouping information only, never a success/failure judgement, because the
 * audit log records completed actions and has no result field.
 */
export const OPERATION_GROUPS: Record<OperationGroupId, { icon: LucideIcon; tone: OperationTone }> =
  {
    auth: { icon: Lock, tone: 'neutral' },
    user: { icon: Users, tone: 'neutral' },
    staff: { icon: Users, tone: 'neutral' },
    catalog: { icon: Package, tone: 'neutral' },
    customer: { icon: User, tone: 'neutral' },
    tables: { icon: Store, tone: 'info' },
    invoices: { icon: Receipt, tone: 'brand' },
    credit: { icon: Wallet, tone: 'info' },
    discount: { icon: Percent, tone: 'neutral' },
    inventory: { icon: Boxes, tone: 'neutral' },
    expenses: { icon: ScrollText, tone: 'neutral' },
    operations: { icon: Clock, tone: 'info' },
    settings: { icon: Settings, tone: 'neutral' },
    other: { icon: ClipboardList, tone: 'neutral' },
  }

/** The Badge variants this feature is allowed to use. */
export type OperationTone = 'neutral' | 'brand' | 'info' | 'success' | 'warning' | 'danger'

/** The operation types present in a list of actions, in a stable display order. */
export function presentGroups(actions: readonly string[]): OperationGroupId[] {
  const found = new Set(actions.map(operationGroupOf))
  return GROUP_ORDER.filter((group) => found.has(group))
}

/** Fixed display order, so the filter control never reorders itself. */
const GROUP_ORDER: readonly OperationGroupId[] = [
  'invoices',
  'credit',
  'discount',
  'operations',
  'tables',
  'catalog',
  'inventory',
  'expenses',
  'customer',
  'staff',
  'user',
  'auth',
  'settings',
  'other',
]
