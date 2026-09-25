import { cn } from '@/lib/utils'
import type { SelectHTMLAttributes } from 'react'
import { ChevronDown } from './icon'

/**
 * Select — one styled control for every option list in the app.
 *
 * The native element is kept: it is the only keyboard-native, screen-reader
 * correct option control available without adding a dependency. It is restyled
 * onto the same surface/input tokens as `Input` so filter rows no longer carry
 * a bespoke `className` per screen. The chevron sits on the inline-end edge
 * and is never mirrored, so the control reads correctly in RTL.
 */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative block">
      <select
        className={cn(
          'h-10 w-full appearance-none rounded-md border border-border-strong bg-surface-input ps-3 pe-9 text-base text-foreground',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
          'disabled:border-border disabled:bg-surface-muted disabled:text-foreground-disabled',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        size={16}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 inset-e-3 my-auto text-foreground-subtle"
      />
    </span>
  )
}
