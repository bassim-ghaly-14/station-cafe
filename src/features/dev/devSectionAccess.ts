/**
 * WHICH Dev Settings sections each role may open.
 *
 * This is an ALLOWLIST, never a denylist: a section a MANAGER may see is named
 * here, and every section not named is ADMIN-only by default. The difference
 * matters the moment someone adds a new card — a denylist would expose it to
 * managers by omission, which is exactly the failure this file exists to make
 * impossible.
 *
 *   ADMIN   — every section, existing and future.
 *   MANAGER — the seven operational sections below, and nothing else.
 *   STAFF   — no Dev Settings at all: `canSeeDevSection` is false for every
 *             section, and the page never renders for this role.
 *
 * WHY these seven and no others. They are the cafe's operational levers — the
 * money taken at the till (service charge, discount), the credential that
 * unlocks a discount, who may buy on credit, how the till is reachable from a
 * phone, the month's yardstick, and keeping the application current. Everything
 * else on the page is either presentation (colours, formats, worked-duration) or
 * system/developer surface (table count, chart window, data tools), and none of
 * it belongs to a manager.
 *
 * This map is a UI convenience ONLY. It decides what is RENDERED, never what is
 * ALLOWED: every command behind these sections authorizes on the role again in
 * Rust (`auth::require_role`), so hiding a section here and invoking its command
 * directly are different acts. UI hiding is never the security boundary — that is
 * why every section below has a MANAGER+ (or ADMIN) gate in Rust too.
 */
import { roleRank, type UserRole } from '@/lib/roles'

/** Every section the Dev Settings page is built from, in page order. */
export const DEV_SECTIONS = [
  'service-charge',
  'discount',
  'authorization-code',
  'credit-payment',
  'local-network-access',
  'monthly-targets',
  'application-update',
  'chart-colors',
  'display-formatting',
  'tables',
  'monthly-sales-period',
  'work-duration',
  'developer-tools',
] as const

export type DevSection = (typeof DEV_SECTIONS)[number]

/**
 * The sections a MANAGER may configure. Everything outside this list is
 * ADMIN-only, which is the whole point of naming them here.
 */
export const MANAGER_DEV_SECTIONS: readonly DevSection[] = [
  'service-charge',
  'discount',
  'authorization-code',
  'credit-payment',
  'local-network-access',
  'monthly-targets',
  'application-update',
]

/** Whether this role may open this Dev Settings section at all. */
export function canSeeDevSection(role: UserRole | undefined, section: DevSection): boolean {
  if (roleRank(role) >= roleRank('ADMIN')) return true
  return roleRank(role) >= roleRank('MANAGER') && MANAGER_DEV_SECTIONS.includes(section)
}

/**
 * Whether this role may open the Dev Settings page at all.
 *
 * STAFF gets `false`, so the page renders nothing and — more importantly — the
 * navigation entry is not offered either (`NAV` in `@/app/navigation`).
 */
export function canOpenDevSettings(role: UserRole | undefined): boolean {
  return roleRank(role) >= roleRank('MANAGER')
}

/**
 * Whether the Dev Settings page must read the ADMIN-only configuration
 * (table count, monthly chart window) on mount.
 *
 * A MANAGER's page never shows those controls, so it never asks for them: the
 * load describes exactly what the page renders, and a value that cannot be
 * displayed or changed is pointless traffic.
 */
export function loadsAdminSettings(role: UserRole | undefined): boolean {
  return roleRank(role) >= roleRank('ADMIN')
}
