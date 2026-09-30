/** The project-wide KPI / stat-summary layout rule.
 *
 * Station's numbers are read in two very different places: a wide desk screen
 * where a band of tiles is one glance, and a phone in one hand where the same
 * band is a wall of half-width tiles whose Arabic labels truncate to nothing
 * and whose figures stop being comparable at a glance. Those are different
 * problems, so the rule is stated once, here, instead of once per band:
 *
 *   phone  (< `sm`)  — ONE tile per row, full width, nothing truncated;
 *   `sm` and up      — the existing multi-column progression, unchanged.
 *
 * Every KPI group in the app (tables, POS, sales, expenses, customers,
 * employees) renders through {@link KpiGrid}, so the rule is a property of the
 * component rather than a class string a screen may forget. The steps use the
 * shared Tailwind scale only — no ad-hoc pixel breakpoints — and the phone step
 * is deliberately `grid-cols-1`: a two-column KPI grid at 360px is what forced
 * labels into ellipsis and made the figures unreadable.
 *
 * A band states only its WIDE steps (`lg` / `xl`), never the phone step: the
 * one thing every band must agree on is decided here once.
 */
import { cn } from '@/lib/utils'
import type { HTMLAttributes, ReactNode } from 'react'

/** Column counts per wide step, written out so Tailwind can see them. */
const COLUMNS = {
  lg: { 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4' },
  xl: { 3: 'xl:grid-cols-3', 4: 'xl:grid-cols-4', 5: 'xl:grid-cols-5' },
} as const

export interface KpiGridProps extends HTMLAttributes<HTMLElement> {
  /** Tiles per row from `lg` (1024px). Defaults to three. */
  readonly lg?: keyof (typeof COLUMNS)['lg']
  /** Tiles per row from `xl` (1280px). Defaults to four. */
  readonly xl?: keyof (typeof COLUMNS)['xl']
  /** The grid is a `div` everywhere except a band's own loading state, which is
   * an `<output>` so the busy block is announced as a status. */
  readonly as?: 'div' | 'output'
  readonly children: ReactNode
}

export function KpiGrid({
  lg = 3,
  xl = 4,
  as: Tag = 'div',
  className,
  ...props
}: Readonly<KpiGridProps>) {
  return (
    <Tag
      className={cn(
        'grid grid-cols-1 gap-3 sm:grid-cols-2',
        COLUMNS.lg[lg],
        COLUMNS.xl[xl],
        className,
      )}
      {...props}
    />
  )
}

/**
 * One compact KPI tile: an icon and its label on the first line, the figure
 * below, and an optional second line of context.
 *
 * The label is never truncated: on a phone the tile owns the full row, so
 * there is nothing to truncate against, and an ellipsis in a KPI label is a
 * number the reader cannot trust they are looking at.
 */
export function KpiTile({
  icon,
  label,
  hint,
  children,
}: {
  readonly icon: ReactNode
  readonly label: string
  readonly hint?: string
  readonly children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border-subtle bg-surface-card p-3">
      <div className="flex items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded bg-accent text-primary">
          {icon}
        </span>
        {/* `min-w-0` lets the label WRAP inside a narrow column instead of
            pushing the tile wider than its cell, which is what would have
            overflowed a two-column phone grid. */}
        <p className="min-w-0 text-caption">{label}</p>
      </div>
      <p className="text-lg leading-tight font-bold text-foreground-strong tabular-nums">
        {children}
      </p>
      {hint ? <p className="text-caption text-foreground-subtle">{hint}</p> : null}
    </div>
  )
}
