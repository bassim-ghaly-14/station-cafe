/**
 * DateRangePicker — one cohesive field for a `from` / `to` business-date filter.
 *
 * The collapsed control stays quiet until the user consciously applies (or
 * clears) a selection, so filtering never fires an API call on every calendar
 * click. Values cross the component boundary as plain `YYYY-MM-DD` strings —
 * no Date objects, no timezone drift. Direction follows the app (`isRtl`),
 * while each date value keeps its own locale-correct ordering.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { isRtl } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  addMonths,
  formatIsoDate,
  formatIsoDateLong,
  formatMonthTitle,
  monthCells,
  parseIsoDate,
  todayIso,
  weekdayLabels,
  weekStartIndex,
  type MonthCell,
} from '@/lib/date'
import { Button } from './button'
import { ArrowLeft, ArrowRight, CalendarDays, ChevronLeft, ChevronRight, X } from './icon'

export interface DateRange {
  /** Inclusive start, `YYYY-MM-DD`, empty when unset. */
  from: string
  /** Inclusive end, `YYYY-MM-DD`, empty when unset. */
  to: string
}

const NAV_BUTTON =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground active:bg-surface-active'

/**
 * The name a day carries when it is one end of the draft range, or null when it
 * is an ordinary day. Both ends are announced, so the label is what tells a
 * screen reader which end it is on.
 */
function edgeLabelFor(iso: string, draft: DateRange, t: TFunction): string | null {
  if (iso === draft.from) return t('dateRange.start')
  if (iso === draft.to) return t('dateRange.end')
  return null
}

/** Visible month for an ISO date (falls back to the Station business month). */
function viewMonthOf(iso: string): { year: number; month: number } {
  const parts = parseIsoDate(iso)
  if (parts) return { year: parts.year, month: parts.month }
  // The fallback is the Station business month, not the browser's local month.
  const today = parseIsoDate(todayIso())
  return today ? { year: today.year, month: today.month } : { year: 1970, month: 1 }
}

export function DateRangePicker({
  from,
  to,
  onChange,
  label,
  className,
  disabled = false,
}: {
  readonly from: string
  readonly to: string
  /** Applied only when the user presses Apply or clears the range. */
  readonly onChange: (range: DateRange) => void
  /** Accessible name of the control; defaults to the shared "date range" label. */
  readonly label?: string
  readonly className?: string
  readonly disabled?: boolean
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const rtl = isRtl(locale)
  const today = todayIso()
  const labelText = label ?? t('dateRange.label')
  const weekStart = weekStartIndex(locale)

  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DateRange>({ from, to })
  const [hover, setHover] = useState<string | null>(null)
  const [view, setView] = useState(() => viewMonthOf(from || to || today))
  const [focusDay, setFocusDay] = useState(today)

  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    setHover(null)
  }, [])

  // Outside press or Escape abandons the draft — nothing is reported to the page.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      close()
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  // Land keyboard users on the applied date (or today) once per opening — picking a
  // day must not yank focus back, so this depends on the target captured at open time.
  useEffect(() => {
    if (!open) return
    popRef.current?.querySelector<HTMLElement>(`[data-day="${focusDay}"]`)?.focus()
  }, [open, focusDay])

  const openPicker = () => {
    setDraft({ from, to })
    setView(viewMonthOf(from || to || today))
    setFocusDay(from || to || today)
    setOpen(true)
  }

  /** Picks the two edges in two clicks: the first sets the start, the second ends it. */
  const select = (day: string) => {
    setDraft((d) => {
      // A finished (or empty) range starts over from the clicked day.
      if (!d.from || d.to) return { from: day, to: '' }
      // ISO strings compare lexicographically; a later→earlier pick is a range, not a mistake.
      if (day < d.from) return { from: day, to: d.from }
      return { from: d.from, to: day }
    })
    setHover(null)
  }

  const apply = () => {
    close()
    onChange({ from: draft.from, to: draft.to })
  }

  /** One deliberate action: drop the filter and report the empty range. */
  const clear = () => {
    setDraft({ from: '', to: '' })
    close()
    onChange({ from: '', to: '' })
  }

  const hasValue = Boolean(from || to)
  // Middle of the drafted range, or of the start → hover preview.
  const previewEnd = !draft.to && draft.from ? hover : null
  const edgeA = previewEnd ?? draft.from
  const edgeB = draft.to || previewEnd || ''
  const [lo, hi] = edgeA < edgeB ? [edgeA, edgeB] : [edgeB, edgeA]
  const arrowProps = {
    size: 14,
    'aria-hidden': true,
    className: 'shrink-0 text-foreground-faint',
  } as const

  return (
    <div ref={rootRef} className={cn('relative w-full text-start sm:w-auto', className)}>
      <div className="flex h-10 items-center rounded-md border border-border-strong bg-surface-input">
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => (open ? close() : openPicker())}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-3 text-start text-base whitespace-nowrap focus-visible:outline-2 focus-visible:outline-focus disabled:text-foreground-disabled disabled:opacity-70"
        >
          <CalendarDays size={16} aria-hidden className="shrink-0 text-foreground-subtle" />
          <span className="sr-only">{labelText}: </span>
          {hasValue ? (
            <span className="flex items-center gap-1.5">
              <span dir="auto" className="tabular-nums">
                {from ? formatIsoDate(from, locale) : '—'}
              </span>
              {rtl ? <ArrowLeft {...arrowProps} /> : <ArrowRight {...arrowProps} />}
              <span dir="auto" className={cn('tabular-nums', !to && 'text-foreground-faint')}>
                {to ? formatIsoDate(to, locale) : '—'}
              </span>
            </span>
          ) : (
            <span className="text-foreground-faint">{t('dateRange.placeholder')}</span>
          )}
        </button>
        {hasValue && !disabled ? (
          <button
            type="button"
            onClick={clear}
            aria-label={t('dateRange.clear')}
            className="me-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground active:bg-surface-active focus-visible:outline-2 focus-visible:outline-focus"
          >
            <X size={14} aria-hidden />
          </button>
        ) : null}
      </div>

      {open && !disabled ? (
        <DateRangePopover
          popRef={popRef}
          label={labelText}
          draft={draft}
          lo={lo}
          hi={hi}
          view={view}
          onViewChange={setView}
          weekStart={weekStart}
          locale={locale}
          rtl={rtl}
          today={today}
          onSelect={select}
          onHover={setHover}
          onToday={() => {
            setDraft({ from: today, to: today })
            setView(viewMonthOf(today))
          }}
          onClear={clear}
          onApply={apply}
        />
      ) : null}
    </div>
  )
}

/**
 * The popover: the draft summary, the month navigation, the day grid and the
 * three deliberate actions.
 *
 * It is ONE component because these are one decision surface — everything
 * between opening the popover and applying or abandoning a range — and because
 * every rule it must not break lives together here: the arrows follow the
 * layout direction, the day values keep their own locale-correct ordering, the
 * draft is never reported upward until Apply, and the popover is explicitly
 * non-modal so it never traps the keyboard.
 */
function DateRangePopover({
  popRef,
  label,
  draft,
  lo,
  hi,
  view,
  onViewChange,
  weekStart,
  locale,
  rtl,
  today,
  onSelect,
  onHover,
  onToday,
  onClear,
  onApply,
}: {
  readonly popRef: React.RefObject<HTMLDivElement | null>
  readonly label: string
  readonly draft: DateRange
  /** The interior of the range, EXCLUSIVE, so a hover preview never fills the ends. */
  readonly lo: string
  readonly hi: string
  readonly view: { year: number; month: number }
  readonly onViewChange: (view: { year: number; month: number }) => void
  readonly weekStart: number
  readonly locale: string
  /** The ARROWS follow the layout direction; the dates never do. */
  readonly rtl: boolean
  readonly today: string
  readonly onSelect: (day: string) => void
  readonly onHover: (day: string | null) => void
  readonly onToday: () => void
  readonly onClear: () => void
  readonly onApply: () => void
}) {
  const { t } = useTranslation()
  const step = (offset: -1 | 1) => onViewChange(addMonths(view.year, view.month, offset))

  return (
    <div
      ref={popRef}
      role="dialog"
      aria-modal="false"
      aria-label={label}
      className="absolute inset-s-0 z-40 mt-2 w-88 max-w-[calc(100vw-2rem)] rounded-lg border border-border-strong bg-surface-popover p-3 shadow-lg"
    >
      {/* Draft summary — an unfinished range is visible before it is applied. */}
      <div className="mb-2 flex flex-col gap-0.5 rounded-md bg-surface-muted px-3 py-2">
        <RangeRow label={t('dateRange.start')} value={draft.from} locale={locale} />
        <RangeRow label={t('dateRange.end')} value={draft.to} locale={locale} />
      </div>

      <div className="mb-1 flex items-center justify-between gap-1">
        <button
          type="button"
          aria-label={t('dateRange.prevMonth')}
          onClick={() => step(-1)}
          className={NAV_BUTTON}
        >
          {rtl ? <ChevronRight size={16} aria-hidden /> : <ChevronLeft size={16} aria-hidden />}
        </button>
        <p className="text-body font-bold text-foreground-strong">
          {formatMonthTitle(view.year, view.month, locale)}
        </p>
        <button
          type="button"
          aria-label={t('dateRange.nextMonth')}
          onClick={() => step(1)}
          className={NAV_BUTTON}
        >
          {rtl ? <ChevronLeft size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
        </button>
      </div>

      {/* Day names are decorative here: every day button carries its full date. */}
      <div aria-hidden className="grid grid-cols-7 text-xs text-foreground-subtle">
        {weekdayLabels(locale, weekStart).map((day, i) => (
          <span key={`${day}-${i}`} className="flex h-7 items-center justify-center">
            {day}
          </span>
        ))}
      </div>

      <DayGrid
        cells={monthCells(view.year, view.month, weekStart)}
        draft={draft}
        lo={lo}
        hi={hi}
        today={today}
        locale={locale}
        onSelect={onSelect}
        onHover={onHover}
      />

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border-subtle pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onToday}>
          {t('dateRange.today')}
        </Button>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClear}>
            {t('dateRange.clear')}
          </Button>
          <Button type="button" size="sm" disabled={!draft.from && !draft.to} onClick={onApply}>
            {t('dateRange.apply')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * The day grid of the popover.
 *
 * Three kinds of cell, and the styling has to keep them apart: a day outside
 * the displayed month (filler, not a control), an ordinary day, and an EDGE of
 * the drafted range. An edge is the strongest thing on screen, so nothing else
 * may share its appearance — which is why the in-range and today rules both
 * explicitly stand down when a cell is an edge, rather than layering on top.
 *
 * The range interior is drawn between `lo` and `hi` exclusive, so a preview
 * that is still being hovered does not paint the two endpoints as filled.
 */
function DayGrid({
  cells,
  draft,
  lo,
  hi,
  today,
  locale,
  onSelect,
  onHover,
}: Readonly<{
  cells: readonly MonthCell[]
  draft: DateRange
  lo: string
  hi: string
  today: string
  locale: string
  onSelect: (day: string) => void
  onHover: (day: string | null) => void
}>) {
  const { t } = useTranslation()
  const inRange = (iso: string) => Boolean(lo && hi && iso > lo && iso < hi)

  return (
    <div className="grid grid-cols-7 gap-y-0.5" onMouseLeave={() => onHover(null)}>
      {cells.map((cell) => {
        if (!cell.inMonth) {
          return (
            <span
              key={cell.iso}
              aria-hidden
              className="flex h-9 items-center justify-center text-sm text-foreground-faint tabular-nums"
            >
              {cell.day}
            </span>
          )
        }
        const isEdge = cell.iso === draft.from || cell.iso === draft.to
        const edgeLabel = edgeLabelFor(cell.iso, draft, t)
        const dateLabel = formatIsoDateLong(cell.iso, locale)
        return (
          <button
            key={cell.iso}
            type="button"
            data-day={cell.iso}
            aria-pressed={isEdge}
            aria-current={cell.iso === today ? 'date' : undefined}
            aria-label={edgeLabel ? `${dateLabel} — ${edgeLabel}` : dateLabel}
            onClick={() => onSelect(cell.iso)}
            onMouseEnter={() => onHover(cell.iso)}
            onFocus={() => onHover(cell.iso)}
            className={cn(
              'relative flex h-9 items-center justify-center rounded-md text-sm tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
              !isEdge && inRange(cell.iso) && 'bg-accent text-foreground',
              !isEdge &&
                !inRange(cell.iso) &&
                'text-foreground hover:bg-surface-hover active:bg-surface-active',
              cell.iso === today && !isEdge && 'font-bold text-foreground-strong',
              isEdge &&
                'bg-primary font-bold text-primary-foreground hover:bg-primary-hover active:bg-primary-active',
            )}
          >
            {cell.day}
            {cell.iso === today ? (
              <span
                aria-hidden
                className={cn(
                  'absolute bottom-0.5 h-1 w-1 rounded-full',
                  isEdge ? 'bg-primary-foreground' : 'bg-primary',
                )}
              />
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

/** One "start / end" line of the draft summary inside the popover. */
function RangeRow({
  label,
  value,
  locale,
}: Readonly<{ readonly label: string; value: string; locale: string }>) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-caption">{label}</span>
      {value ? (
        <span dir="auto" className="text-body tabular-nums">
          {formatIsoDate(value, locale)}
        </span>
      ) : (
        <span aria-hidden className="text-body text-foreground-faint">
          —
        </span>
      )}
    </div>
  )
}
