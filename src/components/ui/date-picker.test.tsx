/**
 * DatePicker tests — single-date semantics only. The calendar grid, month maths and
 * shared visual language are covered by the DateRangePicker suite, so here we assert
 * what is different: one value, applied on one click, never a range.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import {
  addMonths,
  formatIsoDate,
  formatIsoDateLong,
  formatMonthTitle,
  isoDate,
  parseIsoDate,
  todayIso,
} from '@/lib/date'
import { DatePicker } from './date-picker'

const today = todayIso()
const todayParts = parseIsoDate(today) ?? { year: 2026, month: 1, day: 1 }
const dayIn = (day: number) => isoDate(todayParts.year, todayParts.month, day)
const [third, tenth] = [3, 10].map(dayIn)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// Let i18n finish initializing before anything renders, so no late re-render happens mid-test.
await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

/** The trigger reads the short date; calendar cells the long one. */
const dayName = (iso: string) => new RegExp(formatIsoDate(iso, 'ar-EG'))
const cellName = (iso: string) => new RegExp(formatIsoDateLong(iso, 'ar-EG'))
const PLACEHOLDER = /اختر التاريخ/

const openCalendar = (name: RegExp = PLACEHOLDER) => {
  fireEvent.click(screen.getByRole('button', { name }))
  return screen.getByRole('dialog')
}

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage(DEFAULT_LOCALE)
  })
})

describe('DatePicker', () => {
  it('renders the controlled value, and the placeholder while unset', () => {
    const { rerender } = render(<DatePicker value={third} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: dayName(third) })).toHaveTextContent(
      formatIsoDate(third, 'ar-EG'),
    )

    rerender(<DatePicker value="" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: PLACEHOLDER })).toBeInTheDocument()
  })

  it('opens a compact calendar dialog with month navigation', () => {
    render(<DatePicker value={third} onChange={() => {}} />)
    const trigger = screen.getByRole('button', { name: dayName(third) })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    const dialog = openCalendar(dayName(third))
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(
      within(dialog).getByText(formatMonthTitle(todayParts.year, todayParts.month, 'ar-EG')),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'الشهر السابق' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'الشهر التالي' })).toBeInTheDocument()
    // Today is hinted, the selected day is pressed.
    expect(within(dialog).getByRole('button', { name: cellName(today) })).toHaveAttribute(
      'aria-current',
      'date',
    )
    expect(within(dialog).getByRole('button', { name: cellName(third) })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('reports exactly one ISO date on a single click, then closes', () => {
    const onChange = vi.fn()
    render(<DatePicker value="" onChange={onChange} />)
    const dialog = openCalendar()

    fireEvent.click(within(dialog).getByRole('button', { name: cellName(tenth) }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(tenth)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('never emits a range object — only a plain YYYY-MM-DD string', () => {
    const onChange = vi.fn()
    render(<DatePicker value="" onChange={onChange} />)
    const dialog = openCalendar()

    fireEvent.click(within(dialog).getByRole('button', { name: cellName(tenth) }))

    // One argument, a string: no `{ from, to }` shape can ever leave this control.
    expect(onChange.mock.calls[0]).toHaveLength(1)
    const arg: unknown = onChange.mock.calls[0][0]
    expect(typeof arg).toBe('string')
    expect(arg as string).toMatch(ISO_DATE)
    expect(arg).not.toEqual({ from: tenth, to: tenth })
  })

  it('quick-picks the local business date with اليوم', () => {
    const onChange = vi.fn()
    render(<DatePicker value="" onChange={onChange} />)
    const dialog = openCalendar()

    fireEvent.click(within(dialog).getByRole('button', { name: 'اليوم' }))

    expect(onChange).toHaveBeenCalledWith(today)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('navigates months without reporting anything', () => {
    const onChange = vi.fn()
    render(<DatePicker value={today} onChange={onChange} />)
    const dialog = openCalendar(dayName(today))
    const next = addMonths(todayParts.year, todayParts.month, 1)

    fireEvent.click(within(dialog).getByRole('button', { name: 'الشهر التالي' }))
    expect(
      within(dialog).getByText(formatMonthTitle(next.year, next.month, 'ar-EG')),
    ).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'الشهر السابق' }))
    expect(
      within(dialog).getByText(formatMonthTitle(todayParts.year, todayParts.month, 'ar-EG')),
    ).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('clears back to the unset state from the trigger', () => {
    const onChange = vi.fn()
    const { rerender } = render(<DatePicker value={third} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'مسح' }))
    expect(onChange).toHaveBeenCalledWith('')

    rerender(<DatePicker value="" onChange={onChange} />)
    expect(screen.getByRole('button', { name: PLACEHOLDER })).toBeInTheDocument()
  })

  it('closes on Escape without reporting anything and keeps the trigger focused', () => {
    const onChange = vi.fn()
    render(<DatePicker value={third} onChange={onChange} />)
    openCalendar(dayName(third))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: dayName(third) })).toHaveFocus()
  })

  it('stays closed and clear-less while disabled', () => {
    const onChange = vi.fn()
    render(<DatePicker value={third} onChange={onChange} disabled />)

    const trigger = screen.getByRole('button', { name: dayName(third) })
    expect(trigger).toBeDisabled()
    fireEvent.click(trigger)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'مسح' })).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps logical RTL structure instead of hardcoded sides', () => {
    render(<DatePicker value={third} onChange={() => {}} />)
    expect(document.documentElement.dir).toBe('rtl')

    const dialog = openCalendar(dayName(third))
    // Inline-start placement, so the popover follows the writing direction.
    expect(dialog.className).toContain('inset-s-0')
  })

  it('formats the control for the active (LTR) locale', async () => {
    await act(async () => {
      await i18n.changeLanguage('en-US')
    })
    render(<DatePicker value="2026-09-01" onChange={() => {}} />)

    expect(screen.getByRole('button', { name: /Sep 01, 2026/ })).toBeInTheDocument()
    expect(document.documentElement.dir).toBe('ltr')
  })
})
