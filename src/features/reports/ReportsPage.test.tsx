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
  formatDate,
  formatIsoDate,
  formatIsoDateLong,
  isoDate,
  parseIsoDate,
  todayIso,
} from '@/lib/date'
import { ToastProvider } from '@/components/ui'
import type { AnalyticsCharts } from '@/services/opsApi'
import ReportsPage from './ReportsPage'
import { CATEGORY_PRESENTATION, toAnalyticsCharts } from './charts/analyticsCharts'

/**
 * Report DTO shaped exactly like the `analytics_charts` Tauri command returns it
 * (aggregated in Rust from invoices/payments/expenses). The page must render
 * whatever the backend reports — no front-end statistics.
 */
const chartsReport: AnalyticsCharts = {
  charts: [
    {
      id: 'laundry-cafe',
      total: 30_000,
      has_data: true,
      categories: [
        { id: 'laundry', value: 20_000 },
        { id: 'cafe', value: 10_000 },
      ],
    },
    {
      id: 'cash-visa',
      total: 5_000,
      has_data: true,
      categories: [
        { id: 'cash', value: 4_000 },
        { id: 'visa', value: 1_000 },
      ],
    },
    {
      id: 'sales-expenses',
      total: 9_000,
      has_data: true,
      categories: [
        { id: 'sales', value: 6_000 },
        { id: 'expenses', value: 3_000 },
      ],
    },
  ],
}

const mocks = vi.hoisted(() => ({
  salesByDay: vi.fn(),
  productSales: vi.fn(),
  analyticsCharts: vi.fn(),
  audit: vi.fn(),
  printJobs: vi.fn(),
  printConfig: vi.fn(),
  printTest: vi.fn(),
}))

vi.mock('@/services/opsApi', () => ({
  opsApi: {
    salesByDay: mocks.salesByDay,
    productSales: mocks.productSales,
    analyticsCharts: mocks.analyticsCharts,
    audit: mocks.audit,
    printJobs: mocks.printJobs,
    printConfig: mocks.printConfig,
    printTest: mocks.printTest,
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
    mocks.analyticsCharts.mockReset().mockResolvedValue(chartsReport)
    mocks.audit.mockReset().mockResolvedValue([])
    mocks.printJobs.mockReset().mockResolvedValue([])
    mocks.printConfig.mockReset().mockResolvedValue({
      target: 'share:XP80',
      arabic_mode: 'CP1256',
      codepage: 22,
      logo: true,
      duplicate_window_secs: 60,
    })
    mocks.printTest.mockReset()
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

  it('renders the three charts from the persisted analytics report and the shared period control', async () => {
    renderPage()
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('tab', { name: 'الرسوم البيانية' }))

    await waitFor(() => expect(mocks.analyticsCharts).toHaveBeenCalledWith(weekAgo, today))
    expect(screen.getByRole('button', { name: /الفترة الزمنية/ })).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: 'المغسلة مقابل الكافيه' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'كاش مقابل فيزا' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'المبيعات مقابل المصروفات' })).toBeInTheDocument()
    // Values come from the report: 20,000 + 10,000 minor units for the first donut.
    expect(screen.getByRole('img', { name: /المغسلة مقابل الكافيه: 300/ })).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'إجراءات تصدير الرسوم البيانية' })[0])
    expect(screen.getByRole('menuitem', { name: 'تصدير كصورة PNG' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'تصدير Excel' })).toBeInTheDocument()
  })

  it('refreshes all three charts when the applied period changes', async () => {
    renderPage()
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('tab', { name: 'الرسوم البيانية' }))
    await waitFor(() => expect(mocks.analyticsCharts).toHaveBeenCalledTimes(1))

    applyPeriod(weekAgo, firstDay, tenthDay)

    await waitFor(() => expect(mocks.analyticsCharts).toHaveBeenLastCalledWith(firstDay, tenthDay))
  })

  it('clears the charts period to empty strings like an emptied date field', async () => {
    renderPage()
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('tab', { name: 'الرسوم البيانية' }))
    await waitFor(() => expect(mocks.analyticsCharts).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'مسح' }))

    await waitFor(() => expect(mocks.analyticsCharts).toHaveBeenLastCalledWith('', ''))
  })

  it('shows the report empty state when the backend reports no charts', async () => {
    mocks.analyticsCharts.mockResolvedValue({ charts: [] })
    renderPage()
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('tab', { name: 'الرسوم البيانية' }))

    expect(await screen.findByText('لا توجد بيانات كافية لعرض التحليل')).toBeInTheDocument()
    // The empty state explains itself rather than just reporting absence.
    expect(screen.getByText(/ستظهر المؤشرات والرسوم البيانية هنا/)).toBeInTheDocument()
    expect(screen.getByText(/لم تُسجَّل أي فواتير أو مصروفات خلال الفترة/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'كاش مقابل فيزا' })).not.toBeInTheDocument()
  })

  it('shows a per-chart empty state when a chart has no data in the period', async () => {
    mocks.analyticsCharts.mockResolvedValue({
      charts: chartsReport.charts.map((chart) => ({
        ...chart,
        total: 0,
        has_data: false,
        categories: chart.categories.map((category) => ({ ...category, value: 0 })),
      })),
    })
    renderPage()
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('tab', { name: 'الرسوم البيانية' }))

    // Each card keeps its identity and explains its own emptiness.
    await waitFor(() => expect(screen.getAllByText('لا توجد حركة في هذه الفترة')).toHaveLength(3))
    expect(screen.getByRole('heading', { name: 'كاش مقابل فيزا' })).toBeInTheDocument()
    expect(screen.getAllByText(/لم يُسجَّل أي مبلغ لهذا المؤشر/)).toHaveLength(3)
    // No chart pretends to hold data: nothing to expand or export.
    expect(screen.queryByRole('button', { name: /تكبير الرسم البياني:/ })).not.toBeInTheDocument()
  })

  it('surfaces analytics report failures instead of fabricating values', async () => {
    mocks.analyticsCharts.mockRejectedValue(new Error('internal_error'))
    renderPage()
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('tab', { name: 'الرسوم البيانية' }))

    expect(await screen.findByText('حدث خطأ غير متوقع، حاول مرة أخرى')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'كاش مقابل فيزا' })).not.toBeInTheDocument()
  })

  it('keeps the charts loading until the report resolves', async () => {
    let resolveReport: ((value: AnalyticsCharts) => void) | undefined
    mocks.analyticsCharts.mockReturnValue(
      new Promise<AnalyticsCharts>((done) => {
        resolveReport = done
      }),
    )
    renderPage()
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('tab', { name: 'الرسوم البيانية' }))

    expect(screen.queryByRole('heading', { name: 'كاش مقابل فيزا' })).not.toBeInTheDocument()
    expect(screen.queryByText('لا توجد بيانات لهذه الفترة')).not.toBeInTheDocument()

    resolveReport?.(chartsReport)
    expect(await screen.findByRole('heading', { name: 'كاش مقابل فيزا' })).toBeInTheDocument()
  })

  it('maps report ids to themed presentation without changing reported values', () => {
    const mapped = toAnalyticsCharts({
      charts: [
        ...chartsReport.charts,
        { id: 'unknown-chart', total: 5, has_data: true, categories: [] },
      ],
    })

    expect(mapped).toHaveLength(3)
    expect(mapped[0].total).toBe(30_000)
    expect(mapped[0].hasData).toBe(true)
    // Categories carry a translation KEY, never a display string, so the copy
    // lives in the catalogue rather than in the view model.
    expect(mapped[0].categories).toEqual([
      { id: 'laundry', labelKey: 'laundry', value: 20_000, color: 'var(--primary)' },
      { id: 'cafe', labelKey: 'cafe', value: 10_000, color: 'var(--info)' },
    ])
    expect(mapped.flatMap((chart) => chart.categories.map((category) => category.value))).toEqual([
      20_000, 10_000, 4_000, 1_000, 6_000, 3_000,
    ])
  })

  it('uses only existing Station semantic tokens for chart segments', () => {
    const colors = Object.values(CATEGORY_PRESENTATION).map((category) => category.color)

    expect(colors).toEqual([
      'var(--primary)',
      'var(--info)',
      'var(--success)',
      'var(--info)',
      'var(--success)',
      'var(--destructive)',
    ])
    expect(colors.some((color) => color.includes(['--', 'chart-'].join('')))).toBe(false)
  })

  it('opens only the selected chart in fullscreen and closes it again', async () => {
    renderPage()
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('tab', { name: 'الرسوم البيانية' }))

    const fullscreenButtons = await screen.findAllByRole('button', {
      name: /تكبير الرسم البياني:/,
    })
    expect(fullscreenButtons).toHaveLength(3)

    fullscreenButtons[1].focus()
    fireEvent.click(fullscreenButtons[1])
    const dialog = screen.getByRole('dialog', { name: 'تكبير الرسم البياني' })
    expect(within(dialog).getByRole('heading', { name: 'كاش مقابل فيزا' })).toBeInTheDocument()
    expect(
      within(dialog).queryByRole('heading', { name: 'المغسلة مقابل الكافيه' }),
    ).not.toBeInTheDocument()
    expect(
      within(dialog).queryByRole('heading', { name: 'المبيعات مقابل المصروفات' }),
    ).not.toBeInTheDocument()
    // The period is a presentation value: it goes through the central date
    // formatter, not the raw ISO strings.
    expect(
      within(dialog).getByText(`الفترة: ${formatDate(weekAgo)} — ${formatDate(today)}`),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('img', { name: /كاش مقابل فيزا:/ })).toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: 'إجراءات تصدير الرسوم البيانية' }),
    ).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'إغلاق' }))
    expect(screen.queryByRole('dialog', { name: 'تكبير الرسم البياني' })).not.toBeInTheDocument()
    await waitFor(() => expect(fullscreenButtons[1]).toHaveFocus())
  })

  it('closes fullscreen with Escape', async () => {
    renderPage()
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('tab', { name: 'الرسوم البيانية' }))
    fireEvent.click((await screen.findAllByRole('button', { name: /تكبير الرسم البياني:/ }))[0])

    expect(screen.getByRole('dialog', { name: 'تكبير الرسم البياني' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'تكبير الرسم البياني' })).not.toBeInTheDocument()
  })

  it('shares the applied period with the product sales tab', async () => {
    renderPage()
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenCalledTimes(1))

    applyPeriod(weekAgo, firstDay, tenthDay)
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenLastCalledWith(firstDay, tenthDay))

    fireEvent.click(screen.getByRole('tab', { name: 'مبيعات الأصناف' }))

    await waitFor(() => expect(mocks.productSales).toHaveBeenCalledWith(firstDay, tenthDay))
  })

  it('shows the print status tab with human-readable document names only', async () => {
    mocks.printJobs.mockResolvedValue([
      {
        id: 12,
        doc_type: 'TAKEAWAY_INVOICE',
        status: 'FAILED',
        attempts: 2,
        error: 'printer error: printer.not_configured',
        created_at: '2026-09-25 14:30:00',
      },
    ])
    const { container } = renderPage()
    await waitFor(() => expect(mocks.salesByDay).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('tab', { name: 'حالة الطباعة' }))

    expect(await screen.findByText('إيصال طلب خارجي')).toBeInTheDocument()
    expect(screen.getByText('فشلت الطباعة')).toBeInTheDocument()
    expect(screen.getByText('لم يتم إعداد الطابعة بعد')).toBeInTheDocument()
    expect(container.textContent).not.toContain('TAKEAWAY_INVOICE')
    expect(container.textContent).not.toContain('printer.not_configured')
  })
})
