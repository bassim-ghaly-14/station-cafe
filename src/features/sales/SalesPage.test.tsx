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
  for (const day of [from, to]) {
    fireEvent.click(within(dialog).getByRole('button', { name: formatIsoDateLong(day, 'ar-EG') }))
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
    expect(screen.getByText(String(SUMMARY.invoices_count))).toBeInTheDocument()
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
})
