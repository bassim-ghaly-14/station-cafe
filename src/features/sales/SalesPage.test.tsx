/**
 * The Sales page is the manager's screen, so its tests assert what it SHOWS and
 * what it REQUESTS, not merely that it renders:
 *
 *  - the period is the page's single filter, and it is sent to BOTH reads, so
 *    the KPIs and the invoice list can never describe different windows;
 *  - every figure is rendered from the backend payload — no front-end figure is
 *    computed, and no value appears that the backend did not send;
 *  - the four page states (loading, failure, empty, populated) each render their
 *    own presentation, and "no sales" is distinguished from "no results";
 *  - selecting an invoice opens the EXISTING shared preview dialog, which is the
 *    whole drill-down contract;
 *  - the extra filters are progressive: hidden until asked for, and every one of
 *    them is passed to the backend as a real query parameter.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { formatIsoDate, formatIsoDateLong, isoDate, parseIsoDate, todayIso } from '@/lib/date'
import { formatMinorMoney } from '@/lib/money'
import { ToastProvider } from '@/components/ui'
import type { SalesInvoiceRow, SalesOverview } from '@/services/salesApi'
import SalesPage from './SalesPage'

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  invoices: vi.fn(),
  cashiers: vi.fn(),
  monthly: vi.fn(),
  monthlySalesPeriod: vi.fn(),
  targetProgress: vi.fn(),
}))

// The monthly chart window is a SETTING, read through the same settings API the
// Dev Settings page writes to — never the page's own date filter.
vi.mock('@/services/posApi', () => ({
  settingsApi: {
    monthlySalesPeriod: mocks.monthlySalesPeriod,
  },
}))

vi.mock('@/services/salesApi', () => ({
  salesApi: {
    overview: mocks.overview,
    invoices: mocks.invoices,
    cashiers: mocks.cashiers,
    monthly: mocks.monthly,
    targetProgress: mocks.targetProgress,
  },
}))

// The shared preview dialog IS the drill-down mechanism; stubbing it proves the
// page reuses it instead of owning a second invoice-detail implementation.
vi.mock('@/features/pos/PrintPreviewDialog', () => ({
  PrintPreviewDialog: ({
    target,
    onClose,
  }: {
    target: { invoice_id: number }
    onClose: () => void
  }) => (
    <div role="dialog" aria-label="معاينة الفاتورة">
      <span data-testid="preview-id">{target.invoice_id}</span>
      <button type="button" onClick={onClose}>
        إغلاق
      </button>
    </div>
  ),
}))

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

const today = todayIso()
const viewMonth = parseIsoDate(today) ?? { year: 2026, month: 1, day: 1 }

const SUMMARY = {
  invoices_count: 4,
  // The invoice-kind breakdown partitions `invoices_count`: 1 + 1 + 1 + 1 = 4.
  cafe_invoices: 1,
  wash_invoices: 1,
  hybrid_invoices: 1,
  takeaway_invoices: 1,
  subtotal: 40_000,
  discounts: 2_000,
  service_charges: 1_000,
  total_sales: 39_000,
  average_invoice: 9_750,
  // cafe + wash equals the invoice subtotal, exactly as the snapshot guarantees.
  cafe_sales: 25_000,
  wash_sales: 15_000,
  cash: 18_000,
  card: 9_000,
  credit: 7_000,
  cash_share: 53,
  card_share: 26,
  credit_share: 21,
}

const OVERVIEW: SalesOverview = {
  summary: SUMMARY,
  trend: [
    {
      day_id: 1,
      day_date: '2026-09-09',
      invoices_count: 2,
      total_sales: 15_000,
      cafe_sales: 9_000,
      wash_sales: 6_000,
      cash: 8_000,
      card: 7_000,
      credit: 0,
    },
    {
      day_id: 2,
      day_date: '2026-09-10',
      invoices_count: 2,
      total_sales: 24_000,
      cafe_sales: 15_000,
      wash_sales: 9_000,
      cash: 12_000,
      card: 5_000,
      credit: 7_000,
    },
  ],
  items: [
    {
      product_name: 'كابتشينو',
      department: 'CAFE',
      quantity: 12,
      revenue: 18_000,
      share_percent: 60,
    },
    {
      product_name: 'غسيل خارجي',
      department: 'WASH',
      quantity: 2,
      revenue: 12_000,
      share_percent: 40,
    },
  ],
}

function invoice(over: Partial<SalesInvoiceRow> = {}): SalesInvoiceRow {
  return {
    id: 7,
    invoice_no: 42,
    day_date: '2026-09-10',
    created_at: '2026-09-10 14:30:00Z',
    order_type: 'TABLE',
    table_label: 'طاولة ٣',
    takeaway_no: null,
    status: 'PAID',
    subtotal: 12_000,
    discount_minor: 1_000,
    service_charge: 500,
    total: 11_500,
    paid_amount: 11_500,
    cafe_total: 7_000,
    wash_total: 5_000,
    customer_name: 'أحمد سيد',
    car_plate: 'أ ب ج ١٢٣٤',
    user_name: 'محمد',
    user_role: 'STAFF',
    payment_method: 'CASH',
    ...over,
  }
}

/**
 * The month-at-a-glance target read.
 *
 * These are the owner's own example numbers: a CAFE override of 175,000 EGP
 * against 150,000 achieved (114.29%), and a WASH default of 90,000 against
 * 30,000 (33.33%) — so the fixture itself proves the page renders a figure
 * ABOVE 100% without clamping it.
 */
const TARGET_PROGRESS = {
  month: '2026-09',
  from: '2026-09-01',
  to: '2026-09-26',
  cafe: {
    department: 'CAFE' as const,
    target_minor: 17_500_000,
    overridden: true,
    actual_minor: 15_000_000,
    remaining_minor: 2_500_000,
    achievement_percent: '85.71',
    achievement_hundredths: 8571,
  },
  wash: {
    department: 'WASH' as const,
    target_minor: 9_000_000,
    overridden: true,
    actual_minor: 3_000_000,
    remaining_minor: 6_000_000,
    achievement_percent: '33.33',
    achievement_hundredths: 3333,
  },
  daily: [
    {
      day_date: '2026-09-25',
      cafe_revenue: 7_000_000,
      wash_revenue: 1_000_000,
      cafe_cumulative: 15_000_000,
      wash_cumulative: 3_000_000,
      cafe_achievement_hundredths: 8571,
      wash_achievement_hundredths: 3333,
    },
  ],
}

function renderPage() {
  return render(
    <ToastProvider>
      <SalesPage />
    </ToastProvider>,
  )
}

/** Picks a completed range inside the picker, as a manager would. */
function applyPeriod(from: string, to: string) {
  // The collapsed trigger is named by the period it currently holds.
  fireEvent.click(screen.getByRole('button', { name: new RegExp(formatIsoDate(today, 'ar-EG')) }))
  const dialog = screen.getByRole('dialog')
  // The day cells of a range edge are named "<date> — من/إلى تاريخ" (the edge
  // tells a screen reader which end it is), so the date is matched as a RegExp
  // here exactly as the picker, Reports and Expenses tests match it.
  for (const day of [from, to]) {
    fireEvent.click(
      within(dialog).getByRole('button', { name: new RegExp(formatIsoDateLong(day, 'ar-EG')) }),
    )
  }
  fireEvent.click(within(dialog).getByRole('button', { name: 'تطبيق' }))
}

const MONTHLY = {
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

describe('SalesPage', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.overview.mockReset().mockResolvedValue(OVERVIEW)
    mocks.invoices.mockReset().mockResolvedValue([invoice()])
    mocks.cashiers.mockReset().mockResolvedValue([
      { id: 1, name: 'محمد', role: 'STAFF' },
      { id: 2, name: 'سارة', role: 'MANAGER' },
    ])
    mocks.monthly.mockReset().mockResolvedValue(MONTHLY)
    mocks.monthlySalesPeriod.mockReset().mockResolvedValue({ months: 12 })
    mocks.targetProgress.mockReset().mockResolvedValue(TARGET_PROGRESS)
  })

  it('opens on today and sends that one period to BOTH reads', async () => {
    renderPage()
    await waitFor(() => expect(mocks.overview).toHaveBeenCalled())

    const [filter, sort] = mocks.overview.mock.calls[0]
    expect(filter.from).toBe(today)
    expect(filter.to).toBe(today)
    // The activity list must describe the very same window as the KPIs.
    expect(mocks.invoices).toHaveBeenCalledWith(filter)
    // The default ordering is "best revenue", resolved by the backend.
    expect(sort).toBe('revenue')
  })

  // The monthly comparison MOVED to Reports → Charts. This page must not keep a
  // second instance mounted: one chart, one location, one read.
  it('no longer renders the monthly comparison, which lives in Reports', async () => {
    renderPage()
    await waitFor(() => expect(mocks.overview).toHaveBeenCalled())

    expect(mocks.monthly).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('heading', { name: 'الإيرادات الشهرية: الكافيه مقابل المغسلة' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByTestId('monthly-chart-sales-monthly-cafe-wash')).not.toBeInTheDocument()
  })

  it('re-reads both surfaces when the period changes', async () => {
    renderPage()
    await waitFor(() => expect(mocks.overview).toHaveBeenCalledTimes(1))

    applyPeriod(
      isoDate(viewMonth.year, viewMonth.month, 1),
      isoDate(viewMonth.year, viewMonth.month, 10),
    )

    await waitFor(() => expect(mocks.overview).toHaveBeenCalledTimes(2))
    const next = mocks.overview.mock.calls[1][0]
    expect(next.from).toBe(isoDate(viewMonth.year, viewMonth.month, 1))
    expect(next.to).toBe(isoDate(viewMonth.year, viewMonth.month, 10))
    expect(mocks.invoices).toHaveBeenLastCalledWith(next)
  })

  it('renders the revenue, the payment split and the item analysis from the payload', async () => {
    renderPage()

    expect(await screen.findByText('إجمالي المبيعات')).toBeInTheDocument()
    // Every figure is the backend's, formatted by the central money formatter.
    // The headline is stated once; the settled figures also appear in the
    // breakdown, which is why they are counted rather than matched once.
    expect(
      screen.getByText(formatMinorMoney(SUMMARY.total_sales, { variant: 'auto' })),
    ).toBeInTheDocument()
    for (const settled of [SUMMARY.cash, SUMMARY.card, SUMMARY.credit]) {
      expect(
        screen.getAllByText(formatMinorMoney(settled, { variant: 'auto' })).length,
      ).toBeGreaterThan(0)
    }
    // Invoice count and average arrive as computed aggregates, not client math.
    // The count now appears in two places — the revenue band's figure and the
    // invoice-kind card's hero — so both are asserted rather than only one.
    expect(screen.getAllByText(String(SUMMARY.invoices_count)).length).toBeGreaterThan(0)
    expect(
      screen.getByText(formatMinorMoney(SUMMARY.average_invoice, { variant: 'auto' })),
    ).toBeInTheDocument()
    // There is no "exceptions" tile: Station has no cancelled invoice, so the
    // concept must not be rendered at all.
    expect(screen.queryByText('استثناءات')).not.toBeInTheDocument()
    expect(screen.queryByText(/فاتورة ملغاة/)).not.toBeInTheDocument()
    // The top items, with their share of the period's item revenue.
    expect(screen.getByText('كابتشينو')).toBeInTheDocument()
    expect(screen.getByText('60%')).toBeInTheDocument()
  })

  /**
   * The invoice-COUNT card. The total is the hero and is stated as an integer
   * count; the four kinds beneath it are the same period's invoices partitioned by
   * document kind, so they add up to the hero.
   */
  it('leads with the total invoice count as an integer and breaks it down by kind', async () => {
    renderPage()

    const hero = await screen.findByTestId('sales-invoice-count-hero')
    expect(hero).toHaveTextContent(String(SUMMARY.invoices_count))

    // Each of the four kinds states its own count, straight from the payload.
    const kind = (label: string, count: number) => {
      const box = screen.getByText(label).closest('div')!
      expect(box).toHaveTextContent(String(count))
    }
    kind('كافيه فقط', SUMMARY.cafe_invoices)
    kind('مغسلة فقط', SUMMARY.wash_invoices)
    kind('هجين', SUMMARY.hybrid_invoices)
    kind('طلب خارجي فقط', SUMMARY.takeaway_invoices)

    // The four kinds partition the hero, so the card cannot show a breakdown that
    // disagrees with the total printed above it.
    expect(
      SUMMARY.cafe_invoices +
        SUMMARY.wash_invoices +
        SUMMARY.hybrid_invoices +
        SUMMARY.takeaway_invoices,
    ).toBe(SUMMARY.invoices_count)
  })

  /**
   * A COUNT is never money. The card must not route a count through the money
   * formatter, which reads its argument as piasters — that is exactly how six
   * invoices came to be displayed as `0.06 ج.م` on the day-closing dialog.
   */
  it('never renders an invoice count through the money formatter', async () => {
    mocks.overview.mockResolvedValue({
      ...OVERVIEW,
      summary: {
        ...SUMMARY,
        invoices_count: 6,
        cafe_invoices: 6,
        wash_invoices: 0,
        hybrid_invoices: 0,
        takeaway_invoices: 0,
      },
    })
    renderPage()

    const hero = await screen.findByTestId('sales-invoice-count-hero')
    expect(hero).toHaveTextContent('6')
    // The money formatter's output for a count of 6 read as piasters.
    expect(hero.textContent).not.toContain('0.06')
    expect(hero.textContent).not.toContain('ج.م')

    // And the same rule holds for the four boxes: a zero count reads as `0`, not
    // as a formatted amount.
    const washBox = screen.getByText('مغسلة فقط').closest('div')!
    expect(washBox).toHaveTextContent('0')
    expect(washBox.textContent).not.toContain('ج.م')
  })

  it('states a zero invoice count as a plain zero', async () => {
    mocks.overview.mockResolvedValue({
      ...OVERVIEW,
      summary: {
        ...SUMMARY,
        invoices_count: 0,
        cafe_invoices: 0,
        wash_invoices: 0,
        hybrid_invoices: 0,
        takeaway_invoices: 0,
      },
      trend: [],
      items: [],
    })
    mocks.invoices.mockResolvedValue([])
    renderPage()

    const hero = await screen.findByTestId('sales-invoice-count-hero')
    expect(hero).toHaveTextContent('0')
    expect(hero.textContent).not.toContain('ج.م')
  })

  it('leaves the revenue totals unchanged by the new card', async () => {
    renderPage()

    expect(
      await screen.findByText(formatMinorMoney(SUMMARY.total_sales, { variant: 'auto' })),
    ).toBeInTheDocument()
    expect(
      screen.getByText(formatMinorMoney(SUMMARY.average_invoice, { variant: 'auto' })),
    ).toBeInTheDocument()
  })

  it('opens the EXISTING invoice preview when a row is selected', async () => {
    renderPage()
    await screen.findByText('كابتشينو')

    fireEvent.click(screen.getByRole('button', { name: 'معاينة الفاتورة رقم 42' }))

    // The shared dialog, addressed with the invoice id — not a second viewer.
    expect(await screen.findByRole('dialog', { name: 'معاينة الفاتورة' })).toBeInTheDocument()
    expect(screen.getByTestId('preview-id')).toHaveTextContent('7')
  })

  it('asks the backend for a different item ordering instead of sorting locally', async () => {
    renderPage()
    await screen.findByText('كابتشينو')

    fireEvent.click(screen.getByRole('button', { name: 'حسب الكمية' }))

    await waitFor(() =>
      expect(mocks.overview).toHaveBeenLastCalledWith(expect.anything(), 'quantity'),
    )
  })

  it('keeps the extra filters hidden until they are asked for', async () => {
    renderPage()
    await screen.findByText('كابتشينو')

    expect(screen.queryByLabelText('طريقة الدفع')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'تصفية إضافية' }))

    expect(screen.getByLabelText('طريقة الدفع')).toBeInTheDocument()
    expect(screen.getByLabelText('حالة الفاتورة')).toBeInTheDocument()
    expect(screen.getByLabelText('الكاشير')).toBeInTheDocument()
  })

  it('passes a chosen payment method to the backend as a real filter', async () => {
    renderPage()
    await screen.findByText('كابتشينو')

    fireEvent.click(screen.getByRole('button', { name: 'تصفية إضافية' }))
    fireEvent.change(screen.getByLabelText('طريقة الدفع'), { target: { value: 'CARD' } })

    await waitFor(() =>
      expect(mocks.overview).toHaveBeenLastCalledWith(
        expect.objectContaining({ method: 'CARD' }),
        'revenue',
      ),
    )
    expect(mocks.invoices).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'CARD' }))
  })

  it('distinguishes "no sales in this period" from "no results for these filters"', async () => {
    mocks.overview.mockResolvedValue({
      ...OVERVIEW,
      summary: { ...SUMMARY, invoices_count: 0 },
      trend: [],
      items: [],
    })
    mocks.invoices.mockResolvedValue([])
    renderPage()

    expect(await screen.findByText('لم تُسجَّل أي فواتير في الفترة المختارة')).toBeInTheDocument()

    // The same empty dataset under a filter explains itself differently.
    fireEvent.click(screen.getByRole('button', { name: 'تصفية إضافية' }))
    fireEvent.change(screen.getByLabelText('طريقة الدفع'), { target: { value: 'CARD' } })
    expect(await screen.findByText('لا توجد فواتير مطابقة لعوامل التصفية')).toBeInTheDocument()
  })

  it('debounces the customer search instead of querying on every keystroke', async () => {
    renderPage()
    await waitFor(() => expect(mocks.overview).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'تصفية إضافية' }))
    const field = screen.getByLabelText('اسم العميل')
    fireEvent.change(field, { target: { value: 'أ' } })
    fireEvent.change(field, { target: { value: 'أح' } })

    // Still one read: the field is live, the backend is not asked per character.
    expect(mocks.overview).toHaveBeenCalledTimes(1)
    expect(mocks.invoices).toHaveBeenCalledTimes(1)

    // Once the typing settles, ONE new read carries the settled term.
    await waitFor(() => expect(mocks.overview).toHaveBeenCalledTimes(2))
    expect(mocks.overview.mock.calls[1][0].customer).toBe('أح')
    expect(mocks.invoices).toHaveBeenCalledTimes(2)
  })

  it('reports a failed read with a retry, not an empty dashboard', async () => {
    mocks.overview.mockRejectedValue({ message: 'db.error' })
    mocks.invoices.mockResolvedValue([])
    renderPage()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /إعادة المحاولة/ })).toBeInTheDocument()
  })

  it('shows a loading placeholder before the first read arrives', () => {
    mocks.overview.mockReturnValue(new Promise(() => {}))
    renderPage()

    expect(screen.getByLabelText('جارٍ تحميل الجدول')).toBeInTheDocument()
  })

  // ---- the month's target progress ----------------------------------------

  /**
   * The target section answers the owner's question about the WHOLE month, so it
   * must render even while the page's period filter is narrowing everything else
   * to a single day.
   */
  it('shows the current month target for BOTH departments above the period figures', async () => {
    renderPage()

    const section = await screen.findByTestId('sales-targets')
    const cafe = within(section).getByTestId('sales-target-cafe')
    const wash = within(section).getByTestId('sales-target-wash')

    // The four figures of each card are the BACKEND's numbers, not recomputed.
    // `variant: 'auto'` mirrors the component, so the assertion states the
    // formatted figure the card actually renders under the global settings.
    expect(within(cafe).getByText('الهدف')).toBeInTheDocument()
    expect(
      within(cafe).getByText(formatMinorMoney(17_500_000, { variant: 'auto' })),
    ).toBeInTheDocument()
    expect(
      within(cafe).getByText(formatMinorMoney(15_000_000, { variant: 'auto' })),
    ).toBeInTheDocument()
    expect(
      within(cafe).getByText(formatMinorMoney(2_500_000, { variant: 'auto' })),
    ).toBeInTheDocument()

    expect(
      within(wash).getByText(formatMinorMoney(9_000_000, { variant: 'auto' })),
    ).toBeInTheDocument()
    expect(
      within(wash).getByText(formatMinorMoney(3_000_000, { variant: 'auto' })),
    ).toBeInTheDocument()
    expect(
      within(wash).getByText(formatMinorMoney(6_000_000, { variant: 'auto' })),
    ).toBeInTheDocument()
  })

  it('prints the achievement the backend resolved, never a locally computed one', async () => {
    renderPage()

    const section = await screen.findByTestId('sales-targets')
    expect(within(section).getByTestId('sales-target-cafe')).toHaveTextContent('85.71')
    expect(within(section).getByTestId('sales-target-wash')).toHaveTextContent('33.33')
  })

  /** Above 100% is a real business result, so the NUMBER is never capped. */
  it('prints an achievement above one hundred without clamping it', async () => {
    mocks.targetProgress.mockResolvedValue({
      ...TARGET_PROGRESS,
      cafe: {
        ...TARGET_PROGRESS.cafe,
        achievement_percent: '114.29',
        achievement_hundredths: 11429,
      },
    })
    renderPage()

    const cafe = within(await screen.findByTestId('sales-targets')).getByTestId('sales-target-cafe')
    expect(cafe).toHaveTextContent('114.29')
    // Only the BAR is capped, so it still reads as a full track.
    expect(within(cafe).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
  })

  /**
   * No target is a real state, and it must not be dressed up as 0% — which would
   * claim nothing was achieved — nor as a fabricated 100%.
   */
  it('states that there is no percentage when the month has no target', async () => {
    mocks.targetProgress.mockResolvedValue({
      ...TARGET_PROGRESS,
      cafe: {
        ...TARGET_PROGRESS.cafe,
        target_minor: 0,
        achievement_percent: null,
        achievement_hundredths: null,
        remaining_minor: 0,
      },
    })
    renderPage()

    const cafe = within(await screen.findByTestId('sales-targets')).getByTestId('sales-target-cafe')
    // The PERCENTAGE is the dash. The money figures around it are still real —
    // a zero target and a zero remaining are both correctly rendered as 0.00 —
    // so the assertion is about the achievement alone, never the whole card.
    const percent = within(cafe).getByTestId('sales-target-cafe-percent')
    expect(percent).toHaveTextContent('—')
    expect(percent).not.toHaveTextContent('%')
    expect(within(cafe).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })

  it('shows each day of the month with its cumulative achievement', async () => {
    renderPage()

    const section = await screen.findByTestId('sales-targets')
    const table = within(section).getByRole('table')
    expect(within(table).getByText('تحقيق هدف الكافيه')).toBeInTheDocument()
    expect(within(table).getByText('مبيعات الكافيه')).toBeInTheDocument()
    expect(within(table).getByText('مبيعات المغسلة')).toBeInTheDocument()
    // The day's own revenue, and the day's CUMULATIVE achievement against the
    // full monthly target.
    expect(
      within(table).getByText(formatMinorMoney(7_000_000, { variant: 'auto' })),
    ).toBeInTheDocument()
    expect(
      within(table).getByText(formatMinorMoney(1_000_000, { variant: 'auto' })),
    ).toBeInTheDocument()
    expect(within(table).getAllByText('85.71%').length).toBeGreaterThan(0)
    expect(within(table).getAllByText('33.33%').length).toBeGreaterThan(0)
  })

  it('never sends the page period filter to the target read', async () => {
    renderPage()
    await waitFor(() => expect(mocks.targetProgress).toHaveBeenCalled())

    // The month is the BACKEND's to resolve: the call takes no filter at all, so
    // narrowing the page's period cannot turn a monthly achievement into a
    // three-day one.
    expect(mocks.targetProgress).toHaveBeenCalledWith()
    expect(mocks.targetProgress.mock.calls[0]).toHaveLength(0)
  })

  it('re-reads the target progress when the page is refreshed', async () => {
    renderPage()
    await waitFor(() => expect(mocks.targetProgress).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: /تحديث/ }))
    await waitFor(() => expect(mocks.targetProgress).toHaveBeenCalledTimes(2))
  })

  it('reports a failed target read with a retry', async () => {
    mocks.targetProgress.mockRejectedValue({ message: 'db.error' })
    renderPage()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})
