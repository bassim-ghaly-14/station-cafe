import { cn } from '@/lib/utils'
import type { HTMLAttributes, ReactNode } from 'react'

/**
 * Surface variant. The `loading` state renders an `<output>`, whose implicit
 * `status` role announces the busy block without a redundant ARIA override.
 * The attribute type is widened to the common denominator of both elements so
 * the variant stays interchangeable at every call site.
 */
export function Card({
  className,
  as: Tag = 'div',
  ...props
}: HTMLAttributes<HTMLElement> & { as?: 'div' | 'output' }) {
  return (
    <Tag
      className={cn('rounded-lg border border-border bg-surface-card p-4 shadow-sm', className)}
      {...props}
    />
  )
}

export function CardHeader({
  title,
  subtitle,
  actions,
}: {
  readonly title: ReactNode
  readonly subtitle?: ReactNode
  readonly actions?: ReactNode
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

export { Button } from './button'
