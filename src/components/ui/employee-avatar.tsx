import { getRoleVisual, isUserRole } from '@/lib/roles'
import { cn } from '@/lib/utils'
import { User } from './icon'

const sizeStyles = {
  sm: 'size-6 rounded-md',
  md: 'size-8 rounded-lg',
  lg: 'size-10 rounded-lg',
} as const

const iconSizes = { sm: 14, md: 16, lg: 20 } as const

export type EmployeeAvatarSize = keyof typeof sizeStyles

export interface EmployeeAvatarProps {
  role?: string | null
  size?: EmployeeAvatarSize
  className?: string
  /** Supply only when the avatar is the sole identity representation. */
  accessibilityLabel?: string
}

/** Lightweight role identity marker used wherever an employee is represented. */
export function EmployeeAvatar({
  role,
  size = 'md',
  className,
  accessibilityLabel,
}: EmployeeAvatarProps) {
  const roleVisual = getRoleVisual(role)
  const identityRole = isUserRole(role) ? role : 'FALLBACK'

  return (
    <span
      data-testid="employee-avatar"
      data-employee-role={identityRole}
      role={accessibilityLabel ? 'img' : undefined}
      aria-label={accessibilityLabel}
      aria-hidden={accessibilityLabel ? undefined : true}
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        sizeStyles[size],
        roleVisual.background,
        roleVisual.avatarForeground,
        className,
      )}
    >
      <User size={iconSizes[size]} aria-hidden strokeWidth={2} />
    </span>
  )
}
