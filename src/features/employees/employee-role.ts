/**
 * The ONE place the employees surface turns a row's persisted data into the role
 * it is presented under.
 *
 * Both the table and the details drawer import this, so they cannot drift apart,
 * and both build on `employeeRole` from `@/lib/roles` — which is also what the
 * shared `Badge` and `EmployeeAvatar` consume, so the label, the badge colour
 * and the avatar colour are all derived from a single decision.
 *
 * The one rule worth restating: the badge follows the LOGIN ROLE, never the
 * employee type. Every login in Station is a `CASHIER` employee, so rendering
 * the type would print "كاشير" on every row, including the manager's and the
 * admin's.
 */
import { employeeRole, type EmployeeRole } from '@/lib/roles'
import type { TFunction } from 'i18next'
import type { EmployeeRow } from '@/services/employeesApi'

/** Anything with the two fields the role is derived from. */
export interface RoleBearing {
  employee_type: string
  login_role: string | null
}

/** The role this row is presented under. */
export function roleOf(row: RoleBearing): EmployeeRole {
  return employeeRole(row.employee_type, row.login_role)
}

/**
 * The Arabic label for a role, in the project's own terminology:
 * `مدير النظام` / `مدير` / `كاشير` for the auth roles, and `عامل مغسلة` for a
 * wash worker. The WASH_WORKER label is reused from the employee-type catalogue
 * rather than duplicated, so the two can never disagree.
 */
export function roleLabel(t: TFunction, role: EmployeeRole): string {
  return role === 'WASH_WORKER' ? t('employees.type.WASH_WORKER') : t(`roles.${role}`)
}

/**
 * A wash worker has no login, so the "this account signs in" hint does not apply
 * to them; the table falls back to the type hint, which is about the job itself.
 */
export function roleHintKey(role: EmployeeRole): string {
  return role === 'WASH_WORKER' ? 'employees.type.WASH_WORKERHint' : 'employees.type.CASHIERHint'
}

/** Convenience for a list row. */
export function roleOfRow(row: EmployeeRow): EmployeeRole {
  return roleOf(row)
}
