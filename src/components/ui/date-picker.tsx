/**
 * DatePicker — one calendar date, for entities that own exactly ONE business date
 * (an expense date, an invoice date). The single-date sibling of `DateRangePicker`:
 * same trigger, popover and month grid, but one value instead of a period.
 *
 * Values cross the component boundary as plain `YYYY-MM-DD` strings (empty string =
 * nothing selected) — no Date objects, no timezone drift. A single date needs no
 * draft, so picking a day reports it immediately and closes the calendar; there is
 * no Apply step and nothing to keep "pending". Direction follows the app (`isRtl`),
 * while each date value keeps its own locale-correct ordering.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
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
} from '@/lib/date'
import { Button } from './button'
import { CalendarDays, ChevronLeft, ChevronRight, X } from './icon'

export interface DatePickerProps {
  /** Selected business date, `YYYY-MM-DD`; empty string when nothing is selected. */
  value: string
  /** Reports a picked (or cleared) day as `YYYY-MM-DD` — never a Date, never a range. */
  onChange: (value: string) => void
  /** Accessible name of the control; defaults to the shared "date" label. */
  label?: string
  className?: string
  disabled?: boolean
}

/** Compact month-nav button — same visual language as DateRangePicker. */
const NAV_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground active:bg-surface-active'

/** Visible month for an ISO date (falls back to the local current month). */
function viewMonthOf(iso: string): { year: number; month: number } {
  const parts = parseIsoDate(iso) ?? parseIsoDate(todayIso())
  return parts ? { year: parts.year, month: parts.month } : { year: 2026, month: 1 }
}

export function DatePicker({
  value,
  onChange,
  label,
  className,
  disabled = false,
}: Readonly<DatePickerProps>) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const rtl = isRtl(locale)
  const today = todayIso()
  const labelText = label ?? t('app.date')

  // Month navigation, "today" and "clear" are generic date actions, so the single
  // and the range control deliberately share the same `dateRange.*` strings.
  const placeholder = t('datePicker.placeholder')
  const weekStart = weekStartIndex(locale)

  const [open, setOpen] = useState(false)
  const [view, setView] = useState(() => viewMonthOf(value))

  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = useCallback(() => setOpen(false), [])

  // Outside press closes the calendar; Escape closes the calendar ONLY, so the same
  // key pressed inside a modal dialog dismisses the popover instead of the whole form.
  // The capture phase keeps the enclosing dialog's document-level Escape handler from
  // ever seeing the key while the calendar is open.
  useEffect(() => {
    if (!open) return

    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
      triggerRef.current?.focus()
    }

    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)

    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, close])

  // Land keyboard users on the selected day (or today) once per opening.
  useEffect(() => {
    if (!open) return

    popRef.current?.querySelector<HTMLElement>(`[data-day="${value || today}"]`)?.focus()
  }, [open, value, today])

  const openPicker = () => {
    setView(viewMonthOf(value))
    setOpen(true)
  }

  /** One click, one date: report it and hand focus back to the trigger. */
  const select = (day: string) => {
    close()
    onChange(day)
    triggerRef.current?.focus()
  }

  /** Back to "no date" — the state an emptied native date input used to produce. */
  const clear = () => {
    close()
    onChange('')
    triggerRef.current?.focus()
  }

  const hasValue = Boolean(parseIsoDate(value))
  const cells = monthCells(view.year, view.month, weekStart)

  // The field may sit inside a `<label>` (the app's `Field` primitive) and a label
  // element would prepend its own text to the trigger's name, so the control names
  // itself explicitly and keeps one clean, undoubled accessible name anywhere.
  const valueText = formatIsoDate(value, locale)

  return (
    <div ref={rootRef} className={cn('relative w-full text-start sm:w-auto', className)}>
      <div className="flex h-10 items-center rounded-md border border-border-strong bg-surface-input">
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={hasValue ? `${labelText}: ${valueText}` : `${labelText}: ${placeholder}`}
          onClick={() => (open ? close() : openPicker())}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-3 text-start text-base whitespace-nowrap focus-visible:outline-2 focus-visible:outline-focus disabled:text-foreground-disabled disabled:opacity-70"
        >
          <CalendarDays size={16} aria-hidden className="shrink-0 text-foreground-subtle" />

          {hasValue ? (
            <span dir="auto" className="tabular-nums">
              {valueText}
            </span>
          ) : (
            <span className="text-foreground-faint">{placeholder}</span>
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
        <div
          ref={popRef}
          role="dialog"
          aria-modal="false"
          aria-label={labelText}
          className="absolute inset-s-0 z-40 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border-strong bg-surface-popover p-2 shadow-lg"
        >
          <div className="mb-1 flex items-center justify-between gap-1">
            <button
              type="button"
              aria-label={t('dateRange.prevMonth')}
              onClick={() => setView((v) => addMonths(v.year, v.month, -1))}
              className={NAV_BUTTON}
            >
              {rtl ? <ChevronRight size={16} aria-hidden /> : <ChevronLeft size={16} aria-hidden />}
            </button>

            <p className="text-sm font-bold text-foreground-strong">
              {formatMonthTitle(view.year, view.month, locale)}
            </p>

            <button
              type="button"
              aria-label={t('dateRange.nextMonth')}
              onClick={() => setView((v) => addMonths(v.year, v.month, 1))}
              className={NAV_BUTTON}
            >
              {rtl ? <ChevronLeft size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
            </button>
          </div>

          {/* Day names are decorative here: every day button carries its full date. */}
          <div aria-hidden className="grid grid-cols-7 text-[11px] text-foreground-subtle">
            {weekdayLabels(locale, weekStart).map((day, i) => (
              <span key={`${day}-${i}`} className="flex h-6 items-center justify-center">
                {day}
              </span>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-y-0.5">
            {cells.map((cell) => {
              if (!cell.inMonth) {
                return (
                  <span
                    key={cell.iso}
                    aria-hidden
                    className="flex h-8 items-center justify-center text-[13px] text-foreground-faint tabular-nums"
                  >
                    {cell.day}
                  </span>
                )
              }

              const selected = cell.iso === value

              return (
                <button
                  key={cell.iso}
                  type="button"
                  data-day={cell.iso}
                  aria-pressed={selected}
                  aria-current={cell.iso === today ? 'date' : undefined}
                  aria-label={formatIsoDateLong(cell.iso, locale)}
                  onClick={() => select(cell.iso)}
                  className={cn(
                    'relative flex h-8 items-center justify-center rounded-md text-[13px] tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
                    !selected && 'text-foreground hover:bg-surface-hover active:bg-surface-active',
                    cell.iso === today && !selected && 'font-bold text-foreground-strong',
                    selected &&
                      'bg-primary font-bold text-primary-foreground hover:bg-primary-hover active:bg-primary-active',
                  )}
                >
                  {cell.day}

                  {cell.iso === today ? (
                    <span
                      aria-hidden
                      className={cn(
                        'absolute bottom-0.5 h-1 w-1 rounded-full',
                        selected ? 'bg-primary-foreground' : 'bg-primary',
                      )}
                    />
                  ) : null}
                </button>
              )
            })}
          </div>

          {/* A single date needs no draft summary and no Apply — one quick action is enough. */}
          <div className="mt-1 flex items-center justify-between gap-2 border-t border-border-subtle pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => select(today)}>
              {t('dateRange.today')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
