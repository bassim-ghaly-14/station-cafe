/**
 * DialogActions — the ONE action row for every dialog, form and confirmation.
 *
 * Why this exists
 * ---------------
 * Twenty-odd call sites had already written their own
 * `flex flex-wrap justify-end gap-2` footer, and that class string is a DESKTOP
 * layout: on a 320px screen two Arabic-labelled buttons plus a third one wrap
 * into ragged rows of different widths, and the primary action can end up
 * narrower than the cancel it dismisses. A dialog is a fixed-size surface, so
 * its footer is exactly where a per-screen improvisation shows.
 *
 * What it decides
 * ---------------
 *  - Phone (below `sm`): the buttons STACK, each full width, in `flex-col`, so
 *    every target is the width of the sheet and the row never produces a ragged
 *    two-column wrap. The order is preserved exactly — the caller still decides
 *    which button comes first — so a destructive confirm never silently moves.
 *  - `sm` and up: the original inline row, trailing-aligned, unchanged.
 *
 * It is deliberately dumb: it owns no state, no variants and no business rules.
 * Callers pass their own `Button`s and keep their own order and meanings.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function DialogActions({
  children,
  className,
  /** Visual separation from the body above it. */
  divided = false,
}: {
  readonly children: ReactNode
  readonly className?: string
  /** Draws the hairline the drawers and sheets use above a pinned footer. */
  readonly divided?: boolean
}) {
  return (
    <div
      className={cn(
        // `flex-col` below `sm` is the whole phone behaviour, and it needs no
        // help on the buttons: a column flex container stretches its items to
        // the container's width by default, so every action becomes a full-width
        // target without a single per-button class. The `sm:` row is the desktop
        // layout every screen already had, byte for byte.
        'flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:gap-2',
        divided && 'border-t border-border-subtle pt-4',
        className,
      )}
    >
      {children}
    </div>
  )
}
