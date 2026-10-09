/**
 * The monthly tab's own behaviour: which month it asks for, and what it does
 * with the answer.
 *
 * The figures are not re-tested here — they arrive whole from the backend. What
 * belongs to this surface is the month SELECTION (the current month is the
 * backend's decision, never the browser's), the three states every Station panel
 * has, and the print trigger.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import type { MonthlyExecutiveReport } from '@/services/opsApi'
import { MonthlyReportsPanel } from './MonthlyReportsPanel'

const mocks = vi.hoisted(() => ({
  monthlyExecutive: vi.fn(),
  monthly: vi.fn(),
  monthlySalesPeriod: vi.fn(),
  printMonthlyReport: vi.fn(),
}))

vi.mock('@/services/opsApi', () => ({
  opsApi: { monthlyExecutive: mocks.monthlyExecutive },
}))

/** The one module the export button delegates to; see `./monthlyPrint`. */
vi.mock('./monthlyPrint', () => ({
  printMonthlyReport: mocks.printMonthlyReport,
  releaseMonthlyPrint: vi.fn(),
  watchPrintEnd: () => () => {},
}))

vi.mock('@/services/posApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/posApi')>()),
  settingsApi: { monthlySalesPeriod: mocks.monthlySalesPeriod },
}))

vi.mock('@/services/salesApi', () => ({
  salesApi: { monthly: mocks.monthly },
}))

const REPORT: MonthlyExecutiveReport = {
  month: '2026-09',
  from: '2026-09-01',
  to: '2026-09-30',
  comparison_month: '2026-08',
  comparison: 'PREVIOUS_MONTH',
  cafe: {
    actual_minor: 8_240_000,
    target_minor: 8_000_000,
    overridden: false,
    achievement_percent: '103.00',
  },
  wash: {
    actual_minor: 4_300_000,
    target_minor: 4_500_000,
    overridden: false,
    achievement_percent: '95.56',
  },
  money: { revenue_minor: 12_540_000, expenses_minor: 3_240_000, net_minor: 9_300_000 },
  comparison_figures: {
    revenue_minor: 11_820_000,
    expenses_minor: 2_980_000,
    net_minor: 8_840_000,
  },
}

const renderPanel = () =>
  render(
    <ToastProvider>
      <MonthlyReportsPanel />
    </ToastProvider>,
  )

describe('MonthlyReportsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.monthlyExecutive.mockResolvedValue(REPORT)
    mocks.monthlySalesPeriod.mockResolvedValue({ months: 12 })
    mocks.printMonthlyReport.mockReset().mockResolvedValue(undefined)
    mocks.monthly.mockResolvedValue({
      from: '2025-10-01',
      to: '2026-09-30',
      months: [
        { month: '2026-08', invoices_count: 10, total_sales: 1, cafe_sales: 1, wash_sales: 0 },
        { month: '2026-09', invoices_count: 10, total_sales: 1, cafe_sales: 1, wash_sales: 0 },
      ],
    })
  })

  /**
   * The first read carries NO month, so the backend answers for the Cairo
   * business month, and NO comparison mode, so it is the month before. A month
   * guessed by the browser could be the wrong one.
   */
  it('opens on the backend current month rather than one the browser picked', async () => {
    renderPanel()
    await waitFor(() => expect(mocks.monthlyExecutive).toHaveBeenCalledWith(undefined, undefined))
    expect(await screen.findByTestId('monthly-report-document')).toBeInTheDocument()
  })

  it('offers the months that already have trading, and asks for the one chosen', async () => {
    renderPanel()
    const picker = await screen.findByTestId('monthly-report-month')
    await waitFor(() =>
      expect([...picker.querySelectorAll('option')].map((option) => option.value)).toContain(
        '2026-08',
      ),
    )

    fireEvent.change(picker, { target: { value: '2026-08' } })
    await waitFor(() => expect(mocks.monthlyExecutive).toHaveBeenCalledWith('2026-08', undefined))
  })

  /**
   * The export bug this surface exists to keep fixed: the click must reach the
   * print pipeline, not stop at a `window.print()` that WKWebView never runs.
   */
  /**
   * The comparison mode is a control of its OWN, separate from the month: the
   * manager asks a different question without being moved to a different month.
   * Both modes are offered, both are labelled, and the month on screen never
   * changes when the comparison does.
   */
  it('offers both comparison modes and leaves the reporting month where it was', async () => {
    renderPanel()
    const picker = await screen.findByTestId('monthly-report-month')
    await waitFor(() =>
      expect([...picker.querySelectorAll('option')].map((option) => option.value)).toContain(
        '2026-08',
      ),
    )
    fireEvent.change(picker, { target: { value: '2026-08' } })
    await waitFor(() => expect(mocks.monthlyExecutive).toHaveBeenCalledWith('2026-08', undefined))

    const comparison = screen.getByTestId('monthly-report-comparison') as HTMLSelectElement
    // The month before is the default, so an existing report behaves as it did.
    expect(comparison.value).toBe('PREVIOUS_MONTH')
    expect([...comparison.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'الشهر السابق',
      'نفس الشهر من العام الماضي',
    ])

    fireEvent.change(comparison, { target: { value: 'SAME_MONTH_PREVIOUS_YEAR' } })
    // Same month, new comparison: switching mode must never move the month.
    await waitFor(() =>
      expect(mocks.monthlyExecutive).toHaveBeenLastCalledWith(
        '2026-08',
        'SAME_MONTH_PREVIOUS_YEAR',
      ),
    )
    expect(picker).toHaveValue('2026-08')
  })

  /** An out-of-order answer must never overwrite the newest selection. */
  it('discards a slower earlier request so it cannot overwrite the chosen mode', async () => {
    const seen: { month?: string; comparison?: string }[] = []
    mocks.monthlyExecutive.mockImplementation(
      (_month: string | undefined, comparison: string | undefined) =>
        new Promise((resolve) => {
          seen.push({ comparison })
          // The year-over-year read resolves FIRST, the previous-month one after.
          const delay = comparison === 'SAME_MONTH_PREVIOUS_YEAR' ? 0 : 30
          setTimeout(() => resolve({ ...REPORT, comparison }), delay)
        }),
    )
    renderPanel()
    const comparison = await screen.findByTestId('monthly-report-comparison')
    await waitFor(() => expect(mocks.monthlyExecutive).toHaveBeenCalled())

    fireEvent.change(comparison, { target: { value: 'SAME_MONTH_PREVIOUS_YEAR' } })
    await waitFor(() =>
      expect(mocks.monthlyExecutive).toHaveBeenLastCalledWith(
        undefined,
        'SAME_MONTH_PREVIOUS_YEAR',
      ),
    )
    // The later selection is what lands, whatever order the answers arrive in.
    await waitFor(() => expect(comparison).toHaveValue('SAME_MONTH_PREVIOUS_YEAR'))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(seen.length).toBeGreaterThanOrEqual(2)
  })

  it('hands the selected month sheet to the print pipeline', async () => {
    renderPanel()
    const button = await screen.findByTestId('monthly-report-print')

    fireEvent.click(button)
    await waitFor(() => expect(mocks.printMonthlyReport).toHaveBeenCalledTimes(1))
  })

  it('restores the export button and says so when the print job is refused', async () => {
    mocks.printMonthlyReport.mockRejectedValue(new Error('no panel'))
    renderPanel()
    const button = await screen.findByTestId('monthly-report-print')

    fireEvent.click(button)
    await waitFor(() => expect(mocks.printMonthlyReport).toHaveBeenCalled())
    // The failure is stated, not swallowed, and the button works again.
    expect(await screen.findByText('تعذر فتح نافذة الطباعة')).toBeInTheDocument()
    await waitFor(() => expect(button).not.toBeDisabled())
  })

  it('does not raise a second print job while the first is still open', async () => {
    let finish: (() => void) | undefined
    mocks.printMonthlyReport.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    renderPanel()
    const button = await screen.findByTestId('monthly-report-print')

    fireEvent.click(button)
    await waitFor(() => expect(button).toBeDisabled())
    fireEvent.click(button)
    expect(mocks.printMonthlyReport).toHaveBeenCalledTimes(1)

    finish?.()
    await waitFor(() => expect(button).not.toBeDisabled())
  })

  it('steps to an adjacent month through the same list the selector offers', async () => {
    renderPanel()
    await screen.findByTestId('monthly-report-month')
    await waitFor(() => expect(mocks.monthly).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'الشهر السابق' }))
    await waitFor(() =>
      expect(mocks.monthlyExecutive).toHaveBeenLastCalledWith('2026-08', undefined),
    )
  })

  it('shows the failure with a retry rather than an empty page', async () => {
    mocks.monthlyExecutive.mockRejectedValue({ message: 'db.error' })
    renderPanel()
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    mocks.monthlyExecutive.mockResolvedValue(REPORT)
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }))
    expect(await screen.findByTestId('monthly-report-document')).toBeInTheDocument()
  })
})
