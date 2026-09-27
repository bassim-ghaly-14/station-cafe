/**
 * ProportionCard — the shared "how does this total split up" list.
 *
 * It was extracted from the Sales breakdown, which needed it twice, and is now
 * also the Expenses category ranking: both pages ask the same question of their
 * own numbers, so both ask it the same way.
 *
 * The bar is never the only signal. Every row prints its own figure AND its own
 * share as text, and the bar itself carries an accessible label — so the
 * breakdown stays readable in dark mode, in print, and for a screen reader,
 * without relying on the hue.
 */
import type { ReactNode } from 'react'
import { Card, MoneyDisplay } from '@/components/ui'
import type { LucideIcon } from '@/components/ui/icon'

export type ProportionSlice = {
  key: string
  label: string
  /** Minor units (piasters) — the only money unit Station ever stores. */
  amount: number
  /** Whole percent, rounded server-side, for the same total the tile shows. */
  share: number
  icon?: LucideIcon
  /**
   * The bar's CSS color — a CENTRALIZED chart bar role (`chartBarColor(...)`,
   * i.e. `var(--chart-bar-*)`), never a raw palette and never a `bg-*` class.
   * A proportion bar is a data mark like any other, so it is themed and
   * Dev-Settings controlled through exactly the same system as the recharts
   * charts.
   */
  color: string
  /** Replaces the money figure, for a non-monetary breakdown. */
  value?: ReactNode
  /** Extra context under the label, e.g. "3 قيود". */
  hint?: string
}

function SliceRow({ slice }: { slice: ProportionSlice }) {
  const Icon = slice.icon
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 font-medium">
          {Icon ? (
            <span className="flex size-6 shrink-0 items-center justify-center rounded bg-accent text-primary">
              <Icon size={13} aria-hidden />
            </span>
          ) : null}
          <span className="truncate">{slice.label}</span>
        </span>
        <span className="flex shrink-0 items-center gap-3 tabular-nums">
          {slice.value ?? (
            <MoneyDisplay amount={slice.amount} variant="auto" className="text-foreground" />
          )}
          <strong className="min-w-10 text-end text-foreground-strong">{slice.share}%</strong>
        </span>
      </div>
      {slice.hint ? <p className="text-caption text-foreground-subtle">{slice.hint}</p> : null}
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
        role="img"
        aria-label={`${slice.label}: ${slice.share}%`}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.min(100, Math.max(0, slice.share))}%`,
            background: slice.color,
          }}
        />
      </div>
    </li>
  )
}

export function ProportionCard({
  title,
  hint,
  slices,
  footnote,
  className,
}: {
  title: string
  hint: string
  slices: ProportionSlice[]
  /** A single honest note under the list, e.g. "these two do not add up". */
  footnote?: ReactNode
  className?: string
}) {
  return (
    <Card className={className}>
      <h2 className="text-section text-foreground-strong">{title}</h2>
      <p className="mt-0.5 mb-3 text-caption text-foreground-subtle">{hint}</p>
      <ul className="flex flex-col gap-3">
        {slices.map((slice) => (
          <SliceRow key={slice.key} slice={slice} />
        ))}
      </ul>
      {footnote ? (
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-caption text-foreground-subtle">
          {footnote}
        </p>
      ) : null}
    </Card>
  )
}
