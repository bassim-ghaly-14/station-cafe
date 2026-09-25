export const USER_ROLES = ['ADMIN', 'MANAGER', 'STAFF'] as const

export type UserRole = (typeof USER_ROLES)[number]

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && USER_ROLES.includes(value as UserRole)
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
} satisfies Record<UserRole, RoleVisual>

const fallbackRoleVisual: RoleVisual = {
  avatarForeground: 'text-role-fallback-fg',
  background: 'bg-role-fallback-bg',
  badgeBackground: 'bg-role-fallback-badge-bg',
  badgeBorder: 'border-role-fallback-badge-border',
  badgeForeground: 'text-role-fallback-badge-fg',
  foreground: 'text-role-fallback-fg',
}

export function getRoleVisual(role: unknown): RoleVisual {
  return isUserRole(role) ? roleVisuals[role] : fallbackRoleVisual
}
