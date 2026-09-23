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
import { DateRangePicker } from './date-range-picker'

const today = todayIso()
const todayParts = parseIsoDate(today) ?? { year: 2026, month: 1, day: 1 }
const dayIn = (day: number) => isoDate(todayParts.year, todayParts.month, day)
const [start, third, middle, end] = [1, 3, 5, 10].map(dayIn)

// Let i18n finish initializing before anything renders, so no late re-render happens mid-test.
await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

/** The trigger and the draft summary read the short date; calendar cells the long one. */
const dayName = (iso: string) => new RegExp(formatIsoDate(iso, 'ar-EG'))
const cellName = (iso: string) => new RegExp(formatIsoDateLong(iso, 'ar-EG'))

const openPicker = (name: RegExp) => {
  fireEvent.click(screen.getByRole('button', { name }))
  return screen.getByRole('dialog')
}

describe('DateRangePicker', () => {
  it('shows a placeholder and opens a compact calendar dialog', () => {
    render(<DateRangePicker from="" to="" onChange={() => {}} />)
    const trigger = screen.getByRole('button', { name: /اختر الفترة/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    const dialog = openPicker(/اختر الفترة/)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(
      within(dialog).getByText(formatMonthTitle(todayParts.year, todayParts.month, 'ar-EG')),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'الشهر السابق' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'الشهر التالي' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'تطبيق' })).toBeDisabled()
  })

  it('keeps the selection temporary until Apply, then reports ISO dates', () => {
    const onChange = vi.fn()
    render(<DateRangePicker from="" to="" onChange={onChange} />)
    const dialog = openPicker(/اختر الفترة/)

    fireEvent.click(within(dialog).getByRole('button', { name: cellName(start) }))
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: cellName(end) }))
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'تطبيق' }))
    expect(onChange).toHaveBeenCalledWith({ from: start, to: end })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('marks the range edges and the days in between', () => {
    render(<DateRangePicker from={start} to={end} onChange={() => {}} />)
    const dialog = openPicker(dayName(start))

    const startCell = within(dialog).getByRole('button', { name: cellName(start) })
    expect(startCell).toHaveAttribute('aria-pressed', 'true')
    expect(startCell.getAttribute('aria-label')).toContain('من تاريخ')

    const endCell = within(dialog).getByRole('button', { name: cellName(end) })
    expect(endCell).toHaveAttribute('aria-pressed', 'true')
    expect(endCell.getAttribute('aria-label')).toContain('إلى تاريخ')

    const middleCell = within(dialog).getByRole('button', { name: cellName(middle) })
    expect(middleCell).toHaveAttribute('aria-pressed', 'false')
    expect(middleCell).toHaveClass('bg-accent')
  })

  it('starts a new range when a complete one already exists', () => {
    const onChange = vi.fn()
    render(<DateRangePicker from={start} to={end} onChange={onChange} />)
    const dialog = openPicker(dayName(start))

    // A finished range restarts: only the new start is picked, the end stays open.
    fireEvent.click(within(dialog).getByRole('button', { name: cellName(third) }))
    expect(within(dialog).getByText('—')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'تطبيق' }))
    expect(onChange).toHaveBeenCalledWith({ from: third, to: '' })
  })

  it('quick-picks today as a single-day range', () => {
    const onChange = vi.fn()
    render(<DateRangePicker from="" to="" onChange={onChange} />)
    const dialog = openPicker(/اختر الفترة/)

    fireEvent.click(within(dialog).getByRole('button', { name: 'اليوم' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'تطبيق' }))
    expect(onChange).toHaveBeenCalledWith({ from: today, to: today })
  })

  it('clears an applied range from the trigger in one action', () => {
    const onChange = vi.fn()
    const { rerender } = render(<DateRangePicker from={start} to={end} onChange={onChange} />)
    expect(screen.getByRole('button', { name: dayName(start) })).toHaveTextContent(
      formatIsoDate(end, 'ar-EG'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'مسح' }))
    expect(onChange).toHaveBeenCalledWith({ from: '', to: '' })

    rerender(<DateRangePicker from="" to="" onChange={onChange} />)
    expect(screen.getByRole('button', { name: /اختر الفترة/ })).toBeInTheDocument()
  })

  it('navigates months without touching the reported values', () => {
    const onChange = vi.fn()
    render(<DateRangePicker from={today} to="" onChange={onChange} />)
    const dialog = openPicker(dayName(today))
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

  it('closes on Escape without reporting anything', () => {
    const onChange = vi.fn()
    render(<DateRangePicker from={start} to="" onChange={onChange} />)
    const dialog = openPicker(dayName(start))
    fireEvent.click(within(dialog).getByRole('button', { name: cellName(third) }))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('formats the control for the active (LTR) locale', async () => {
    await act(async () => {
      await i18n.changeLanguage('en-US')
    })
    render(<DateRangePicker from="2026-09-01" to="2026-09-22" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: /Sep 01, 2026/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Sep 22, 2026/ })).toBeInTheDocument()
  })

  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage(DEFAULT_LOCALE)
    })
  })
})
