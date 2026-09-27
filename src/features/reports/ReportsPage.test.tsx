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
  analyticsCharts: vi.fn(),
  audit: vi.fn(),
  printJobs: vi.fn(),
  printConfig: vi.fn(),
  printTest: vi.fn(),
  closedShifts: vi.fn(),
  closedBusinessDays: vi.fn(),
  printPreviewShift: vi.fn(),
  printPreviewDay: vi.fn(),
  // The monthly comparison section: two CALENDAR charts that live on this tab
  // now, each with its own command and its own window.
  monthly: vi.fn(),
  expensesMonthly: vi.fn(),
  monthlySalesPeriod: vi.fn(),
}))

vi.mock('@/services/opsApi', () => ({
  opsApi: {
    analyticsCharts: mocks.analyticsCharts,
    audit: mocks.audit,
    printJobs: mocks.printJobs,
    printConfig: mocks.printConfig,
    printTest: mocks.printTest,
    closedShifts: mocks.closedShifts,
    closedBusinessDays: mocks.closedBusinessDays,
    expensesMonthly: mocks.expensesMonthly,
  },
}))

vi.mock('@/services/salesApi', () => ({
  salesApi: { monthly: mocks.monthly },
}))

// The window both monthly charts read is a SETTING, not a filter of this page.
vi.mock('@/services/posApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/posApi')>()),
  api: {
    printPreviewShift: mocks.printPreviewShift,
    printPreviewDay: mocks.printPreviewDay,
    printInvoice: vi.fn(),
    printShift: vi.fn(),
    printDay: vi.fn(),
    printPreviewOrder: vi.fn(),
    printPreviewInvoice: vi.fn(),
    printPreviewTicket: vi.fn(),
  },
  settingsApi: { monthlySalesPeriod: mocks.monthlySalesPeriod },
}))

const today = todayIso()
const weekAgo = addDays(today, -6)

/** The trailing calendar report the sales monthly chart would receive. */
const MONTHLY_SALES = {
  from: '2026-01-01',
  to: '2026-09-26',
  months: [
    {
      month: '2026-08',
      invoices_count: 2,
      total_sales: 20_000,
      cafe_sales: 12_000,
      wash_sales: 8_000,
    },
    {
      month: '2026-09',
      invoices_count: 2,
      total_sales: 25_000,
      cafe_sales: 15_000,
      wash_sales: 10_000,
    },
  ],
}

/** The trailing calendar report the expenses monthly chart would receive. */
const MONTHLY_EXPENSES = {
  from: '2026-01-01',
  to: '2026-03-31',
  report: {
    categories: [
      { code: 'SALARY', name_ar: 'رواتب', total: 30_000 },
      { code: 'SUPPLIES', name_ar: 'مشتريات', total: 10_000 },
    ],
    months: [
      { month: '2026-01', category: 'SALARY', category_name: 'رواتب', count: 1, amount: 10_000 },
      { month: '2026-02', category: 'SALARY', category_name: 'رواتب', count: 1, amount: 20_000 },
      {
        month: '2026-03',
        category: 'SUPPLIES',
        category_name: 'مشتريات',
        count: 1,
        amount: 10_000,
      },
    ],
  },
}

// The picker opens on the month of the applied `from`, so pick inside that month.
const viewMonth = parseIsoDate(weekAgo) ?? { year: 2026, month: 1, day: 1 }
const firstDay = isoDate(viewMonth.year, viewMonth.month, 1)
const tenthDay = isoDate(viewMonth.year, viewMonth.month, 10)

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
    mocks.closedShifts.mockReset().mockResolvedValue([])
    mocks.closedBusinessDays.mockReset().mockResolvedValue([])
    mocks.printPreviewShift.mockReset()
    mocks.printPreviewDay.mockReset()
    // Defaulted so the period-filter tests are not coupled to the monthly
    // charts' data; their own behaviour is asserted in the section below.
    mocks.monthly.mockReset().mockResolvedValue(MONTHLY_SALES)
    mocks.expensesMonthly.mockReset().mockResolvedValue(MONTHLY_EXPENSES)
    mocks.monthlySalesPeriod.mockReset().mockResolvedValue({ months: 12 })
  })

  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage(DEFAULT_LOCALE)
    })
  })

  it('renders the three charts from the persisted analytics report and the shared period control', async () => {
    renderPage()
    await waitFor(() => expect(mocks.audit).toHaveBeenCalled())

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

  // Regression: the closed-day list used to render and address rows with
  // `business_day_id` / `day_date` / `opened_at` that the backend nested under
  // `day`. The identifiers were therefore `undefined`, the preview command was
  // invoked with `day_id: undefined` and every historical closing failed with
  // the generic "unexpected error". The row must carry its own id, and the
  // preview must be requested with exactly that id.
  it('opens the historical day-closing preview with the row’s own business day id', async () => {
    mocks.closedBusinessDays.mockResolvedValue([
      {
        closing_id: 9,
        business_day_id: 42,
        day_date: '2026-09-20',
        status: 'CLOSED',
        opened_at: '2026-09-20 08:00:00Z',
        closed_at: '2026-09-20 23:30:00Z',
        closed_by: 1,
        shift_count: 2,
        totals: {
          invoices_count: 7,
          cafe_sales: 10_000,
          wash_sales: 20_000,
          subtotal: 30_000,
          discounts: 0,
          service_charges: 0,
          total_sales: 30_000,
          cash: 30_000,
          card: 0,
          credit: 0,
          expenses: 0,
        },
      },
    ])
    mocks.printPreviewDay.mockResolvedValue({
      doc_type: 'DAY_REPORT',
      paper_mm: 80,
      width_chars: 42,
      ops: [
        { kind: 'text', text: 'تقفيل يوم العمل', align: 'center', bold: true, width: 1, height: 1 },
      ],
    })

    renderPage()
    await waitFor(() => expect(mocks.audit).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('tab', { name: 'تقفيلات أيام العمل' }))

    // The row is keyed and identified by its own id — never by `undefined`.
    expect(await screen.findByText('#42')).toBeInTheDocument()
    // The business date is present (it used to be nested under `day` and never
    // reached the screen), and it is rendered through the shared date formatter.
    expect(screen.getAllByText(formatDate('2026-09-20')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'معاينة' }))

    await waitFor(() => expect(mocks.printPreviewDay).toHaveBeenCalledWith(42))
    expect(mocks.printPreviewDay).not.toHaveBeenCalledWith(undefined)
    expect(await screen.findAllByText('تقفيل يوم العمل')).not.toHaveLength(0)
  })

  it('opens the historical shift-closing preview with the row’s own shift id', async () => {
    mocks.closedShifts.mockResolvedValue([
      {
        id: 31,
        business_day_id: 42,
        user_id: 2,
        user_name: 'Cashier One',
        user_role: 'STAFF',
        status: 'CLOSED',
        opened_at: '2026-09-20 08:00:00Z',
        opening_cash: 1_000,
        closed_at: '2026-09-20 20:00:00Z',
        cash_sales: 30_000,
        card_sales: 0,
        credit_sales: 0,
        service_charges: 0,
        discounts: 0,
        invoices_count: 7,
        expected_cash: 31_000,
        actual_cash: 31_000,
        cash_difference: 0,
      },
    ])
    mocks.printPreviewShift.mockResolvedValue({
      doc_type: 'SHIFT_REPORT',
      paper_mm: 80,
      width_chars: 42,
      ops: [
        { kind: 'text', text: 'تقفيل وردية', align: 'center', bold: true, width: 1, height: 1 },
      ],
    })

    renderPage()
    await waitFor(() => expect(mocks.audit).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('tab', { name: 'تقفيلات الورديات' }))

    fireEvent.click(await screen.findByRole('button', { name: 'معاينة' }))
    await waitFor(() => expect(mocks.printPreviewShift).toHaveBeenCalledWith(31))
  })

  it('refreshes all three charts when the applied period changes', async () => {
    renderPage()
    await waitFor(() => expect(mocks.audit).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('tab', { name: 'الرسوم البيانية' }))
    await waitFor(() => expect(mocks.analyticsCharts).toHaveBeenCalledTimes(1))

    applyPeriod(weekAgo, firstDay, tenthDay)

    await waitFor(() => expect(mocks.analyticsCharts).toHaveBeenLastCalledWith(firstDay, tenthDay))
  })

  it('clears the charts period to empty strings like an emptied date field', async () => {
    renderPage()
    await waitFor(() => expect(mocks.audit).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('tab', { name: 'الرسوم البيانية' }))
    await waitFor(() => expect(mocks.analyticsCharts).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'مسح' }))

    await waitFor(() => expect(mocks.analyticsCharts).toHaveBeenLastCalledWith('', ''))
  })

  it('shows the report empty state when the backend reports no charts', async () => {
    mocks.analyticsCharts.mockResolvedValue({ charts: [] })
    renderPage()
    await waitFor(() => expect(mocks.audit).toHaveBeenCalled())

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
    await waitFor(() => expect(mocks.audit).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('tab', { name: 'الرسوم البيانية' }))

    // Each card keeps its identity and explains its own emptiness.
    await waitFor(() => expect(screen.getAllByText('لا توجد حركة في هذه الفترة')).toHaveLength(3))
    expect(screen.getByRole('heading', { name: 'كاش مقابل فيزا' })).toBeInTheDocument()
    expect(screen.getAllByText(/لم يُسجَّل أي مبلغ لهذا المؤشر/)).toHaveLength(3)
    // No chart pretends to hold data: nothing to expand or export. Scoped to the
    // analytics grid — the monthly section below states its own period.
    const grid = screen.getByTestId('analytics-charts-grid')
    expect(
      within(grid).queryByRole('button', { name: /تكبير الرسم البياني:/ }),
    ).not.toBeInTheDocument()
  })

  it('surfaces analytics report failures instead of fabricating values', async () => {
    mocks.analyticsCharts.mockRejectedValue(new Error('internal_error'))
    renderPage()
    await waitFor(() => expect(mocks.audit).toHaveBeenCalled())

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
    await waitFor(() => expect(mocks.audit).toHaveBeenCalled())

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
      { id: 'laundry', labelKey: 'laundry', value: 20_000, color: 'var(--chart-bar-primary)' },
      { id: 'cafe', labelKey: 'cafe', value: 10_000, color: 'var(--chart-bar-secondary)' },
    ])
    expect(mapped.flatMap((chart) => chart.categories.map((category) => category.value))).toEqual([
      20_000, 10_000, 4_000, 1_000, 6_000, 3_000,
    ])
  })

  it('paints every segment with a centralized chart bar role', () => {
    const colors = Object.values(CATEGORY_PRESENTATION).map((category) => category.color)

    // A donut segment is a data mark like a bar, so it is drawn through the same
    // centralized roles — and therefore through the same Dev Settings.
    expect(colors).toEqual([
      'var(--chart-bar-primary)',
      'var(--chart-bar-secondary)',
      'var(--chart-bar-quaternary)',
      'var(--chart-bar-secondary)',
      'var(--chart-bar-sales)',
      'var(--chart-bar-expenses)',
    ])
    // No segment may name a raw palette token again: that is what used to make a
    // chart unreachable from a single settings screen.
    expect(colors.every((color) => color.startsWith('var(--chart-bar-'))).toBe(true)
  })

  it('opens only the selected chart in fullscreen and closes it again', async () => {
    renderPage()
    await waitFor(() => expect(mocks.audit).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('tab', { name: 'الرسوم البيانية' }))

    // Scoped to the analytics grid: the monthly section below it brings its own
    // fullscreen affordances, and this assertion is about the three donuts.
    const grid = await screen.findByTestId('analytics-charts-grid')
    const fullscreenButtons = within(grid).queryAllByRole('button', {
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
    await waitFor(() => expect(mocks.audit).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('tab', { name: 'الرسوم البيانية' }))
    fireEvent.click((await screen.findAllByRole('button', { name: /تكبير الرسم البياني:/ }))[0])

    expect(screen.getByRole('dialog', { name: 'تكبير الرسم البياني' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'تكبير الرسم البياني' })).not.toBeInTheDocument()
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
    await waitFor(() => expect(mocks.audit).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('tab', { name: 'حالة الطباعة' }))

    expect(await screen.findByText('إيصال طلب خارجي')).toBeInTheDocument()
    expect(screen.getByText('فشلت الطباعة')).toBeInTheDocument()
    expect(screen.getByText('لم يتم إعداد الطابعة بعد')).toBeInTheDocument()
    expect(container.textContent).not.toContain('TAKEAWAY_INVOICE')
    expect(container.textContent).not.toContain('printer.not_configured')
  })
})

/**
 * The monthly comparison section — the two CALENDAR charts that moved here from
 * the Sales and Expenses pages. They are asserted here exactly as they were
 * asserted there: same commands, same Dev-Settings window, same states, and
 * still untouched by a date-range picker (this page's included).
 */
describe('ReportsPage monthly comparison section', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.analyticsCharts.mockReset().mockResolvedValue(chartsReport)
    mocks.audit.mockReset().mockResolvedValue([])
    mocks.closedShifts.mockReset().mockResolvedValue([])
    mocks.closedBusinessDays.mockReset().mockResolvedValue([])
    mocks.monthly.mockReset().mockResolvedValue(MONTHLY_SALES)
    mocks.expensesMonthly.mockReset().mockResolvedValue(MONTHLY_EXPENSES)
    mocks.monthlySalesPeriod.mockReset().mockResolvedValue({ months: 12 })
  })

  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage(DEFAULT_LOCALE)
    })
  })

  /** Opens the Charts tab, where the section lives. */
  async function openCharts() {
    renderPage()
    await waitFor(() => expect(mocks.audit).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('tab', { name: 'الرسوم البيانية' }))
    await waitFor(() => expect(mocks.analyticsCharts).toHaveBeenCalled())
  }

  it('renders both moved charts in their own section below the existing charts', async () => {
    await openCharts()

    expect(
      await screen.findByRole('heading', { name: 'المبيعات والمصروفات الشهرية' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'الإيرادات الشهرية: الكافيه مقابل المغسلة' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'المصروفات الشهرية حسب النوع' })).toBeInTheDocument()

    // The section comes AFTER the analytics charts, not beside them.
    const section = screen.getByTestId('monthly-comparison-section')
    const firstAnalytics = screen.getByRole('heading', { name: 'المغسلة مقابل الكافيه' })
    // eslint-disable-next-line no-bitwise
    expect(
      firstAnalytics.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    // Sales stays its own series, expenses stays its own categories.
    expect(screen.getAllByText('كافيه').length).toBeGreaterThan(0)
    expect(screen.getAllByText('مغسلة').length).toBeGreaterThan(0)
    expect(screen.getAllByText('رواتب').length).toBeGreaterThan(0)
  })

  it('takes both windows from the one Dev Settings period', async () => {
    await openCharts()

    await waitFor(() => expect(mocks.monthly).toHaveBeenCalledTimes(1))
    expect(mocks.expensesMonthly).toHaveBeenCalledTimes(1)
    // The same setting drives both charts — the only argument either read takes.
    expect(mocks.monthlySalesPeriod).toHaveBeenCalled()
    expect(mocks.monthly).toHaveBeenCalledWith(12)
    expect(mocks.expensesMonthly).toHaveBeenCalledWith(12)
  })

  it('respects a different configured window', async () => {
    mocks.monthlySalesPeriod.mockResolvedValue({ months: 6 })
    await openCharts()

    await waitFor(() => expect(mocks.monthly).toHaveBeenCalledWith(6))
    expect(mocks.expensesMonthly).toHaveBeenCalledWith(6)
  })

  it('falls back to the backend default when the setting cannot be read', async () => {
    mocks.monthlySalesPeriod.mockRejectedValue({ message: 'db.error' })
    await openCharts()

    // No argument at all: the backend applies its own stored default.
    await waitFor(() => expect(mocks.monthly).toHaveBeenCalledWith())
    expect(mocks.expensesMonthly).toHaveBeenCalledWith()
  })

  it('keeps the monthly charts out of the reports period filter', async () => {
    await openCharts()
    await waitFor(() => expect(mocks.analyticsCharts).toHaveBeenCalledTimes(1))

    applyPeriod(weekAgo, firstDay, tenthDay)

    await waitFor(() => expect(mocks.analyticsCharts).toHaveBeenLastCalledWith(firstDay, tenthDay))
    // The analytics report follows the picker; the calendar comparisons do not.
    expect(mocks.monthly).toHaveBeenCalledTimes(1)
    expect(mocks.expensesMonthly).toHaveBeenCalledTimes(1)
  })

  it('reads the expenses indicator from the TOTAL spend, not one category', async () => {
    await openCharts()

    // The month's TOTALS are 20,000 then 10,000 — a 50% FALL in total spend.
    // Reading any single category, or the leading one alone, would answer a
    // different question, so the badge reports the sum of every category.
    expect(await screen.findByText('-50.0%')).toBeInTheDocument()
    // Both monthly charts state the same reading; the label is shared, not unique.
    expect(screen.getAllByText('مقارنة بالشهر السابق')).toHaveLength(2)
  })

  it('shows a real empty state when the configured window holds no months', async () => {
    mocks.monthly.mockResolvedValue({ from: '2026-01-01', to: '2026-09-26', months: [] })
    await openCharts()

    expect(
      await screen.findByRole('heading', { name: 'لا توجد شهور لتحليلها بعد' }),
    ).toBeInTheDocument()
  })

  it('reports a monthly read failure with the shared error state', async () => {
    mocks.expensesMonthly.mockRejectedValue(new Error('internal_error'))
    await openCharts()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})
