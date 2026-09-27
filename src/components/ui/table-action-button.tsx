import { cn } from '@/lib/utils'
import { Button, type ButtonProps } from './button'

/**
 * The shared action column for an operational record table.
 *
 * This is the row-action treatment the Employees table already established, and
 * it is extracted — not redesigned — so the Customers table can use exactly the
 * same one instead of re-implementing a smaller, differently coloured version:
 *
 *  - `TableActionGroup` is the row's own group: a single line, right aligned
 *    against the trailing edge, `gap-1`, plus the scoped `[&_svg]:size-6`
 *    override. The override is required, not decorative: a Button variant sets
 *    `[&_svg]:size-*`, which is a rule on the CHILD and therefore wins over a
 *    `size` prop passed to the icon, so without it every glyph renders at the
 *    variant size whatever the icon asks for.
 *  - `TableActionButton` is the 48px (`icon-lg`) hit target. The hit area goes
 *    UP from 40px, so the larger 24px glyph costs no usability.
 *  - `TableActionDivider` is a hairline, not a second row, used to separate
 *    families of actions (attendance vs management vs the irreversible one).
 *
 * Colour
 * ------
 * Every action carries a MEANINGFUL colour drawn from the existing Station
 * semantic tokens (`info` / `success` / `warning` / `destructive`) — the same
 * tokens the badges and alerts already use, in both themes, so nothing new is
 * introduced and a rebrand stays a CSS edit. Each tone pairs the bright
 * "indicator" foreground with its own `*-soft` background on hover, and steps to
 * the `*-soft-hover` shade while pressed, exactly like the `destructiveGhost`
 * Button variant already does.
 *
 * Hover is a short colour transition: no scale, no zoom, no oversized pill —
 * the control keeps the compact square shape the table already uses.
 */
export type TableActionTone = 'info' | 'success' | 'warning' | 'danger'

const TONE_CLASS: Record<TableActionTone, string> = {
  info: 'text-info hover:bg-info-soft hover:text-info-foreground active:bg-info-soft-hover',
  success:
    'text-success hover:bg-success-soft hover:text-success-foreground active:bg-success-soft-hover',
  warning:
    'text-warning hover:bg-warning-soft hover:text-warning-foreground active:bg-warning-soft-hover',
  danger:
    'text-destructive hover:bg-destructive-soft hover:text-destructive-soft-foreground active:bg-destructive-soft-hover',
}

/** The action group container for one row. */
export function TableActionGroup({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('flex items-center justify-end gap-1 [&_svg]:size-6', className)}>
      {children}
    </div>
  )
}

/** A hairline separator between two families of actions. Decorative only. */
export function TableActionDivider() {
  return <span aria-hidden className="mx-0.5 h-6 w-px bg-border-subtle" />
}

export type TableActionButtonProps = Omit<ButtonProps, 'variant' | 'size'> & {
  tone?: TableActionTone
}

/** One action in the column. `aria-label` and `title` are the caller's job. */
export function TableActionButton({
  tone = 'info',
  className,
  children,
  ...props
}: TableActionButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      className={cn(
        // `transition-colors` comes from the Button base; this only shortens it
        // and cancels the base press-scale, which must never read as a zoom.
        'duration-150 active:scale-100',
        TONE_CLASS[tone],
        className,
      )}
      {...props}
    >
      {children}
    </Button>
  )
}
