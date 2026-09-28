import { cn } from '@/lib/utils'

/**
 * DataTable — the shared shell for operational record tables.
 *
 * It owns exactly the concerns every table in the app repeats, and nothing
 * else, so a screen never re-implements them:
 *
 *  - real `<table>` semantics with an accessible caption and column scopes;
 *  - a single hairline under the header and hairline row separators — never a
 *    box around every cell;
 *  - a hover/focus surface on the row so an interactive row is discoverable;
 *  - controlled horizontal scrolling on narrow widths with a sticky header, so
 *    density is preserved instead of being collapsed into a card list.
 *
 * Column priority is expressed by the caller with `hideBelow` on a cell, which
 * removes low-priority columns on narrow viewports while keeping every value
 * reachable through the row's own details interaction.
 */
export interface DataTableColumn {
  /** Stable key used for the sticky-width bookkeeping and test hooks. */
  key: string
  /** Visible header text. */
  label: string
  /** Screen width below which the column is dropped. */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl'
  /** Extra classes for the header cell (alignment, width). */
  headerClassName?: string
  /** Extra classes for every body cell in this column. */
  cellClassName?: string
}

const HIDE_BELOW: Record<NonNullable<DataTableColumn['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
}

export function DataTable({
  caption,
  columns,
  children,
  className,
  busy = false,
}: {
  readonly caption: string
  readonly columns: DataTableColumn[]
  readonly children: React.ReactNode
  readonly className?: string
  /** Marks the body as updating without hiding the rows already on screen. */
  readonly busy?: boolean
}) {
  return (
    /*
     * The scroll container.
     *
     * `overscroll-x-contain` is the mobile fix for a real defect: without it,
     * a horizontal swipe that reaches the end of the table hands the gesture to
     * the page and scrolls it sideways on iOS, which is the "the whole screen
     * slid" feeling. Containing it keeps the gesture inside the table.
     *
     * Negative inline margins + matching padding let the table bleed to the
     * screen edge on a phone while its FIRST cell still lines up with the rest
     * of the page. Without this, edge-to-edge content would either clip the
     * first column or sit inset from the edge with a visible gap beside it.
     * The `sm:` reset puts desktop back to exactly the padding it had.
     */
    <div
      className={cn('-mx-3 overflow-x-auto overscroll-x-contain px-3 sm:mx-0 sm:px-0', className)}
    >
      {/*
       * `min-w-2xl` is a FLOOR, not a target, and only from `sm` up.
       *
       * On desktop the floor is what preserves density: a 9-column operational
       * table is more useful as a table than as a stack of cards, and columns
       * the caller marked `hideBelow` are already gone by this width.
       *
       * On a phone the floor is REMOVED (`w-full min-w-0`). Forcing a 42rem
       * minimum there meant every table opened already scrolled sideways, with
       * the identity column — the one column a user needs to know which record
       * they are looking at — pushed off-screen to the right. Letting the
       * remaining columns use the real width is what makes the `hideBelow`
       * priority system actually work: the columns that survive are the ones
       * that fit.
       */}
      <table className="w-full min-w-0 border-collapse sm:min-w-2xl">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  'px-3 py-2.5 text-start text-caption font-bold whitespace-nowrap',
                  column.hideBelow && HIDE_BELOW[column.hideBelow],
                  column.headerClassName,
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody aria-busy={busy || undefined} className="transition-opacity">
          {children}
        </tbody>
      </table>
    </div>
  )
}

/** One interactive record row. Hover and `focus-within` share the same surface. */
export function DataTableRow({
  onClick,
  className,
  children,
}: {
  readonly onClick?: () => void
  readonly className?: string
  readonly children: React.ReactNode
}) {
  return (
    <tr
      onClick={onClick}
      className={cn(
        'border-b border-border-subtle transition-colors last:border-0 hover:bg-surface-hover focus-within:bg-surface-hover',
        onClick && 'cursor-pointer',
        className,
      )}
    >
      {children}
    </tr>
  )
}

/** A body cell with the shared vertical rhythm and padding. */
export function DataTableCell({
  className,
  children,
}: {
  readonly className?: string
  readonly children: React.ReactNode
}) {
  return <td className={cn('px-3 py-2.5 align-middle', className)}>{children}</td>
}
