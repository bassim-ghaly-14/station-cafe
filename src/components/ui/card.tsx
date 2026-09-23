import { cn } from '@/lib/utils'
import type { HTMLAttributes, ReactNode } from 'react'
import { Button } from './button'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-surface p-4 shadow-sm',
        className,
      )}
      {...props}
    />
  )
}

export function CardHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-2">
      <div>
        <h2 className="text-base font-bold text-foreground-strong">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-foreground-subtle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}

const badgeStyles = {
  default: 'bg-accent text-foreground-muted',
  success: 'bg-success-soft text-success-foreground',
  warning: 'bg-warning-soft text-warning-foreground',
  danger: 'bg-destructive-soft text-destructive-soft-foreground',
  info: 'bg-info-soft text-info-foreground',
  neutral: 'bg-surface-muted text-foreground-subtle border border-border',
} as const

export type BadgeTone = keyof typeof badgeStyles

export function Badge({
  tone = 'default',
  className,
  children,
}: {
  tone?: BadgeTone
  className?: string
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        badgeStyles[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export { Button }
