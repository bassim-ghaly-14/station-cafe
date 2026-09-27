/**
 * Reactive display-date/time components — the screen counterpart to MoneyDisplay.
 *
 * They subscribe to the central formatting store so Dev Settings changes
 * re-render every visible timestamp immediately.
 *
 * Layout contract: the date, the separator and the time are SEPARATE elements in
 * a flex row with a real gap, each with its own `dir="ltr"` isolate. Formatted
 * output has variable width (`25/09/2026` vs `25 سبتمبر 2026`) and mixed
 * direction (`2:35 م`), so a single text blob inside an RTL card lets the
 * browser's bidi algorithm reorder the parts. Separate isolates stop that, and
 * the flex row wraps instead of overlapping.
 */
import type { CSSProperties } from 'react'
import { formatDate, formatDateTimeParts, formatTime, type DisplayFormatOptions } from '@/lib/date'
import { useFormattingPreferences } from '@/lib/formatting'
import { cn } from '@/lib/utils'

type Props = {
  value: string | Date | number | null | undefined
  className?: string
  options?: DisplayFormatOptions
}

/** Isolate a value from the surrounding paragraph direction. */
const LTR_ISOLATE: CSSProperties = { direction: 'ltr', unicodeBidi: 'isolate' }

/** The neutral placeholder for an absent value (matches the money formatter). */
const EMPTY = '—'

/** One localized value: isolated, allowed to wrap, never given a fixed width. */
function Slot({ children, className }: { children: string; className?: string }) {
  return (
    <span
      dir="ltr"
      style={LTR_ISOLATE}
      className={cn('inline-block min-w-0 wrap-anywhere', className)}
    >
      {children}
    </span>
  )
}

export function DisplayDate({ value, className, options }: Props) {
  useFormattingPreferences()
  return <Slot className={className}>{formatDate(value, options)}</Slot>
}

export function DisplayTime({ value, className, options }: Props) {
  useFormattingPreferences()
  return <Slot className={className}>{formatTime(value, options)}</Slot>
}

export function DisplayDateTime({
  value,
  className,
  options,
  separator = '·',
  stack = false,
}: Props & {
  /** Rendered between the date and the time as its own element, never as whitespace. */
  separator?: string
  /** Put the time on its own line (narrow cards, long localized dates). */
  stack?: boolean
}) {
  useFormattingPreferences()
  const parts = formatDateTimeParts(value, options)

  // A value with no time component (a business date) stays a single date.
  if (!parts?.time) {
    return <Slot className={className}>{parts?.date ?? EMPTY}</Slot>
  }

  return (
    <span
      className={cn(
        'inline-flex min-w-0 max-w-full items-center gap-x-1.5 gap-y-0.5',
        stack ? 'flex-col items-start gap-y-0' : 'flex-wrap',
        className,
      )}
    >
      <Slot>{parts.date}</Slot>
      {separator ? (
        <span aria-hidden className="shrink-0 text-foreground-faint select-none">
          {separator}
        </span>
      ) : null}
      <Slot>{parts.time}</Slot>
    </span>
  )
}

/**
 * A closed-open period (`opened_at → closed_at`) built from the same parts, so a
 * long localized date can never push the arrow or the closing time out of place.
 */
export function DisplayDateTimeRange({
  from,
  to,
  className,
  options,
}: {
  readonly from: string | Date | number | null | undefined
  readonly to: string | Date | number | null | undefined
  readonly className?: string
  readonly options?: DisplayFormatOptions
}) {
  return (
    <span
      className={cn(
        'inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5',
        className,
      )}
    >
      <DisplayDateTime value={from} options={options} />
      <span aria-hidden className="shrink-0 text-foreground-faint select-none">
        →
      </span>
      <DisplayDateTime value={to} options={options} />
    </span>
  )
}
