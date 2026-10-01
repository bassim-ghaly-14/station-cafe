/**
 * The single structural system behind BOTH POS closing cards.
 *
 * Shift closing and day closing are one closing system with two different
 * meanings, so they share every part of the layout — header, identity slot,
 * metrics, footer/action area, spacing, typography hierarchy and responsive
 * rules — and differ only through a semantic accent family drawn from the
 * centralized Station palette (`styles/colors.css`):
 *
 *   `shift` — teal,  the live cashier/operator period currently in progress;
 *   `day`   — indigo, the whole business day and its financial reconciliation.
 *
 * Nothing here hardcodes a color: every accent class resolves to a
 * `closing-shift-*` / `closing-day-*` token, so both themes follow the app.
 */
import type { ReactNode } from 'react'
import { Card } from '@/components/ui'
import { MoneyDisplay } from '@/components/ui/money'
import { cn } from '@/lib/utils'

export type ClosingAccent = 'shift' | 'day'

/** Accent classes, resolved from the centralized theme tokens. */
const ACCENT: Record<
  ClosingAccent,
  {
    mark: string
    header: string
    primary: string
    highlight: string
    action: string
  }
> = {
  shift: {
    mark: 'text-closing-shift',
    header: 'bg-closing-shift-soft',
    primary: 'bg-closing-shift-soft text-closing-shift-foreground',
    highlight: 'text-closing-shift-foreground',
    action:
      'bg-closing-shift-solid text-closing-shift-solid-foreground hover:bg-closing-shift-solid-hover active:bg-closing-shift-solid-active',
  },
  day: {
    mark: 'text-closing-day',
    header: 'bg-closing-day-soft',
    primary: 'bg-closing-day-soft text-closing-day-foreground',
    highlight: 'text-closing-day-foreground',
    action:
      'bg-closing-day-solid text-closing-day-solid-foreground hover:bg-closing-day-solid-hover active:bg-closing-day-solid-active',
  },
}

export function ClosingMetric({
  label,
  amount,
  strong = false,
  emphasis = false,
}: {
  readonly label: string
  readonly amount: number
  readonly strong?: boolean
  readonly emphasis?: boolean
}) {
  return (
    <div className={cn('flex items-center justify-between gap-4 py-1.5', strong && 'font-bold')}>
      <span className={strong ? 'text-foreground-strong' : 'text-foreground-muted'}>{label}</span>
      <MoneyDisplay amount={amount} className={emphasis ? 'font-bold' : undefined} />
    </div>
  )
}

/**
 * The chrome every operational card of this family shares: the identity rail,
 * the header row (mark, title, status chip, meta line, optional header action)
 * and the footer row. It carries the visual language — accent rail, borders,
 * spacing and typography — so a card that states an OPERATIONAL STATUS is
 * visibly the same object as the shift and day closing cards, without having to
 * carry money to earn that resemblance.
 */
export function ClosingCardShell({
  accent,
  title,
  icon,
  status,
  meta,
  headerAction,
  children,
  footerNote,
  action,
}: {
  readonly accent: ClosingAccent
  readonly title: string
  readonly icon: ReactNode
  readonly status: ReactNode
  readonly meta: ReactNode
  readonly headerAction?: ReactNode
  readonly children: ReactNode
  readonly footerNote: ReactNode
  readonly action: ReactNode
}) {
  const tone = ACCENT[accent]
  return (
    <Card className="flex h-full flex-col overflow-hidden p-0" data-closing={accent}>
      {/* Identity rail: the one place the card kind is announced visually. */}
      <span aria-hidden className={cn('block h-1 w-full shrink-0', tone.header)} />
      <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('shrink-0', tone.mark)}>{icon}</span>
            <h2 className="text-section">{title}</h2>
            {status}
          </div>
          {/* Date, time and the AM/PM marker are separate slots, so a long
              localized date wraps instead of colliding with the time. */}
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption">
            {meta}
          </div>
        </div>
        {headerAction}
      </div>

      <div className="flex-1 p-4">{children}</div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle px-4 py-3">
        <div className="min-w-0 flex-1">{footerNote}</div>
        {/* Action area keeps one shared shape so both cards behave identically. */}
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      </div>
    </Card>
  )
}

export function ClosingCard({
  accent,
  title,
  icon,
  status,
  meta,
  primaryLabel,
  primaryAmount,
  primaryNote,
  metrics,
  highlight,
  footerNote,
  headerAction,
  action,
}: {
  readonly accent: ClosingAccent
  readonly title: string
  /** Identity mark for the closing kind (shift clock / day calendar). */
  readonly icon: ReactNode
  /** Status chip rendered beside the title. */
  readonly status: ReactNode
  /** Secondary identity line under the title (who / when / which period). */
  readonly meta: ReactNode
  readonly primaryLabel: string
  readonly primaryAmount: number
  /** Optional supporting line inside the primary metric block. */
  readonly primaryNote?: ReactNode
  /** Two-column metric grid. */
  readonly metrics: ReactNode
  /** Full-width emphasized metric rendered under the grid. */
  readonly highlight: ReactNode
  /** Footer hint beside the action. */
  readonly footerNote: ReactNode
  /** Optional control in the header row (e.g. refresh). */
  readonly headerAction?: ReactNode
  /** The single primary action of the card. */
  readonly action: ReactNode
}) {
  const tone = ACCENT[accent]
  return (
    <ClosingCardShell
      accent={accent}
      title={title}
      icon={icon}
      status={status}
      meta={meta}
      headerAction={headerAction}
      footerNote={footerNote}
      action={action}
    >
      <div className="grid h-full gap-4 sm:grid-cols-2">
        <section className={cn('flex flex-col justify-center rounded-md px-4 py-3', tone.primary)}>
          <p className="text-sm font-medium">{primaryLabel}</p>
          <MoneyDisplay
            amount={primaryAmount}
            variant="auto"
            className="mt-1 text-2xl font-bold tracking-tight"
          />
          {primaryNote ? <div className="mt-1 text-sm">{primaryNote}</div> : null}
        </section>
        <section className="grid grid-cols-2 gap-x-5 text-sm">
          {metrics}
          <div className={cn('col-span-2 mt-1 border-t border-border-subtle pt-2', tone.highlight)}>
            {highlight}
          </div>
        </section>
      </div>
    </ClosingCardShell>
  )
}
