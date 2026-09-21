import { cn } from '@/lib/utils'
import type { HTMLAttributes, ReactNode } from 'react'
import { Button } from './button'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-lg border border-brand-200 bg-surface-raised p-4 shadow-sm',
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
        <h2 className="text-base font-bold text-brand-900">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-brand-600">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}

const badgeStyles = {
  default: 'bg-brand-100 text-brand-800',
  success: 'bg-green-100 text-green-800',
  warning: 'bg-amber-100 text-amber-800',
  danger: 'bg-red-100 text-red-800',
  info: 'bg-sky-100 text-sky-800',
  neutral: 'bg-brand-50 text-brand-600 border border-brand-200',
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
