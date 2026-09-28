import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { getRoleVisual } from '@/lib/roles'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex max-w-full items-center border font-semibold leading-none whitespace-nowrap transition-colors motion-reduce:transition-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        neutral: 'border-badge-neutral-border bg-badge-neutral-bg text-badge-neutral-fg',
        success: 'border-badge-success-border bg-badge-success-bg text-badge-success-fg',
        warning: 'border-badge-warning-border bg-badge-warning-bg text-badge-warning-fg',
        danger: 'border-badge-danger-border bg-badge-danger-bg text-badge-danger-fg',
        info: 'border-badge-info-border bg-badge-info-bg text-badge-info-fg',
        brand: 'border-badge-brand-border bg-badge-brand-bg text-badge-brand-fg',
        new: 'border-badge-new-border bg-badge-new-bg text-badge-new-fg',
      },
      size: {
        sm: 'gap-1 rounded-md px-2 py-1 text-xs [&_svg]:size-3',
        md: 'gap-1.5 rounded-md px-2.5 py-1.5 text-sm [&_svg]:size-4',
      },
      shape: {
        soft: 'rounded-md',
        pill: 'rounded-full',
      },
    },
    defaultVariants: { variant: 'neutral', size: 'md', shape: 'soft' },
  },
)

export interface BadgeProps
  extends
    Omit<HTMLAttributes<HTMLSpanElement>, 'color' | 'role'>,
    VariantProps<typeof badgeVariants> {
  /** Adds a non-color status cue. Badge text remains the primary semantic signal. */
  dot?: boolean
  icon?: LucideIcon
  iconPosition?: 'start' | 'end'
  /** Optional semantic employee role. Role styling takes precedence over variant. */
  role?: string | null
  children: ReactNode
}

/** Canonical application badge for statuses, identities, and compact metadata. */
export function Badge({
  variant,
  size,
  shape = 'soft',
  dot = false,
  icon: Icon,
  iconPosition = 'start',
  role,
  className,
  children,
  ...props
}: Readonly<BadgeProps>) {
  const icon = Icon ? <Icon aria-hidden="true" /> : null
  const roleVisual = role !== undefined ? getRoleVisual(role) : null
  return (
    <span
      className={cn(
        badgeVariants({ variant, size, shape }),
        roleVisual && [
          roleVisual.badgeBackground,
          roleVisual.badgeForeground,
          roleVisual.badgeBorder,
        ],
        className,
      )}
      {...props}
    >
      {dot ? (
        <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      ) : null}
      {iconPosition === 'start' ? icon : null}
      <span className="min-w-0 truncate">{children}</span>
      {iconPosition === 'end' ? icon : null}
    </span>
  )
}
