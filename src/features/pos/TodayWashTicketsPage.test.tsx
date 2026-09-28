/**
 * تذاكر المغسلة اليوم as a PAGE, and the cashier's cancellation rule.
 *
 * These assert the contracts the feature had to hold:
 *  - the daily wash tickets are a routed page beside فواتير اليوم, reading their
 *    own command and owning no business logic;
 *  - a ticket with a related receipt exposes it and opens the EXISTING invoice
 *    preview by the persisted id — no second invoice-detail implementation;
 *  - a ticket with no receipt yet is still a first-class row, never dropped;
 *  - an empty day is a valid empty state, not an error;
 *  - the cashier is offered no cancellation once a wash ticket is issued, and
 *    is told why instead of being shown a dead or misleading action.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import '@/lib/i18n'
import { RouterProvider } from '@/app/router'
import type { WashTicketRow } from '@/services/posApi'

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  washTickets: vi.fn(),
  printPreviewInvoice: vi.fn(),
  printPreviewTicket: vi.fn(),
}))

vi.mock('@/services/shiftApi', () => ({
  shiftApi: { state: mocks.state },
}))

vi.mock('@/services/posApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/posApi')>()),
  api: {
    washTickets: mocks.washTickets,
    printPreviewInvoice: mocks.printPreviewInvoice,
    printPreviewTicket: mocks.printPreviewTicket,
    preview: vi.fn(),
    products: vi.fn().mockResolvedValue([]),
    orderCustomer: vi.fn().mockResolvedValue(null),
  },
  settingsApi: { discountOptions: vi.fn().mockResolvedValue({ amounts: [] }) },
}))

import { TodayWashTicketsPage } from './TodayWashTicketsPage'
import { OrderPanel } from './OrderPanel'
import { SessionProvider } from '@/features/auth/useSession'
import type { OrderPreview, PosOrder } from '@/services/posApi'

function ticket(over: Partial<WashTicketRow> = {}): WashTicketRow {
  return {
    id: 1,
    waiting_no: 3,
    day_date: '2026-09-28',
    issued_at: '2026-09-28 14:30:00Z',
    order_id: 9,
    order_status: 'OPEN',
    customer_name: 'أحمد',
    customer_phone: '01000000001',
    car_plate: 'ABC123',
    car_model: 'تويوتا',
    services: 'غسيل كامل سيدان',
    invoice_id: 4,
    invoice_no: 42,
    invoice_status: 'PAID',
    invoice_total: 17000,
    ...over,
  }
}

function renderPage() {
  return render(
    <ToastProvider>
      <RouterProvider>
        <TodayWashTicketsPage />
      </RouterProvider>
    </ToastProvider>,
  )
}

describe('Today wash tickets page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.mockResolvedValue({ day: { id: 1 }, my_shift: { id: 1 } })
    mocks.washTickets.mockResolvedValue([ticket()])
  })

  it('is a page beside فواتير اليوم, with a header and a way back', async () => {
    renderPage()

    expect(
      await screen.findByRole('heading', { name: 'تذاكر المغسلة اليوم', level: 1 }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await screen.findByText(/1 تذكرة مغسلة في يوم العمل الحالي/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'العودة لنقطة البيع' })).toBeInTheDocument()
  })

  it('lists the day tickets from its own command, scoped to the open day', async () => {
    renderPage()
    await screen.findByText('#3')

    expect(mocks.washTickets).toHaveBeenLastCalledWith(
      expect.objectContaining({ business_day_id: 1 }),
    )
    // The waiting number, the customer and the car are all real domain facts.
    expect(screen.getByText('أحمد')).toBeInTheDocument()
    expect(screen.getByText('ABC123 · تويوتا')).toBeInTheDocument()
    expect(screen.getByText('غسيل كامل سيدان')).toBeInTheDocument()
  })

  it('returns every ticket of the day, not just one', async () => {
    // Distinct order ids so each row's order reference is unambiguous.
    mocks.washTickets.mockResolvedValue([
      ticket({ id: 3, waiting_no: 3, order_id: 91 }),
      ticket({ id: 2, waiting_no: 2, order_id: 92, invoice_id: null, invoice_no: null }),
      ticket({ id: 1, waiting_no: 1, order_id: 93 }),
    ])
    renderPage()

    await screen.findByText('#91')
    expect(screen.getByText('#92')).toBeInTheDocument()
    expect(screen.getByText('#93')).toBeInTheDocument()
  })

  it('opens the RELATED receipt through the existing invoice preview', async () => {
    mocks.printPreviewInvoice.mockResolvedValue({
      doc_type: 'WASH_INVOICE',
      paper_mm: 80,
      ops: [{ text: 'x' }],
    })
    renderPage()
    await screen.findByText('#42')

    // The receipt is addressed by the id the backend resolved through
    // `invoices.order_id` — never by a name, a plate or a position.
    fireEvent.click(screen.getByRole('button', { name: /معاينة الطباعة — #42/ }))

    await waitFor(() => expect(mocks.printPreviewInvoice).toHaveBeenCalledWith(4))
  })

  it('keeps a ticket with no receipt as a first-class row', async () => {
    mocks.washTickets.mockResolvedValue([
      ticket({ id: 2, waiting_no: 2, order_id: 92, invoice_id: null, invoice_no: null }),
    ])
    renderPage()

    // The ticket is present...
    expect(await screen.findByText('#92')).toBeInTheDocument()
    // ...the missing receipt is stated in words, and offers nothing to open.
    expect(screen.getByText('لم تُصدر فاتورة بعد')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /معاينة الطباعة — #/ })).not.toBeInTheDocument()
  })

  it('treats an empty day as a valid empty state, not an error', async () => {
    mocks.washTickets.mockResolvedValue([])
    renderPage()

    expect(await screen.findByText('لا توجد تذاكر مغسلة بعد')).toBeInTheDocument()
    expect(screen.queryByText('تعذر تحميل بيانات تقفيل يوم العمل')).not.toBeInTheDocument()
  })

  it('reports a failed load with a retry', async () => {
    mocks.washTickets.mockRejectedValue({ message: 'internal_error' })
    renderPage()

    expect(await screen.findByText('حدث خطأ غير متوقع، حاول مرة أخرى')).toBeInTheDocument()
  })

  it('searches LIVE through the backend, with no search button', async () => {
    renderPage()
    await screen.findByText('#3')

    const before = mocks.washTickets.mock.calls.length
    fireEvent.change(screen.getByRole('searchbox', { name: 'البحث في تذاكر المغسلة' }), {
      target: { value: 'ABC123' },
    })

    await waitFor(() => expect(mocks.washTickets.mock.calls.length).toBeGreaterThan(before))
    await waitFor(() =>
      expect(mocks.washTickets).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: 'ABC123' }),
      ),
    )
    expect(screen.queryByRole('button', { name: 'بحث' })).not.toBeInTheDocument()
  })
})

describe('Order cancellation after a wash ticket is issued', () => {
  const order = (over: Partial<PosOrder> = {}): PosOrder => ({
    id: 9,
    order_type: 'TABLE',
    table_id: 1,
    user_id: 2,
    status: 'OPEN',
    customer_id: 1,
    discount_mode: null,
    discount_value: null,
    opened_at: '2026-09-28 14:00:00Z',
    waiting_no: null,
    takeaway_no: null,
    shift_id: 1,
    table_label: 'طاولة 01',
    lines: [],
    ...over,
  })

  const preview: OrderPreview = {
    subtotal: 0,
    discount_mode: null,
    discount_value: null,
    discount_minor: 0,
    service_charge_minor: 0,
    total: 0,
    has_wash: false,
  }

  const noop = () => undefined

  function renderPanel(over: Partial<PosOrder> = {}, discard?: () => void) {
    return render(
      <ToastProvider>
        <SessionProvider>
          <OrderPanel
            order={order(over)}
            preview={preview}
            discount={{ mode: null, value: null }}
            serviceCharge={0}
            serviceChargeOptions={[]}
            onServiceChargeChange={noop}
            onDiscountChange={noop}
            onChange={noop}
            onRefreshTables={noop}
            onPay={noop}
            onDiscard={discard}
          />
        </SessionProvider>
      </ToastProvider>,
    )
  }

  it('offers the cancellation while no wash ticket has been issued', () => {
    renderPanel({}, vi.fn())

    expect(screen.getByRole('button', { name: 'إلغاء الطلب الفارغ' })).toBeInTheDocument()
  })

  it('offers NO cancellation once the wash ticket is issued, and says why', () => {
    renderPanel({ waiting_no: 3 }, vi.fn())

    // No executable action for the cashier...
    expect(screen.queryByRole('button', { name: 'إلغاء الطلب الفارغ' })).not.toBeInTheDocument()
    // ...and a specific reason, not a misleading generic error.
    expect(screen.getByText(/لا يمكن إلغاء الطلب بعد إصدار تذكرة المغسلة/)).toBeInTheDocument()
  })
})
