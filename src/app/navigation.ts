/**
 * The navigation configuration - the SINGLE source of truth for what Station
 * can navigate to and who is allowed to see it.
 *
 * This array used to live inside `AppShell.tsx`, which meant the desktop
 * sidebar was the only thing that knew the destination list, the order and the
 * per-destination role floor. The moment a second navigation surface existed -
 * the mobile bottom bar and its "More" sheet - that arrangement would have
 * guaranteed the two drift apart, and a role gate would have had to be
 * re-implemented (and eventually re-implemented wrongly) in the new file.
 *
 * Instead there is ONE list, and every surface renders from it:
 *
 *   - `AppShell` desktop sidebar  : all items, in declared order
 *   - `MobileNav` bottom bar       : `primary` items only
 *   - `MobileNav` "More" sheet     : every item again
 *
 * Authorization lives here too, as `minRole`, and is evaluated through the
 * SAME `atLeast()` helper the sidebar has always used, which is backed by
 * `roleRank()` in `@/lib/roles`. A destination is therefore never reachable on
 * mobile that a manager could not already open on the desktop, and the backend
 * remains the real gate - this is a UI convenience, not a boundary.
 */
import {
  BarChart3,
  Boxes,
  HandCoins,
  Package,
  Receipt,
  Settings,
  Store,
  UserRound,
  Users,
  type LucideIcon,
} from '@/components/ui/icon'
import type { View } from './router'
import { roleRank, type UserRole } from '@/lib/roles'

export interface NavItem {
  readonly view: View
  /** The weakest role that may see this destination. */
  readonly minRole: UserRole
  readonly labelKey: string
  /**
   * A shorter label for surfaces where a slot is a fraction of the screen —
   * today the phone's bottom bar, where each destination owns a quarter of a
   * 320–430px viewport at `text-xs`.
   *
   * It exists because a full Arabic destination name cannot fit that slot, and
   * the two available outcomes were both bad: widening the slot squeezes the
   * icons, and truncating the word mid-letter ("الأصناف والخدما…") is a
   * half-finished-looking navigation. So the destination keeps its full name
   * everywhere it has room — the desktop sidebar, the "More" sheet, the
   * accessible name of the bar button itself — and the bar shows a short form
   * that is still an accurate name for the same place.
   *
   * Optional: a destination whose full label already fits simply omits it, and
   * the surface falls back to `labelKey`. Absent is always better than a
   * shortened label nobody needs.
   */
  readonly mobileLabelKey?: string
  readonly icon: LucideIcon
  /**
   * Whether this destination earns one of the four permanent slots in the
   * mobile bottom bar.
   *
   * Only true for the destinations a Station user reaches many times a shift,
   * and which are available to EVERY role. A MANAGER-only destination is never
   * primary: a shared till phone would then show a privileged tab to a cashier
   * who cannot open it. Everything else is reached through "More".
   */
  readonly primary: boolean
}

/*
 * The navigation order, in one place. This array IS the navigation: it is
 * rendered top-to-bottom as declared, and each entry is filtered by `minRole`
 * only - the order below is therefore the order every role sees, minus what it
 * cannot open.
 *
 * 1. نقطة البيع        2. الأصناف والخدمات   3. العملاء والسيارات
 * 4. الموظفون          5. المصروفات         6. المبيعات
 * 7. المخزون           8. التقارير          9. الإعدادات
 */
export const NAV: readonly NavItem[] = [
  { view: 'pos', minRole: 'STAFF', labelKey: 'nav.pos', icon: Store, primary: true },
  // "الأصناف والخدمات" is 16 characters and cannot be shown whole in a quarter
  // of a 360px screen; "الأصناف" is the same destination by the name the whole
  // catalogue screen already uses (`catalog.description`).
  {
    view: 'catalog',
    minRole: 'STAFF',
    labelKey: 'nav.catalog',
    mobileLabelKey: 'nav.catalogShort',
    icon: Package,
    primary: true,
  },
  // The customer workspace is operational: every role may list, search and
  // register customers. Its financial layer is gated by the backend, not here.
  {
    view: 'customers',
    minRole: 'STAFF',
    labelKey: 'nav.customers',
    // "العملاء والسيارات" has the same problem as the catalogue, and the
    // workspace is a customer list with a car field on each record, so
    // "العملاء" names it exactly.
    mobileLabelKey: 'nav.customersShort',
    icon: UserRound,
    primary: true,
  },
  // The employees workspace is operational, not managerial: a cashier needs it
  // to punch their own attendance and to mark the wash staff in. Its manager
  // features (KPI band, salaries, payroll) are gated by the BACKEND, not here.
  // The `Users` icon is the one the old staff screen used, kept so the merged
  // page is the one employees entry rather than a second lookalike.
  { view: 'employees', minRole: 'STAFF', labelKey: 'nav.employees', icon: Users, primary: false },
  { view: 'expenses', minRole: 'MANAGER', labelKey: 'nav.expenses', icon: Receipt, primary: false },
  // The sales workspace is the manager's operational view of the business. It
  // replaced the two sales tabs that used to live inside Reports, so Reports
  // now holds only reporting (audit, printing, closings, charts).
  { view: 'sales', minRole: 'MANAGER', labelKey: 'nav.sales', icon: HandCoins, primary: false },
  { view: 'inventory', minRole: 'MANAGER', labelKey: 'nav.inventory', icon: Boxes, primary: false },
  { view: 'reports', minRole: 'MANAGER', labelKey: 'nav.reports', icon: BarChart3, primary: false },
  // The single settings entry. It keeps the same view, route and ADMIN gate;
  // only the label is the generic "الإعدادات" the navigation order calls for.
  {
    view: 'dev-settings',
    minRole: 'ADMIN',
    labelKey: 'nav.settings',
    icon: Settings,
    primary: false,
  },
]

/**
 * The destinations one role may open, in declared order.
 *
 * Every surface calls this rather than filtering `NAV` itself, so "what can
 * this role see" is decided in exactly one place, through the same
 * `roleRank()` comparison the desktop sidebar has always used. An absent or
 * unrecognised role ranks 0, so an unresolved session sees nothing rather than
 * everything.
 */
export function visibleNav(role: UserRole | undefined): NavItem[] {
  return NAV.filter((n) => roleRank(role) >= roleRank(n.minRole))
}

/**
 * The four-or-fewer destinations that earn a permanent bottom-bar slot.
 *
 * This is `visibleNav` filtered to `primary`, so it inherits the same role
 * gate: a MANAGER-only or ADMIN-only destination is never primary, and can
 * therefore never appear on a shared phone as a tab a cashier cannot open.
 */
export function primaryNav(role: UserRole | undefined): NavItem[] {
  return visibleNav(role).filter((n) => n.primary)
}

/**
 * Which of a route's ancestors a bottom-bar slot should highlight.
 *
 * `/pos/invoices` and `/pos/wash-tickets` are POS sub-pages reached from the
 * POS screen itself, not separate destinations. Treating the parent as active
 * keeps the highlighted tab truthful instead of leaving the bar with nothing
 * selected while the user is three taps deep in a sub-page.
 */
export function isNavViewActive(active: View, target: View): boolean {
  return active === target || (target === 'pos' && active.startsWith('today-'))
}
