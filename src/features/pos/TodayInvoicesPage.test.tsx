/**
 * Today's Invoices as a PAGE, and the service-charge flow in Checkout.
 *
 * These assert the contracts the upgrade had to hold:
 *  - invoices are a routed page, not a dialog, and they own no business logic
 *    (the same search/preview/print commands, no second data source);
 *  - the page has real loading / empty / error states and a way back;
 *  - a service charge is an invoice-level charge the CASHIER applies directly,
 *    from the configured amounts, with no password anywhere in the flow.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import '@/lib/i18n'
import { RouterProvider } from '@/app/router'
import type { InvoiceRow } from '@/services/posApi'

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  invoices: vi.fn(),
  printPreviewInvoice: vi.fn(),
  printInvoice: vi.fn(),
  serviceCharge: vi.fn(),
}))

vi.mock('@/services/shiftApi', () => ({
  shiftApi: { state: mocks.state },
}))

vi.mock('@/services/posApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/posApi')>()),
  api: {
    invoices: mocks.invoices,
    printPreviewInvoice: mocks.printPreviewInvoice,
    printInvoice: mocks.printInvoice,
    preview: vi.fn(),
    // The order panel's own read-only calls.
    products: vi.fn().mockResolvedValue([]),
    orderCustomer: vi.fn().mockResolvedValue(null),
    getOrder: vi.fn(),
    addLine: vi.fn(),
    setQty: vi.fn(),
    removeLine: vi.fn(),
    ticket: vi.fn(),
    detachCustomer: vi.fn().mockResolvedValue(undefined),
    setDiscount: vi.fn(),
  },
  settingsApi: {
    serviceCharge: mocks.serviceCharge,
    discountOptions: vi.fn().mockResolvedValue({ amounts: [2000, 5000] }),
  },
}))

import { TodayInvoicesPage } from './TodayInvoicesPage'
import { OrderPanel } from './OrderPanel'
import { SessionProvider } from '@/features/auth/useSession'
import type { OrderPreview, PosOrder } from '@/services/posApi'

function invoice(over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: 1,
    invoice_no: 7,
    table_label: 'طاولة 01',
    order_type: 'TABLE',
    takeaway_no: null,
    status: 'PAID',
    total: 24000,
    paid_amount: 24000,
    service_charge: 0,
    discount_minor: 0,
    subtotal: 24000,
    cafe_total: 7000,
    wash_total: 17000,
    customer_name: 'أحمد',
    customer_phone: null,
    car_plate: 'ABC123',
    car_model: null,
    created_at: '2026-09-25 14:30:00Z',
    shift_id: 1,
    business_day_id: 1,
    ...over,
  }
}

function renderPage() {
  return render(
    <ToastProvider>
      <RouterProvider>
        <TodayInvoicesPage />
      </RouterProvider>
    </ToastProvider>,
  )
}

describe('Today invoices page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.mockResolvedValue({ day: { id: 1 }, my_shift: { id: 1 } })
    mocks.invoices.mockResolvedValue([invoice()])
  })

  it('is a page with a header, not a dialog', async () => {
    renderPage()

    expect(
      await screen.findByRole('heading', { name: 'فواتير اليوم', level: 1 }),
    ).toBeInTheDocument()
    // The dialog-based screen is gone: nothing is trapped in a modal.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // A contextual summary of the listed day, once it has resolved.
    expect(await screen.findByText(/1 فاتورة في يوم العمل الحالي/)).toBeInTheDocument()
    expect(screen.getByText('إجمالي مبيعات الفواتير')).toBeInTheDocument()
    // And a way back to the POS.
    expect(screen.getByRole('button', { name: 'العودة لنقطة البيع' })).toBeInTheDocument()
  })

  it('searches LIVE as the user types, with no search button at all', async () => {
    renderPage()
    await screen.findByText('#7')

    // The redundant submit control is gone for good: the field filters itself.
    expect(screen.queryByRole('button', { name: 'بحث' })).not.toBeInTheDocument()

    const callsBefore = mocks.invoices.mock.calls.length
    fireEvent.change(screen.getByRole('searchbox', { name: 'البحث في الفواتير' }), {
      target: { value: '1024' },
    })

    // No button press, no Enter — the debounced query reaches the same command.
    await waitFor(() => expect(mocks.invoices.mock.calls.length).toBeGreaterThan(callsBefore))
    await waitFor(() =>
      expect(mocks.invoices).toHaveBeenLastCalledWith(expect.objectContaining({ query: '1024' })),
    )
  })

  it('clears the search from the field itself', async () => {
    renderPage()
    await screen.findByText('#7')

    const field = screen.getByRole('searchbox', { name: 'البحث في الفواتير' })
    fireEvent.change(field, { target: { value: '1024' } })
    fireEvent.click(await screen.findByRole('button', { name: 'مسح البحث' }))

    expect(field).toHaveValue('')
    // Clearing the text alone restores the unfiltered query.
    await waitFor(() =>
      expect(mocks.invoices).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: undefined }),
      ),
    )
  })

  it('distinguishes "no invoices" from "no results for this search"', async () => {
    mocks.invoices.mockResolvedValueOnce([invoice()])
    renderPage()
    await screen.findByText('#7')

    // The day HAS invoices, but the search hides them: a different message, and
    // the fix is offered directly.
    mocks.invoices.mockResolvedValue([])
    fireEvent.change(screen.getByRole('searchbox', { name: 'البحث في الفواتير' }), {
      target: { value: 'لا-يوجد' },
    })

    expect(await screen.findByText('لا توجد فواتير مطابقة')).toBeInTheDocument()
    // Both the toolbar and the state offer the reset; the state's is the
    // offered fix (the toolbar's comes first in the DOM).
    const resetButtons = screen.getAllByRole('button', { name: /مسح التصفية/ })
    fireEvent.click(resetButtons[resetButtons.length - 1])
    await waitFor(() => expect(screen.queryByText('لا توجد فواتير مطابقة')).not.toBeInTheDocument())
  })

  it('renders stacked records on a phone instead of a squeezed table', async () => {
    // matchMedia is the single source of the layout decision, so a narrow
    // viewport is simulated the way a browser would report it.
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      renderPage()
      expect(await screen.findByText('#7')).toBeInTheDocument()
      // No table semantics on a phone, but every operational value and both
      // actions are still present.
      expect(screen.queryByRole('table')).not.toBeInTheDocument()
      expect(screen.getByText('أحمد')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /معاينة الطباعة — #7/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'طباعة — #7' })).toBeInTheDocument()
    } finally {
      window.matchMedia = original
    }
  })

  it('lists invoices with their status and reuses the same search command', async () => {
    renderPage()

    expect(await screen.findByText('#7')).toBeInTheDocument()
    // The status filter option and the row badge share the word, so scope it.
    expect(screen.getAllByText('مدفوعة').length).toBeGreaterThan(0)

    // No duplicated fetching: the page calls the POS command with the day id.
    await waitFor(() =>
      expect(mocks.invoices).toHaveBeenCalledWith(expect.objectContaining({ business_day_id: 1 })),
    )
  })

  it('opens the SHARED print preview dialog for an invoice', async () => {
    mocks.printPreviewInvoice.mockResolvedValue({
      doc_type: 'HYBRID_INVOICE',
      paper_mm: 80,
      width_chars: 42,
      ops: [
        {
          kind: 'text',
          text: 'إجمالي الكافيه الفرعي',
          align: 'right',
          bold: false,
          width: 1,
          height: 1,
        },
      ],
    })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /معاينة الطباعة — #7/ }))

    // Same dialog component as every other preview entry point.
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(mocks.printPreviewInvoice).toHaveBeenCalledWith(1)
    // ... and a hybrid invoice separates its department subtotals here too.
    expect(await screen.findByText('إجمالي الكافيه الفرعي')).toBeInTheDocument()
  })

  it('reprints through the existing print command', async () => {
    mocks.printInvoice.mockResolvedValue({ duplicate_suppressed: false })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'طباعة — #7' }))

    await waitFor(() => expect(mocks.printInvoice).toHaveBeenCalledWith(1))
    expect(await screen.findByText('تم إرسال الطباعة')).toBeInTheDocument()
  })

  it('shows an empty state when the day has no invoices', async () => {
    mocks.invoices.mockResolvedValue([])
    renderPage()

    expect(await screen.findByText('لا توجد فواتير بعد')).toBeInTheDocument()
  })

  it('surfaces a load failure with a retry', async () => {
    mocks.invoices.mockRejectedValueOnce({ message: 'pos.no_business_day' })
    renderPage()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    mocks.invoices.mockResolvedValue([invoice()])
    fireEvent.click(screen.getByRole('button', { name: /إعادة المحاولة/ }))
    expect(await screen.findByText('#7')).toBeInTheDocument()
  })
})

function order(over: Partial<PosOrder> = {}): PosOrder {
  return {
    id: 9,
    order_type: 'TABLE',
    table_id: 1,
    user_id: 1,
    status: 'OPEN',
    customer_id: null,
    discount_mode: null,
    discount_value: null,
    opened_at: '2026-09-25 10:00:00Z',
    waiting_no: null,
    takeaway_no: null,
    shift_id: 1,
    table_label: 'طاولة 01',
    lines: [
      {
        id: 100,
        order_id: 9,
        product_id: 1,
        department: 'CAFE',
        product_name: 'قهوة',
        unit_price: 3000,
        quantity: 2,
        discount_minor: 0,
        line_total: 6000,
      },
    ],
    ...over,
  }
}

function previewOf(total: number, serviceCharge = 0): OrderPreview {
  return {
    subtotal: total,
    discount_mode: null,
    discount_value: null,
    discount_minor: 0,
    service_charge_minor: serviceCharge,
    total,
    has_wash: false,
  }
}

describe('service charge in checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The starter amounts seeded by migration 21, in minor units.
    mocks.serviceCharge.mockResolvedValue({ amounts: [1000, 3000, 5000, 7000, 10000] })
  })

  function renderPanel(
    shown: OrderPreview,
    onServiceCharge = vi.fn(),
    options: number[] = [1000, 3000, 5000, 7000, 10000],
  ) {
    return render(
      <ToastProvider>
        <SessionProvider>
          <OrderPanel
            order={order()}
            preview={shown}
            discount={{ mode: null, value: null }}
            serviceCharge={shown.service_charge_minor}
            serviceChargeOptions={options}
            onServiceChargeChange={onServiceCharge}
            onDiscountChange={vi.fn()}
            onChange={vi.fn()}
            onRefreshTables={vi.fn()}
            onPay={vi.fn()}
          />
        </SessionProvider>
      </ToastProvider>,
    )
  }

  it('offers the CONFIGURED amounts to a cashier, with no password', async () => {
    const onServiceCharge = vi.fn()
    renderPanel(previewOf(6000), onServiceCharge)

    // The starter options are selectable directly — no authorization dialog.
    const option = await screen.findByRole('button', { name: /إضافة خدمة 10.00/ })
    expect(screen.queryByText(/كلمة مرور تفويض/)).not.toBeInTheDocument()
    fireEvent.click(option)
    expect(onServiceCharge).toHaveBeenCalledWith(1000)
  })

  it('states whether the charge is not applied or applied', async () => {
    const { unmount } = renderPanel(previewOf(6000))
    expect(await screen.findByText(/بدون رسوم خدمة/)).toBeInTheDocument()
    unmount()

    renderPanel(previewOf(7000, 1000))
    expect(await screen.findByText(/تم تطبيق 10.00/)).toBeInTheDocument()
  })

  it('is an invoice-level charge in the summary, not a product line', async () => {
    renderPanel(previewOf(7000, 1000))

    const summary = screen.getByLabelText('ملخص الدفع')
    expect(within(summary).getAllByText('الخدمة').length).toBeGreaterThan(0)
    // 60.00 subtotal + 10.00 service = 70.00 total, on the total row.
    expect(within(summary).getAllByText(/70.00/).length).toBeGreaterThan(0)
  })

  it('hides the whole control when no amounts are configured', async () => {
    renderPanel(previewOf(6000), vi.fn(), [])
    expect(screen.queryByRole('button', { name: /إضافة خدمة/ })).not.toBeInTheDocument()
  })
})
