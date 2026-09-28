import { useId, type InputHTMLAttributes, type ReactNode } from 'react'
import { Search, X } from './icon'
import { cn } from '@/lib/utils'

/**
 * ToolbarSearch — the ONE live search field every list toolbar uses.
 *
 * # Why it is shared
 *
 * Four toolbars (employees, customers, invoices, wash tickets, plus the
 * operations log) had each written the same icon-plus-input-plus-clear markup,
 * and each had solved the narrow-width problem differently — which is exactly
 * how five toolbars end up with five behaviours. This states the decision once.
 *
 * # The narrow-width decision
 *
 * Desktop keeps what it had: the field takes the free space beside the toolbar's
 * other controls (`sm:min-w-56 sm:flex-1`).
 *
 * On a phone the field becomes `w-full` and the toolbar's other controls drop to
 * the line below it. Two reasons, and both are about the 296px a 320px screen
 * actually has:
 *
 *  1. A search field that shares a line with a "create" button and a date
 *     control is what produces the ragged two-line toolbar — the search gets
 *     squeezed to 140px while the button beside it keeps its full Arabic label.
 *     Giving the search its own line makes it the full 296px, which is what a
 *     field you type a person's name into actually needs.
 *  2. The live-search behaviour makes the field the primary control of the
 *     toolbar, so it should be the first thing on its own line, not the item
 *     that gets whatever width is left over.
 *
 * The clear button keeps its own 32px target and stays `sr-only`-labelled, and
 * the native WebKit clear affordance is suppressed exactly as before so the two
 * never compete.
 */
export function ToolbarSearch({
  value,
  onValueChange,
  /** Visible placeholder. */
  placeholder,
  /** Accessible name; also what the `sr-only` label states. */
  label,
  /** Optional long-form description of the live behaviour, for screen readers. */
  hint,
  /** Accessible name of the clear control. */
  clearLabel,
  className,
  ...rest
}: {
  readonly value: string
  readonly onValueChange: (value: string) => void
  readonly placeholder: string
  readonly label: string
  readonly hint?: string
  /** Accessible name of the clear control; falls back to the placeholder. */
  readonly clearLabel?: string
  readonly className?: string
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'placeholder'>) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined

  return (
    <div className={cn('relative w-full sm:min-w-56 sm:flex-1', className)}>
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <Search
        size={16}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 inset-s-3 my-auto text-foreground-subtle"
      />
      <input
        {...rest}
        id={id}
        type="search"
        role="searchbox"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        aria-describedby={hintId}
        className="h-10 w-full rounded-md border border-border-strong bg-surface-input ps-9 pe-9 text-base text-foreground placeholder:text-placeholder-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus [&::-webkit-search-cancel-button]:hidden"
      />
      {value !== '' ? (
        <button
          type="button"
          onClick={() => onValueChange('')}
          aria-label={clearLabel ?? placeholder}
          title={clearLabel ?? placeholder}
          className="absolute inset-y-0 inset-e-1 my-auto flex size-8 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <X size={15} aria-hidden />
        </button>
      ) : null}
      {hint ? (
        <p id={hintId} className="sr-only">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/**
 * FilterBar — the toolbar shell every list screen puts its controls in.
 *
 * It owns one decision: on a phone the search takes its own full-width line and
 * the remaining controls share the line beneath it, edge to edge, so they wrap
 * as a set rather than as a ragged remainder. From `sm` up it is the single
 * row the toolbars already were.
 */
export function FilterBar({
  search,
  children,
  className,
}: {
  /** The search field. Rendered full-width on its own line below `sm`. */
  readonly search: ReactNode
  /** The remaining controls: filters, date ranges, and the primary action. */
  readonly children: ReactNode
  readonly className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center', className)}>
      {search}
      {/* `w-full` below `sm` so the controls below the search are a set that
          fills the width, instead of inheriting the ragged leftover of a
          wrapped row. `sm:w-auto` restores the desktop behaviour. */}
      <div className="flex w-full flex-col gap-2 min-[400px]:flex-row min-[400px]:flex-wrap min-[400px]:items-center sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
        {children}
      </div>
    </div>
  )
}
