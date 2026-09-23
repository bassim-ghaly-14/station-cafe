/**
 * Table lifecycle + takeaway UX (safe card click, explicit mutations).
 * The card container selects/inspects only; open/start/close/takeaway mutate.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import { SessionProvider } from '@/features/auth/useSession'
import '@/lib/i18n'
import PosPage, { TableCard } from './PosPage'
import type {
  OrderPreview,
  PosOrder,
  PrintPreview,
  TableView,
  TakeawayView,
} from '@/services/posApi'

const mocks = vi.hoisted(() => ({
  tables: vi.fn(),
  openTakeaways: vi.fn(),
  openTable: vi.fn(),
  closeEmptyTable: vi.fn(),
  startOrder: vi.fn(),
  startTakeaway: vi.fn(),
  discardOrder: vi.fn(),
  getOrder: vi.fn(),
  preview: vi.fn(),
  checkout: vi.fn(),
  printInvoice: vi.fn(),
  printPreviewOrder: vi.fn(),
  printPreviewInvoice: vi.fn(),
  printPreviewTicket: vi.fn(),
  state: vi.fn(),
}))

vi.mock('@/services/posApi', () => ({
  api: {
    tables: mocks.tables,
    openTakeaways: mocks.openTakeaways,
    openTable: mocks.openTable,
    closeEmptyTable: mocks.closeEmptyTable,
    startOrder: mocks.startOrder,
    startTakeaway: mocks.startTakeaway,
    discardOrder: mocks.discardOrder,
    getOrder: mocks.getOrder,
    preview: mocks.preview,
    addLine: vi.fn(),
    setQty: vi.fn(),
    removeLine: vi.fn(),
    products: vi.fn().mockResolvedValue([]),
    checkout: mocks.checkout,
    printInvoice: mocks.printInvoice,
    printPreviewOrder: mocks.printPreviewOrder,
    printPreviewInvoice: mocks.printPreviewInvoice,
    printPreviewTicket: mocks.printPreviewTicket,
    ticket: vi.fn(),
    orderCustomer: vi.fn().mockResolvedValue(null),
    detachCustomer: vi.fn().mockResolvedValue(undefined),
    attachCustomer: vi.fn().mockResolvedValue(undefined),
    settingsApi: {
      discountLimit: vi.fn().mockResolvedValue({ mode: 'NONE', value: 0 }),
      setDiscountLimit: vi.fn().mockResolvedValue(undefined),
    },
  },
}))

vi.mock('@/services/shiftApi', () => ({
  shiftApi: { state: mocks.state },
}))

function table(over: Partial<TableView> = {}): TableView {
  return {
    id: 1,
    label: 'Table 01',
    status: 'EMPTY',
    order_id: null,
    session_id: null,
    items_count: 0,
    total_minor: 0,
    opened_at: null,
    opens_today: 0,
    closed_empty_today: 0,
    ...over,
  }
}

const noop = () => {}

function order(over: Partial<PosOrder> = {}): PosOrder {
  return {
    id: 9,
    order_type: 'TABLE',
    table_id: 1,
    user_id: 1,
    status: 'OPEN',
    customer_id: null,
    opened_at: '2026-01-05 10:00:00',
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

function previewOf(total = 6000): OrderPreview {
  return {
    subtotal: total,
    discount_mode: null,
    discount_value: null,
    discount_minor: 0,
    service_charge_mode: 'NONE',
    service_charge_minor: 0,
    total,
    has_wash: false,
  }
}

function takeawayView(over: Partial<TakeawayView> = {}): TakeawayView {
  return {
    id: 7,
    status: 'OPEN',
    opened_at: '2026-01-05 10:00:00',
    items_count: 1,
    total_minor: 6000,
    ...over,
  }
}

function renderCard(tv: TableView) {
  return render(
    <ToastProvider>
      <SessionProvider>
        <TableCard
          tv={tv}
          selected={false}
          active={false}
          busy={null}
          onSelect={noop}
          onOpen={mocks.openTable}
          onStartOrder={mocks.startOrder}
          onOpenOrder={noop}
          onCloseEmpty={mocks.closeEmptyTable}
        />
      </SessionProvider>
    </ToastProvider>,
  )
}

describe('TableCard lifecycle UX', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('clicking the card body does not call any mutating command', () => {
    const onSelect = vi.fn()
    render(
      <ToastProvider>
        <SessionProvider>
          <TableCard
            tv={table()}
            selected={false}
            active={false}
            busy={null}
            onSelect={onSelect}
            onOpen={mocks.openTable}
            onStartOrder={mocks.startOrder}
            onOpenOrder={noop}
            onCloseEmpty={mocks.closeEmptyTable}
          />
        </SessionProvider>
      </ToastProvider>,
    )
    fireEvent.click(screen.getByTestId('table-card-1'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(mocks.openTable).not.toHaveBeenCalled()
    expect(mocks.startOrder).not.toHaveBeenCalled()
    expect(mocks.closeEmptyTable).not.toHaveBeenCalled()
  })

  it('EMPTY card offers Open only; OPEN card offers Start Order + Close Empty', () => {
    const { unmount } = renderCard(table({ status: 'EMPTY' }))
    expect(screen.getByRole('button', { name: /فتح الطاولة/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /إغلاق فارغ/ })).not.toBeInTheDocument()
    unmount()

    renderCard(table({ status: 'OPEN', session_id: 7 }))
    fireEvent.click(screen.getByRole('button', { name: /بدء/ }))
    expect(mocks.startOrder).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /إغلاق فارغ/ })).toBeInTheDocument()
  })

  it('occupied card never offers Close Empty', () => {
    renderCard(table({ status: 'OCCUPIED', order_id: 9 }))
    expect(screen.getByRole('button', { name: /فتح الطلب/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /إغلاق فارغ/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /فتح الطاولة/ })).not.toBeInTheDocument()
  })

  it('shows EMPTY red vs OCCUPIED green status semantics', () => {
    const { unmount } = renderCard(table({ status: 'EMPTY' }))
    expect(screen.getByText('فارغة').className).toMatch(/destructive/)
    unmount()
    renderCard(table({ status: 'OCCUPIED', order_id: 9 }))
    expect(screen.getByText('مشغولة').className).toMatch(/success/)
  })
})

describe('PosPage takeaway entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tables.mockResolvedValue([table()])
    mocks.openTakeaways.mockResolvedValue([])
    mocks.state.mockResolvedValue({ day: { id: 1 }, my_shift: { id: 1 }, any_active_shift: true })
    mocks.getOrder.mockResolvedValue({
      id: 5,
      order_type: 'TAKEAWAY',
      table_id: null,
      user_id: 1,
      status: 'OPEN',
      customer_id: null,
      opened_at: '',
      waiting_no: null,
      takeaway_no: null,
      shift_id: 1,
      table_label: null,
      lines: [],
    })
    mocks.preview.mockResolvedValue(null)
    mocks.startTakeaway.mockResolvedValue(5)
  })

  it('takeaway entry point starts a table-less order without opening a table', async () => {
    render(
      <ToastProvider>
        <SessionProvider>
          <PosPage />
        </SessionProvider>
      </ToastProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /طلب تيك أواي جديد/ }))
    await waitFor(() => expect(mocks.startTakeaway).toHaveBeenCalledTimes(1))
    expect(mocks.openTable).not.toHaveBeenCalled()
    expect(mocks.startOrder).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('طلب تيك أواي نشط')).toBeInTheDocument())
  })
})

function renderPage() {
  return render(
    <ToastProvider>
      <SessionProvider>
        <PosPage />
      </SessionProvider>
    </ToastProvider>,
  )
}

describe('payment entry — one direct action (issues 1 & 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tables.mockResolvedValue([table({ status: 'OCCUPIED', order_id: 9 })])
    mocks.openTakeaways.mockResolvedValue([])
    mocks.state.mockResolvedValue({ day: { id: 1 }, my_shift: { id: 1 } })
    mocks.getOrder.mockResolvedValue(order())
    mocks.preview.mockResolvedValue(previewOf())
  })

  it('offers exactly one مراجعة والدفع before the dialog — no request-payment step', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /فتح الطلب/ }))
    expect(await screen.findByText('قهوة')).toBeInTheDocument()

    expect(screen.getAllByRole('button', { name: 'مراجعة والدفع' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'الدفع' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'طلب الدفع' })).not.toBeInTheDocument()
    // The removed request step must have no API surface left either.
    expect('readyToPay' in (await import('@/services/posApi')).api).toBe(false)
  })

  it('enters payment directly and completes a valid CASH payment', async () => {
    mocks.checkout.mockResolvedValue({
      invoice_id: 77,
      invoice_no: 3,
      total: 6000,
      change_given: 0,
      status: 'PAID',
    })
    mocks.printInvoice.mockResolvedValue(null)

    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /فتح الطلب/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'مراجعة والدفع' }))

    // Dialog shows the authoritative review totals, then confirms payment.
    const cash = await screen.findByPlaceholderText('0.00')
    fireEvent.change(cash, { target: { value: '60' } })
    const confirm = await screen.findByRole('button', { name: 'تأكيد الدفع' })
    await waitFor(() => expect(confirm).not.toBeDisabled())
    fireEvent.click(confirm)

    await waitFor(() =>
      expect(mocks.checkout).toHaveBeenCalledWith({
        order_id: 9,
        method: 'CASH',
        discount_mode: null,
        discount_value: null,
        received: 6000,
      }),
    )
    await screen.findByText('تم الدفع — فاتورة #77')
    expect(screen.queryByText('قهوة')).not.toBeInTheDocument()
  })

  it('still surfaces backend payment rejections inside the dialog', async () => {
    mocks.checkout.mockRejectedValue({ message: 'pos.empty_order' })

    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /فتح الطلب/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'مراجعة والدفع' }))

    const cash = await screen.findByPlaceholderText('0.00')
    fireEvent.change(cash, { target: { value: '60' } })
    const confirm = await screen.findByRole('button', { name: 'تأكيد الدفع' })
    await waitFor(() => expect(confirm).not.toBeDisabled())
    fireEvent.click(confirm)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('الطلب فارغ — أضف أصنافًا أولًا')
    expect(screen.getByRole('button', { name: 'تأكيد الدفع' })).toBeInTheDocument()
  })
})

describe('order panel identity (issue 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tables.mockResolvedValue([table({ status: 'OCCUPIED', order_id: 9 })])
    mocks.openTakeaways.mockResolvedValue([])
    mocks.state.mockResolvedValue({ day: { id: 1 }, my_shift: { id: 1 } })
    mocks.preview.mockResolvedValue(previewOf())
  })

  it('shows the table number/label of a TABLE order', async () => {
    mocks.getOrder.mockResolvedValue(order())
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /فتح الطلب/ }))

    // Subtitle: authoritative table label · order state.
    expect(await screen.findByText('طاولة 01 · مفتوحة')).toBeInTheDocument()
  })

  it('never shows a table for a TAKEAWAY order', async () => {
    mocks.startTakeaway.mockResolvedValue(9)
    mocks.getOrder.mockResolvedValue(
      order({
        id: 9,
        order_type: 'TAKEAWAY',
        table_id: null,
        table_label: null,
        opened_at: '2026-01-05 10:05:00',
      }),
    )
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /طلب تيك أواي جديد/ }))

    // Order type stays clearly identifiable, with no fake table in the panel.
    expect(await screen.findByText('تيك أواي · طلب 9')).toBeInTheDocument()
    expect(screen.queryByText('طاولة 01 · مفتوحة')).not.toBeInTheDocument()
  })
})

describe('open takeaway lifecycle (issue 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tables.mockResolvedValue([table()])
    mocks.state.mockResolvedValue({ day: { id: 1 }, my_shift: { id: 1 } })
    mocks.preview.mockResolvedValue(previewOf())
    mocks.getOrder.mockResolvedValue(
      order({
        id: 7,
        order_type: 'TAKEAWAY',
        table_id: null,
        table_label: null,
        opened_at: '2026-01-05 10:00:00',
      }),
    )
  })

  it('keeps an open takeaway discoverable and reopens it with all its data', async () => {
    mocks.openTakeaways.mockResolvedValue([takeawayView()])
    renderPage()

    // Discoverable with no active order (the user left the order view).
    const chip = await screen.findByTestId('open-takeaway-7')
    expect(chip).toHaveTextContent('تيك أواي · طلب 7')
    expect(chip).toHaveTextContent('10:00')
    expect(chip).toHaveTextContent('1 أصناف')

    // Reopening loads the persisted order with its existing lines.
    fireEvent.click(chip)
    await waitFor(() => expect(mocks.getOrder).toHaveBeenCalledWith(7))
    expect(await screen.findByText('قهوة')).toBeInTheDocument()
    expect(mocks.preview).toHaveBeenCalledWith(7, null, null)
  })

  it('drops a paid takeaway from the open list and clears the panel', async () => {
    mocks.openTakeaways.mockResolvedValueOnce([takeawayView()]).mockResolvedValue([])
    mocks.checkout.mockResolvedValue({
      invoice_id: 78,
      invoice_no: 4,
      total: 6000,
      change_given: 0,
      status: 'PAID',
    })
    mocks.printInvoice.mockResolvedValue(null)

    renderPage()
    fireEvent.click(await screen.findByTestId('open-takeaway-7'))
    expect(await screen.findByText('قهوة')).toBeInTheDocument()

    // One direct action → dialog → confirm.
    fireEvent.click(await screen.findByRole('button', { name: 'مراجعة والدفع' }))
    const cash = await screen.findByPlaceholderText('0.00')
    fireEvent.change(cash, { target: { value: '60' } })
    const confirm = await screen.findByRole('button', { name: 'تأكيد الدفع' })
    await waitFor(() => expect(confirm).not.toBeDisabled())
    fireEvent.click(confirm)

    await screen.findByText('تم الدفع — فاتورة #78')
    await waitFor(() => expect(screen.queryByTestId('open-takeaway-7')).not.toBeInTheDocument())
    expect(screen.queryByText('قهوة')).not.toBeInTheDocument()
  })
})

describe('print preview action beside the pay action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tables.mockResolvedValue([table({ status: 'OCCUPIED', order_id: 9 })])
    mocks.openTakeaways.mockResolvedValue([])
    mocks.state.mockResolvedValue({ day: { id: 1 }, my_shift: { id: 1 } })
    mocks.preview.mockResolvedValue(previewOf())
  })

  it('previews a CAFE order before payment without finalizing it', async () => {
    mocks.getOrder.mockResolvedValue(order())
    mocks.printPreviewOrder.mockResolvedValue({
      doc_type: 'CAFE_INVOICE',
      paper_mm: 80,
      width_chars: 42,
      ops: [{ kind: 'text', text: 'معاينة الطلب — قبل الدفع', align: 'center', bold: false, width: 1, height: 1 }],
    })

    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /فتح الطلب/ }))
    const preview = await screen.findByRole('button', { name: 'معاينة الطباعة' })
    expect(preview).toBeEnabled()
    fireEvent.click(preview)

    await waitFor(() => expect(mocks.printPreviewOrder).toHaveBeenCalledWith(9, null, null))
    expect(await screen.findByText('معاينة الطلب — قبل الدفع')).toBeInTheDocument()
    expect(mocks.checkout).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /إعادة طبع/ })).not.toBeInTheDocument()
  })

  it('previews the issued wash ticket of the open order by its own order id', async () => {
    mocks.getOrder.mockResolvedValue(
      order({
        waiting_no: 12,
        lines: [
          {
            id: 100,
            order_id: 9,
            product_id: 2,
            department: 'WASH',
            product_name: 'غسيل كامل سيدان',
            unit_price: 17500,
            quantity: 1,
            discount_minor: 0,
            line_total: 17500,
          },
        ],
      }),
    )
    mocks.preview.mockResolvedValue({ ...previewOf(17500), has_wash: true })
    const ticket: PrintPreview = {
      doc_type: 'WASH_TICKET',
      paper_mm: 80,
      width_chars: 42,
      ops: [
        { kind: 'text', text: 'رقم الانتظار', align: 'center', bold: true, width: 1, height: 1 },
      ],
    }
    mocks.printPreviewTicket.mockResolvedValue(ticket)

    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /فتح الطلب/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'معاينة الطباعة' }))

    await waitFor(() => expect(mocks.printPreviewTicket).toHaveBeenCalledWith(9))
    expect(await screen.findByText('رقم الانتظار')).toBeInTheDocument()
    // Reprint of the wash ticket reuses the existing print pipeline/id.
    expect(screen.getByRole('button', { name: /إعادة طبع/ })).toBeEnabled()
  })
})
