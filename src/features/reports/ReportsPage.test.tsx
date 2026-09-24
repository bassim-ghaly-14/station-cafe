/**
 * Integration check for the report period filter: the page owns a `from` / `to`
 * pair and the shared DateRangePicker must hand those ISO dates to the report
 * service untouched — no Date objects, no reformatting, no renamed parameters.
 * The picker's own interaction behaviour is covered by its component test.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import {
  addDays,
  formatIsoDate,
  formatIsoDateLong,
  isoDate,
  parseIsoDate,
  todayIso,
} from '@/lib/date'
import { ToastProvider } from '@/components/ui'
import ReportsPage from './ReportsPage'

const mocks = vi.hoisted(() => ({
  salesByDay: vi.fn(),
  productSales: vi.fn(),
  audit: vi.fn(),
  printJobs: vi.fn(),
}))

vi.mock('@/services/opsApi', () => ({
  opsApi: {
    salesByDay: mocks.salesByDay,
    productSales: mocks.productSales,
    audit: mocks.audit,
    printJobs: mocks.printJobs,
  },
}))

const today = todayIso()
const weekAgo = addDays(today, -6)
// The picker opens on the month of the applied `from`, so pick inside that month.
const viewMonth = parseIsoDate(weekAgo) ?? { year: 2026, month: 1, day: 1 }
const firstDay = isoDate(viewMonth.year, viewMonth.month, 1)
const tenthDay = isoDate(viewMonth.year, viewMonth.month, 10)
const ISO = /^\d{4}-\d{2}-\d{2}$/

// Let i18n finish initializing before anything renders, so no late re-render happens mid-test.
await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

function renderPage() {
  return render(
    <ToastProvider>
      <ReportsPage />
    </ToastProvider>,
  )
}

/** Opens the period control from its current (formatted) trigger and picks a completed range. */
function applyPeriod(displayedFrom: string, from: string, to: string) {
  fireEvent.click(
    screen.getByRole('button', { name: new RegExp(formatIsoDate(displayedFrom, 'ar-EG')) }),
  )
  const dialog = screen.getByRole('dialog')
  for (const day of [from, to]) {
    fireEvent.click(
      within(dialog).getByRole('button', { name: new RegExp(formatIsoDateLong(day, 'ar-EG')) }),
    )
  }
  fireEvent.click(within(dialog).getByRole('button', { name: 'تطبيق' }))
}

describe('ReportsPage period filter', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.salesByDay.mockReset().mockResolvedValue([])
    mocks.productSales.mockReset().mockResolvedValue([])
    mocks.audit.mockReset().mockResolvedValue([])
    mocks.printJobs.mockReset().mockResolvedValue([])
  })

  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage(DEFAULT_LOCALE)
    })
  })

  it('loads the report with a seven-day business-date period by default', async () => {
    renderPage()
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenCalledWith(weekAgo, today))

    const [from, to] = mocks.salesByDay.mock.calls[0] as [string, string]
    expect(from).toMatch(ISO)
    expect(to).toMatch(ISO)
  })

  it('sends the picked period to the report API as exact ISO dates', async () => {
    renderPage()
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenCalledTimes(1))

    applyPeriod(weekAgo, firstDay, tenthDay)

    await waitFor(() => expect(mocks.salesByDay).toHaveBeenLastCalledWith(firstDay, tenthDay))
    expect(
      screen.getByRole('button', { name: new RegExp(formatIsoDate(firstDay, 'ar-EG')) }),
    ).toBeInTheDocument()
  })

  it('clears the period to empty strings, exactly like an emptied date field', async () => {
    renderPage()
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'مسح' }))

    await waitFor(() => expect(mocks.salesByDay).toHaveBeenLastCalledWith('', ''))
  })

  it('shares the applied period with the product sales tab', async () => {
    renderPage()
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenCalledTimes(1))

    applyPeriod(weekAgo, firstDay, tenthDay)
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenLastCalledWith(firstDay, tenthDay))

    fireEvent.click(screen.getByRole('tab', { name: 'مبيعات الأصناف' }))

    await waitFor(() => expect(mocks.productSales).toHaveBeenCalledWith(firstDay, tenthDay))
  })
})
