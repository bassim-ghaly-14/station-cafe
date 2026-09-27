export const USER_ROLES = ['ADMIN', 'MANAGER', 'STAFF'] as const

export type UserRole = (typeof USER_ROLES)[number]

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && USER_ROLES.includes(value as UserRole)
}

/**
 * The operational employee type, mirroring `EMPLOYEE_TYPES` in
 * `repositories/employees.rs`. `CASHIER` is the type of an employee WHO HAS a
 * login; the login's own `users.role` is what makes that person an admin, a
 * manager or a plain staff member. `WASH_WORKER` is a person with NO login at
 * all, so it is a role in its own right rather than a subtype of anything.
 */
export const EMPLOYEE_TYPES = ['CASHIER', 'WASH_WORKER'] as const

export type EmployeeType = (typeof EMPLOYEE_TYPES)[number]

export function isEmployeeType(value: unknown): value is EmployeeType {
  return typeof value === 'string' && EMPLOYEE_TYPES.includes(value as EmployeeType)
}

/**
 * The role a row of the employees table is PRESENTED under.
 *
 * This is the single source of truth for that decision, and it is derived, never
 * stored: an employee with a login is presented as that login's real
 * `users.role` (ADMIN / MANAGER / STAFF), and an employee without one is
 * presented as the only role such a person can hold, WASH_WORKER.
 *
 * Presenting a manager as "كاشير" because their employee TYPE happens to be
 * CASHIER is exactly the mistake this function exists to prevent: the type
 * describes the job, the role describes the authority, and the table must show
 * the authority.
 */
export type EmployeeRole = UserRole | 'WASH_WORKER'

/** Does this presentation role carry a login? */
export function hasLogin(role: EmployeeRole): role is UserRole {
  return isUserRole(role)
}

/**
 * The role an employee row is presented under.
 *
 * `loginRole` is the employee row's linked `users.role` — `null` for a wash
 * worker, which the database CHECK guarantees rather than the UI assuming.
 */
export function employeeRole(
  employeeType: string | null | undefined,
  loginRole: string | null | undefined,
): EmployeeRole {
  if (isUserRole(loginRole)) return loginRole
  // No usable login role: a wash worker is presented as WASH_WORKER, and a
  // cashier whose login is missing falls back to the STAFF colour family rather
  // than silently inheriting the generic fallback treatment.
  if (employeeType === 'WASH_WORKER') return 'WASH_WORKER'
  return 'STAFF'
}

export type RoleVisual = {
  /** Shared role-family avatar/icon foreground. */
  avatarForeground: string
  /** Shared role-family surface used by avatars. */
  background: string
  /** Role-specific Badge surface and accessible text colors. */
  badgeBackground: string
  badgeBorder: string
  badgeForeground: string
  /** The shared role-family foreground, retained as an explicit avatar token. */
  foreground: string
}

const roleVisuals = {
  ADMIN: {
    avatarForeground: 'text-role-admin-fg',
    background: 'bg-role-admin-bg',
    badgeBackground: 'bg-role-admin-badge-bg',
    badgeBorder: 'border-role-admin-badge-border',
    badgeForeground: 'text-role-admin-badge-fg',
    foreground: 'text-role-admin-fg',
  },
  MANAGER: {
    avatarForeground: 'text-role-manager-fg',
    background: 'bg-role-manager-bg',
    badgeBackground: 'bg-role-manager-badge-bg',
    badgeBorder: 'border-role-manager-badge-border',
    badgeForeground: 'text-role-manager-badge-fg',
    foreground: 'text-role-manager-fg',
  },
  STAFF: {
    avatarForeground: 'text-role-staff-fg',
    background: 'bg-role-staff-bg',
    badgeBackground: 'bg-role-staff-badge-bg',
    badgeBorder: 'border-role-staff-badge-border',
    badgeForeground: 'text-role-staff-badge-fg',
    foreground: 'text-role-staff-fg',
  },
  WASH_WORKER: {
    avatarForeground: 'text-role-wash-fg',
    background: 'bg-role-wash-bg',
    badgeBackground: 'bg-role-wash-badge-bg',
    badgeBorder: 'border-role-wash-badge-border',
    badgeForeground: 'text-role-wash-badge-fg',
    foreground: 'text-role-wash-fg',
  },
} satisfies Record<UserRole | 'WASH_WORKER', RoleVisual>

const fallbackRoleVisual: RoleVisual = {
  avatarForeground: 'text-role-fallback-fg',
  background: 'bg-role-fallback-bg',
  badgeBackground: 'bg-role-fallback-badge-bg',
  badgeBorder: 'border-role-fallback-badge-border',
  badgeForeground: 'text-role-fallback-badge-fg',
  foreground: 'text-role-fallback-fg',
}

export function getRoleVisual(role: unknown): RoleVisual {
  if (isUserRole(role) || role === 'WASH_WORKER') {
    return roleVisuals[role]
  }
  return fallbackRoleVisual
}
