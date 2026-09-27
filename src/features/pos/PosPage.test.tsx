/**
 * Table lifecycle + takeaway UX (safe card click, explicit mutations).
 * The card container selects/inspects only; open/start/close/takeaway mutate.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import { SessionProvider } from '@/features/auth/useSession'
import { RouterProvider } from '@/app/router'
import '@/lib/i18n'
import { formatMinorMoney } from '@/lib/money'
import { resetFormattingPreferences, updateDateSettings } from '@/lib/formatting'
import PosPage, { TableCard } from './PosPage'
import { CurrentShiftPanel } from './CurrentShiftPanel'
import { DayClosingPanel } from './DayClosingPanel'
import type { ShiftRow } from '@/services/shiftApi'
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
  printPreviewShift: vi.fn(),
  printShift: vi.fn(),
  printDay: vi.fn(),
  printPreviewDay: vi.fn(),
  state: vi.fn(),
  previewShiftClose: vi.fn(),
  closeShift: vi.fn(),
  previewDaySettlement: vi.fn(),
  settleDay: vi.fn(),
  daySettlementHistory: vi.fn(),
  dayReport: vi.fn(),
  previewDayClose: vi.fn(),
  closeDay: vi.fn(),
  shiftExpenses: vi.fn(async () => []),
  expenseCategories: vi.fn(async () => [
    { code: 'SUPPLIES', name_ar: 'مشتريات', is_system: true, is_active: true },
  ]),
  createExpense: vi.fn(),
}))

vi.mock('@/services/posApi', async (importOriginal) => ({
  // Partial mock: the real payload guard (`isPrintPreview`) stays in place, only
  // the command surface the page drives is replaced.
  ...(await importOriginal<typeof import('@/services/posApi')>()),
  settingsApi: {
    serviceCharge: vi.fn().mockResolvedValue({ amounts: [1000, 3000, 5000, 7000, 10000] }),
    discountOptions: vi.fn().mockResolvedValue({ amounts: [2000, 5000, 10000] }),
  },
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
    printPreviewShift: mocks.printPreviewShift,
    printShift: mocks.printShift,
    printDay: mocks.printDay,
    printPreviewDay: mocks.printPreviewDay,
    ticket: vi.fn(),
    orderCustomer: vi.fn().mockResolvedValue(null),
    detachCustomer: vi.fn().mockResolvedValue(undefined),
    attachCustomer: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@/services/shiftApi', () => ({
  shiftApi: {
    state: mocks.state,
    previewShiftClose: mocks.previewShiftClose,
    closeShift: mocks.closeShift,
    previewDaySettlement: mocks.previewDaySettlement,
    settleDay: mocks.settleDay,
    daySettlementHistory: mocks.daySettlementHistory,
    dayReport: mocks.dayReport,
    previewDayClose: mocks.previewDayClose,
    closeDay: mocks.closeDay,
  },
}))

// The POS shift panel books expenses through the ops API.
vi.mock('@/services/opsApi', () => ({
  opsApi: {
    shiftExpenses: mocks.shiftExpenses,
    expenseCategories: mocks.expenseCategories,
    createExpense: mocks.createExpense,
  },
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
    discount_mode: null,
    discount_value: null,
    opened_at: '2026-01-05 10:00:00Z',
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
    service_charge_minor: 0,
    total,
    has_wash: false,
  }
}

function takeawayView(over: Partial<TakeawayView> = {}): TakeawayView {
  return {
    id: 7,
    status: 'OPEN',
    opened_at: '2026-01-05 10:00:00Z',
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

function renderPage() {
  // The POS page navigates to Today's Invoices, so it renders inside the same
  // RouterProvider the application shell provides in production.
  return render(
    <ToastProvider>
      <SessionProvider>
        <RouterProvider>
          <PosPage />
        </RouterProvider>
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

    expect(screen.getByRole('button', { name: /رؤية الطلب/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /إغلاق فارغ/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /فتح الطاولة/ })).not.toBeInTheDocument()
  })

  it('shows EMPTY red vs OCCUPIED green status semantics', () => {
    const { unmount } = renderCard(table({ status: 'EMPTY' }))

    expect(screen.getByText('فارغة').parentElement?.className).toMatch(/badge-danger/)

    unmount()

    renderCard(table({ status: 'OCCUPIED', order_id: 9 }))

    expect(screen.getByText('مشغولة').parentElement?.className).toMatch(/badge-success/)
  })
})

describe('PosPage takeaway entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mocks.tables.mockResolvedValue([table()])
    mocks.openTakeaways.mockResolvedValue([])
    mocks.state.mockResolvedValue({
      day: { id: 1 },
      my_shift: { id: 1 },
      any_active_shift: true,
    })

    mocks.getOrder.mockResolvedValue(
      order({
        id: 5,
        order_type: 'TAKEAWAY',
        table_id: null,
        table_label: null,
        opened_at: '2026-01-05 10:00:00Z',
        takeaway_no: null,
        lines: [],
      }),
    )

    mocks.preview.mockResolvedValue(null)
    mocks.startTakeaway.mockResolvedValue(5)
  })

  it('takeaway entry point starts a table-less order without opening a table', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /بدء الطلب/ }))

    await waitFor(() => expect(mocks.startTakeaway).toHaveBeenCalledTimes(1))

    expect(mocks.openTable).not.toHaveBeenCalled()
    expect(mocks.startOrder).not.toHaveBeenCalled()

    await waitFor(() => expect(screen.getByText('طلب خارجي نشط')).toBeInTheDocument())
  })
})

describe('payment entry — one direct action (issues 1 & 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mocks.tables.mockResolvedValue([table({ status: 'OCCUPIED', order_id: 9 })])
    mocks.openTakeaways.mockResolvedValue([])
    mocks.state.mockResolvedValue({
      day: { id: 1 },
      my_shift: { id: 1 },
    })
    mocks.getOrder.mockResolvedValue(order())
    mocks.preview.mockResolvedValue(previewOf())
  })

  it('offers exactly one مراجعة والدفع before the dialog — no request-payment step', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /رؤية الطلب/ }))

    expect(await screen.findByText('قهوة')).toBeInTheDocument()

    expect(screen.getAllByRole('button', { name: 'مراجعة والدفع' })).toHaveLength(1)

    expect(screen.queryByRole('button', { name: 'الدفع' })).not.toBeInTheDocument()

    expect(screen.queryByRole('button', { name: 'طلب الدفع' })).not.toBeInTheDocument()

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

    fireEvent.click(await screen.findByRole('button', { name: /رؤية الطلب/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'مراجعة والدفع' }))

    const cash = await screen.findByPlaceholderText('0.00')

    fireEvent.change(cash, { target: { value: '60' } })

    const confirm = await screen.findByRole('button', {
      name: 'تأكيد الدفع',
    })

    await waitFor(() => expect(confirm).not.toBeDisabled())

    fireEvent.click(confirm)

    await waitFor(() =>
      expect(mocks.checkout).toHaveBeenCalledWith({
        order_id: 9,
        method: 'CASH',
        discount_mode: null,
        discount_value: null,
        discount_pin: null,
        service_charge_minor: 0,
        received: 6000,
      }),
    )

    await screen.findByText('تم الدفع — فاتورة #77')

    expect(screen.queryByText('قهوة')).not.toBeInTheDocument()
  })

  it('offers the received amount as ONE auto-fill shortcut, never a duplicate', async () => {
    // 60.00 EGP = 6000 minor, a whole multiple of 5 — the exact case where the
    // "round up to a 5 EGP note" shortcut used to equal the exact amount.
    mocks.getOrder.mockResolvedValue(order())
    mocks.preview.mockResolvedValue(previewOf(6000))

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /رؤية الطلب/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'مراجعة والدفع' }))

    const shortcuts = await screen.findAllByRole('button', {
      name: /ملء المبلغ المستلم تلقائيًا/,
    })
    // Exactly one: the duplicated control is gone.
    expect(shortcuts).toHaveLength(1)
    // It is announced as an action with an explicit affordance label.
    expect(shortcuts[0]).toHaveAttribute('aria-label', expect.stringContaining('60'))
    expect(screen.getByText('اضغط لملء المبلغ المستلم تلقائيًا')).toBeInTheDocument()

    // Pressing it writes the amount into the field; it is not a second value.
    fireEvent.click(shortcuts[0])
    const cash = screen.getByPlaceholderText('0.00')
    expect(cash).toHaveValue('60.00')
    expect(shortcuts[0]).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps both shortcuts when the rounded amount genuinely differs', async () => {
    // 62.00 EGP rounds up to the 65.00 EGP note, so two distinct shortcuts exist.
    mocks.getOrder.mockResolvedValue(order())
    mocks.preview.mockResolvedValue(previewOf(6200))

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /رؤية الطلب/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'مراجعة والدفع' }))

    const shortcuts = await screen.findAllByRole('button', {
      name: /ملء المبلغ المستلم تلقائيًا/,
    })
    expect(shortcuts).toHaveLength(2)
    fireEvent.click(shortcuts[1])
    expect(screen.getByPlaceholderText('0.00')).toHaveValue('65.00')
  })

  it('still surfaces backend payment rejections inside the dialog', async () => {
    mocks.checkout.mockRejectedValue({ message: 'pos.empty_order' })

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /رؤية الطلب/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'مراجعة والدفع' }))

    const cash = await screen.findByPlaceholderText('0.00')

    fireEvent.change(cash, { target: { value: '60' } })

    const confirm = await screen.findByRole('button', {
      name: 'تأكيد الدفع',
    })

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
    mocks.state.mockResolvedValue({
      day: { id: 1 },
      my_shift: { id: 1 },
    })
    mocks.preview.mockResolvedValue(previewOf())
  })

  it('shows the table number/label of a TABLE order', async () => {
    mocks.getOrder.mockResolvedValue(order())

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /رؤية الطلب/ }))

    expect(await screen.findByText('طاولة 01 · مفتوحة')).toBeInTheDocument()
  })

  it('identifies a TAKEAWAY order without rendering a table identity', async () => {
    mocks.startTakeaway.mockResolvedValue(9)

    mocks.getOrder.mockResolvedValue(
      order({
        id: 9,
        order_type: 'TAKEAWAY',
        table_id: null,
        table_label: null,
        opened_at: '2026-01-05 10:05:00Z',
        takeaway_no: null,
      }),
    )

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /بدء الطلب/ }))

    await waitFor(() => {
      expect(mocks.startTakeaway).toHaveBeenCalledTimes(1)
      expect(mocks.getOrder).toHaveBeenCalledWith(9)
    })

    // TAKEAWAY has its own explicit order-type identity.
    expect(await screen.findByText('طلب خارجي نشط')).toBeInTheDocument()

    // A takeaway order must never inherit or display the table identity.
    expect(screen.queryByText('طاولة 01 · مفتوحة')).not.toBeInTheDocument()

    // The loaded order remains the active order shown by the order workspace.
    expect(screen.getByRole('button', { name: 'مراجعة والدفع' })).toBeInTheDocument()
  })
})

describe('open takeaway lifecycle (issue 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mocks.tables.mockResolvedValue([table()])

    mocks.state.mockResolvedValue({
      day: { id: 1 },
      my_shift: { id: 1 },
    })

    mocks.preview.mockResolvedValue(previewOf())

    mocks.getOrder.mockResolvedValue(
      order({
        id: 7,
        order_type: 'TAKEAWAY',
        table_id: null,
        table_label: null,
        opened_at: '2026-01-05 10:00:00Z',
      }),
    )
  })

  it('keeps an open takeaway discoverable and reopens it with all its data', async () => {
    mocks.openTakeaways.mockResolvedValue([takeawayView()])

    renderPage()

    const chip = await screen.findByTestId('open-takeaway-7')

    expect(chip).toHaveTextContent('طلبات خارجية · طلب 7')
    expect(chip).toHaveTextContent('12:00')
    expect(chip).toHaveTextContent('1 أصناف')

    fireEvent.click(chip)

    await waitFor(() => expect(mocks.getOrder).toHaveBeenCalledWith(7))

    expect(await screen.findByText('قهوة')).toBeInTheDocument()
    expect(mocks.preview).toHaveBeenCalledWith(7, null, null, 0)
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

    fireEvent.click(await screen.findByRole('button', { name: 'مراجعة والدفع' }))

    const cash = await screen.findByPlaceholderText('0.00')

    fireEvent.change(cash, { target: { value: '60' } })

    const confirm = await screen.findByRole('button', {
      name: 'تأكيد الدفع',
    })

    await waitFor(() => expect(confirm).not.toBeDisabled())

    fireEvent.click(confirm)

    await screen.findByText('تم الدفع — فاتورة #78')

    await waitFor(() => expect(screen.queryByTestId('open-takeaway-7')).not.toBeInTheDocument())

    expect(screen.queryByText('قهوة')).not.toBeInTheDocument()
  })
})

describe('POS page hierarchy (operation vs. selling workflow)', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mocks.tables.mockResolvedValue([
      table({ status: 'EMPTY' }),
      table({ id: 2, status: 'OCCUPIED', order_id: 9 }),
    ])
    mocks.openTakeaways.mockResolvedValue([])
    mocks.state.mockResolvedValue({
      day: { id: 1 },
      my_shift: { id: 1, opened_at: '2026-01-05 08:00:00Z' },
    })
    mocks.preview.mockResolvedValue(previewOf())
  })

  it('puts "فواتير اليوم" in the page header, away from the new-order cards', async () => {
    renderPage()

    // Discoverable exactly once, in the operational header of the page.
    const invoices = await screen.findAllByRole('button', { name: 'فواتير اليوم' })
    expect(invoices).toHaveLength(1)
    expect(invoices[0].closest('header')).not.toBeNull()
    // ... and never inside the table/takeaway workspace card.
    expect(invoices[0].closest('[data-testid="takeaway-card"]')).toBeNull()
  })

  it('places the closing cards in their own operational section, below the workspace', async () => {
    const { container } = renderPage()

    const operations = await screen.findByLabelText('إجراءات التشغيل والتقفيل')
    const workspace = screen.getByLabelText('الطاولات')

    // The selling workspace is the dominant block; closing is a later section.
    expect(
      workspace.compareDocumentPosition(operations) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(container.textContent).toContain('إجراءات التشغيل والتقفيل')
  })

  it('shows the current shift state before anything else', async () => {
    renderPage()

    expect(await screen.findByText(/وردية مفتوحة/)).toBeInTheDocument()
  })
})

describe('print preview action beside the pay action', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mocks.tables.mockResolvedValue([table({ status: 'OCCUPIED', order_id: 9 })])
    mocks.openTakeaways.mockResolvedValue([])
    mocks.state.mockResolvedValue({
      day: { id: 1 },
      my_shift: { id: 1 },
    })
    mocks.preview.mockResolvedValue(previewOf())
  })

  it('previews a CAFE order before payment without finalizing it', async () => {
    mocks.getOrder.mockResolvedValue(order())

    mocks.printPreviewOrder.mockResolvedValue({
      doc_type: 'CAFE_INVOICE',
      paper_mm: 80,
      width_chars: 42,
      ops: [
        {
          kind: 'text',
          text: 'معاينة الطلب — قبل الدفع',
          align: 'center',
          bold: false,
          width: 1,
          height: 1,
        },
      ],
    })

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /رؤية الطلب/ }))

    const preview = await screen.findByRole('button', {
      name: 'معاينة الطباعة',
    })

    expect(preview).toBeEnabled()

    fireEvent.click(preview)

    await waitFor(() => expect(mocks.printPreviewOrder).toHaveBeenCalledWith(9, null, null, 0))

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

    mocks.preview.mockResolvedValue({
      ...previewOf(17500),
      has_wash: true,
    })

    const ticket: PrintPreview = {
      doc_type: 'WASH_TICKET',
      paper_mm: 80,
      width_chars: 42,
      ops: [
        {
          kind: 'text',
          text: 'رقم الانتظار',
          align: 'center',
          bold: true,
          width: 1,
          height: 1,
        },
      ],
    }

    mocks.printPreviewTicket.mockResolvedValue(ticket)
    // A real PrintPreview shape: the viewer renders `ops`, so an order-preview
    // fixture must be a document, not a bare OrderPreview.
    mocks.printPreviewOrder.mockResolvedValue({
      doc_type: 'WASH_INVOICE',
      paper_mm: 80,
      width_chars: 42,
      ops: [
        {
          kind: 'text',
          text: 'فاتورة رقم 7',
          align: 'center',
          bold: true,
          width: 1,
          height: 1,
        },
      ],
    })

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /رؤية الطلب/ }))

    // The wash ticket has its OWN compact trigger — it is a different document,
    // and pressing the invoice preview must no longer silently show a ticket.
    const ticketPreview = await screen.findByRole('button', { name: 'معاينة تذكرة المغسلة' })
    fireEvent.click(ticketPreview)

    await waitFor(() => expect(mocks.printPreviewTicket).toHaveBeenCalledWith(9))
    expect(await screen.findByText('رقم الانتظار')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /إعادة طبع/ })).toBeEnabled()

    // Same shared dialog, and the invoice preview is still the invoice document.
    fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'إغلاق' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'معاينة الطباعة' }))
    await waitFor(() => expect(mocks.printPreviewOrder).toHaveBeenCalledWith(9, null, null, 0))
    expect(mocks.printPreviewTicket).toHaveBeenCalledTimes(1)
  })

  it('never carries a checkout service charge onto the next order', async () => {
    // A service charge is a checkout SELECTION, not order state: it is never
    // persisted on the order, so the POS must clear it at every order-context
    // change. Otherwise the next customer is silently charged for a service fee
    // the cashier never selected for them.
    mocks.getOrder.mockResolvedValue(order())
    mocks.preview.mockResolvedValue(previewOf())
    mocks.printPreviewOrder.mockResolvedValue({
      doc_type: 'CAFE_INVOICE',
      paper_mm: 80,
      width_chars: 42,
      ops: [],
    })

    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /رؤية الطلب/ }))

    // Apply a 10.00 service charge in checkout.
    fireEvent.click(await screen.findByRole('button', { name: /إضافة خدمة 10.00/ }))
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledWith(9, null, null, 1000))

    // Re-opening the order (the same path a cashier takes to a different
    // table) must NOT re-submit the spent charge.
    fireEvent.click(screen.getByRole('button', { name: /رؤية الطلب/ }))
    await waitFor(() => expect(mocks.preview).toHaveBeenLastCalledWith(9, null, null, 0))
  })

  it('offers no ticket preview trigger before a ticket is issued', async () => {
    mocks.getOrder.mockResolvedValue(order())

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /رؤية الطلب/ }))

    expect(screen.queryByRole('button', { name: 'معاينة تذكرة المغسلة' })).not.toBeInTheDocument()
  })
})

describe('shift lifecycle UI', () => {
  // Display formatting is global state — restore it so these cases stay isolated.
  afterEach(() => resetFormattingPreferences())
  const shift: ShiftRow = {
    id: 7,
    business_day_id: 1,
    user_id: 2,
    user_name: 'Cashier One',
    status: 'ACTIVE',
    opened_at: '2026-09-24 16:00:00Z',
    opening_cash: 1000,
    closed_at: null,
    cash_sales: 2000,
    card_sales: 3000,
    credit_sales: 500,
    service_charges: 0,
    discounts: 0,
    invoices_count: 3,
    expected_cash: 3000,
    actual_cash: null,
    cash_difference: null,
    cafe_invoices: 1,
    wash_invoices: 0,
    hybrid_invoices: 0,
    subtotal: 5500,
    // The card's headline figure is the BACKEND's `total_sales` for the shift.
    // It is deliberately not cash+card+credit computed in React: those three
    // only coincide with the invoice total when every invoice is fully settled,
    // and re-deriving the total in the client is exactly the duplication this
    // flow forbids.
    total_sales: 5500,
    cafe_sales: 5500,
    wash_sales: 0,
    expenses: 0,
    cash_expenses: 0,
  }

  // The authoritative backend reconciliation, in exactly the shape the screen,
  // the preview and the printer all consume. Tests assert on these values
  // rather than on anything the UI computes.
  const shiftReport = {
    shift,
    areas: { cafe_invoices: 2, wash_invoices: 1, hybrid_invoices: 0 },
    invoices_count: 3,
    cafe_sales: 2000,
    wash_sales: 1000,
    subtotal: 3500,
    discounts: 500,
    service_charges: 500,
    total_sales: 3500,
    cash_sales: 2000,
    card_sales: 3000,
    credit_sales: 500,
    expenses: 0,
    cash_expenses: 0,
    expense_breakdown: [],
    cash: {
      opening_cash: 1000,
      cash_inflows: 2000,
      cash_outflows: 0,
      expected_cash: 3000,
      actual_cash: 3000,
      difference: 0,
      shortage: 0,
      surplus: 0,
      status: 'BALANCED' as const,
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.previewShiftClose.mockResolvedValue({
      shift,
      closing_at: '2026-09-25 01:30:00Z',
      cash_sales: 2000,
      card_sales: 3000,
      credit_sales: 500,
      invoices_count: 3,
      expected_cash: 3000,
      cash_expenses: 0,
      expenses: 0,
      report: shiftReport,
    })
    mocks.closeShift.mockResolvedValue({
      shift: { ...shift, status: 'CLOSED' },
      expected_cash: 3000,
      difference: 0,
      report: shiftReport,
    })
    mocks.printShift.mockResolvedValue({ duplicate_suppressed: false, job_id: 1 })
    mocks.printPreviewShift.mockResolvedValue({
      doc_type: 'SHIFT_REPORT',
      paper_mm: 80,
      width_chars: 42,
      ops: [
        { kind: 'text', text: 'تقفيل وردية', align: 'center', bold: true, width: 1, height: 1 },
      ],
    })
  })

  it('opens the authoritative shift report preview with the current shift id', async () => {
    render(
      <ToastProvider>
        <CurrentShiftPanel shift={shift} onClosed={vi.fn()} />
      </ToastProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /تقفيل الوردية/ }))
    fireEvent.click(await screen.findByRole('button', { name: /معاينة قبل الطباعة/ }))

    expect(await screen.findByText('تقفيل وردية')).toBeInTheDocument()
    expect(mocks.printPreviewShift).toHaveBeenCalledWith(7)
    expect(mocks.closeShift).not.toHaveBeenCalled()
  })

  it('shows the active shift period and closes with actual cash exactly once', async () => {
    const onClosed = vi.fn().mockResolvedValue(undefined)
    render(
      <ToastProvider>
        <CurrentShiftPanel shift={shift} onClosed={onClosed} />
      </ToastProvider>,
    )

    // The date and the time are separate slots in the closing card, so they are
    // asserted as separate elements (a long localized date must never merge
    // with the time or the separator).
    expect(screen.getByText('24/09/2026')).toBeInTheDocument()
    expect(screen.getByText('19:00')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /تقفيل الوردية/ }))
    // The shift closed at 01:30 UTC, which is 04:30 on the 25th in Cairo — the
    // UI must show the business-local date and time, not the stored UTC digits.
    expect(await screen.findByText('25/09/2026')).toBeInTheDocument()
    expect(await screen.findByText('04:30')).toBeInTheDocument()

    const input = screen.getByPlaceholderText('0.00')
    fireEvent.change(input, { target: { value: '30' } })
    const buttons = screen.getAllByRole('button', { name: /تقفيل الوردية/ })
    fireEvent.click(buttons[buttons.length - 1])
    fireEvent.click(buttons[buttons.length - 1])

    await waitFor(() => expect(mocks.closeShift).toHaveBeenCalledTimes(1))
    expect(mocks.closeShift).toHaveBeenCalledWith(3000)
    expect(onClosed).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(mocks.printShift).toHaveBeenCalledWith(7))
    expect(mocks.printShift.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.closeShift.mock.invocationCallOrder[0],
    )
  })

  it('auto-fills the expected cash through the SAME shortcut pattern as payment', async () => {
    render(
      <ToastProvider>
        <CurrentShiftPanel shift={shift} onClosed={vi.fn()} />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /تقفيل الوردية/ }))

    // One shortcut, the same affordance language as the payment dialog, and it
    // fills the field rather than being a second amount reading.
    const shortcut = await screen.findByRole('button', {
      name: /ملء النقد الفعلي تلقائيًا/,
    })
    expect(screen.getAllByRole('button', { name: /ملء النقد الفعلي تلقائيًا/ })).toHaveLength(1)
    expect(screen.getByText('اضغط لملء النقد المتوقع تلقائيًا')).toBeInTheDocument()

    const input = screen.getByPlaceholderText('0.00')
    expect(input).toHaveValue('')
    fireEvent.click(shortcut)

    // expected_cash is 30.00 EGP, and the balanced state is reflected live.
    expect(input).toHaveValue('30.00')
    expect(shortcut).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('متوازن')).toBeInTheDocument()
  })

  it('keeps the dialog open and exposes a backend close error', async () => {
    mocks.closeShift.mockRejectedValue(new Error('shift.not_open'))
    render(
      <ToastProvider>
        <CurrentShiftPanel shift={shift} onClosed={vi.fn()} />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /تقفيل الوردية/ }))
    fireEvent.change(await screen.findByPlaceholderText('0.00'), { target: { value: '30' } })
    const buttons = screen.getAllByRole('button', { name: /تقفيل الوردية/ })
    fireEvent.click(buttons[buttons.length - 1])

    // The backend rejection is surfaced verbatim through the error map
    // (`errors.shift.not_open`), not as a generic failure.
    expect(await screen.findByRole('alert')).toHaveTextContent('لا توجد وردية مفتوحة')
  })

  // The cash field is a plain controlled string. It must behave like any other
  // input: multi-character entry, insertion, deletion, replacement and paste,
  // with focus never leaving it and no focus-restoration machinery anywhere.
  it('accepts a normal multi-character amount without losing focus', async () => {
    render(
      <ToastProvider>
        <CurrentShiftPanel shift={shift} onClosed={vi.fn()} />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /تقفيل الوردية/ }))
    const input = (await screen.findByPlaceholderText('0.00')) as HTMLInputElement
    // The dialog hands initial focus to the cash field, not to the close button.
    expect(input).toHaveFocus()

    for (const char of ['1', '2', '3']) {
      fireEvent.change(input, { target: { value: input.value + char } })
      expect(input).toHaveFocus()
    }
    expect(input.value).toBe('123')

    // Insert a decimal part, then delete back down, then replace the whole value.
    fireEvent.change(input, { target: { value: '123.50' } })
    expect(input).toHaveFocus()
    expect(input.value).toBe('123.50')

    fireEvent.change(input, { target: { value: '123.5' } })
    expect(input.value).toBe('123.5')
    fireEvent.change(input, { target: { value: '123.' } })
    expect(input.value).toBe('123.')
    fireEvent.change(input, { target: { value: '12' } })
    expect(input.value).toBe('12')
    fireEvent.change(input, { target: { value: '' } })
    expect(input).toHaveFocus()
    expect(input.value).toBe('')

    // A pasted value lands verbatim and keeps focus.
    fireEvent.change(input, { target: { value: '45.75' } })
    expect(input).toHaveFocus()
    expect(input.value).toBe('45.75')
  })

  it('validates the typed amount and shows the live variance', async () => {
    render(
      <ToastProvider>
        <CurrentShiftPanel shift={shift} onClosed={vi.fn()} />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /تقفيل الوردية/ }))
    const input = (await screen.findByPlaceholderText('0.00')) as HTMLInputElement
    const confirm = () => screen.getAllByRole('button', { name: /تأكيد تقفيل الوردية/ }).at(-1)!

    // Expected cash is 30.00. An empty amount cannot be confirmed.
    expect(confirm()).toBeDisabled()

    fireEvent.change(input, { target: { value: 'abc' } })
    expect(await screen.findByText('قيمة النقدية غير صحيحة')).toBeInTheDocument()
    expect(confirm()).toBeDisabled()
    expect(mocks.closeShift).not.toHaveBeenCalled()

    // Exactly the expected amount → balanced.
    fireEvent.change(input, { target: { value: '30' } })
    expect(await screen.findByText('متوازن')).toBeInTheDocument()
    expect(confirm()).toBeEnabled()

    // Short → deficit; over → surplus. The action stays available either way.
    fireEvent.change(input, { target: { value: '25' } })
    expect(await screen.findByText('عجز')).toBeInTheDocument()
    expect(confirm()).toBeEnabled()

    fireEvent.change(input, { target: { value: '35' } })
    expect(await screen.findByText('زيادة')).toBeInTheDocument()
  })

  // The card must not be the dialog's responsibility: the numbers the card
  // renders come from `day_shift_state` and must change on their own.
  it('renders the card totals from the shift row it is given, with no dialog open', () => {
    // Money is asserted through the central formatter, never a hardcoded string.
    const money = (amount: number) => formatMinorMoney(amount, { variant: 'auto' })
    const { rerender, container } = render(
      <ToastProvider>
        <CurrentShiftPanel shift={shift} onClosed={vi.fn()} />
      </ToastProvider>,
    )
    // The card renders the shift row's own figures: the backend's total sales
    // as the headline, and each payment method beside it.
    expect(container.textContent).toContain(money(5500))
    expect(container.textContent).toContain(money(2000))
    expect(container.textContent).toContain(money(3000))
    expect(mocks.previewShiftClose).not.toHaveBeenCalled()

    rerender(
      <ToastProvider>
        <CurrentShiftPanel
          shift={{
            ...shift,
            total_sales: 6000,
            cash_sales: 2500,
            card_sales: 3000,
            credit_sales: 500,
          }}
          onClosed={vi.fn()}
        />
      </ToastProvider>,
    )
    // The card followed the new data.
    expect(container.textContent).toContain(money(6000))
    expect(container.textContent).toContain(money(2500))
    expect(mocks.previewShiftClose).not.toHaveBeenCalled()
  })

  // Regression: with DD MMM YYYY + 12h the date and time have very different
  // widths, and the Arabic AM/PM marker must not be reordered against them.
  // The fix is structural — the card composes separate, isolated slots — so the
  // assertion is that the parts are distinct elements, never one merged blob.
  it.each([
    ['DD/MM/YYYY', '24/09/2026', '19:00'],
    ['DD MMM YYYY', '24 سبتمبر 2026', '19:00'],
    ['YYYY-MM-DD', '2026-09-24', '19:00'],
    ['DD-MM-YYYY', '24-09-2026', '19:00'],
    ['MM/DD/YYYY', '09/24/2026', '19:00'],
    ['MMM DD, YYYY', 'سبتمبر 24, 2026', '19:00'],
  ])('keeps the closing card composed under %s', (dateFormat, expectedDate, expectedTime) => {
    updateDateSettings({ dateFormat: dateFormat as 'DD/MM/YYYY', timeFormat: '24h' })
    render(
      <ToastProvider>
        <CurrentShiftPanel shift={shift} onClosed={vi.fn()} />
      </ToastProvider>,
    )
    const date = screen.getByText(expectedDate)
    const time = screen.getByText(expectedTime)
    // Separate elements, each isolated from the surrounding RTL direction.
    expect(date).not.toBe(time)
    expect(date).toHaveAttribute('dir', 'ltr')
    expect(time).toHaveAttribute('dir', 'ltr')
    expect(date.closest('span[dir="ltr"]')).not.toBe(time.closest('span[dir="ltr"]'))
  })

  it('renders a 12-hour AM/PM time beside a long localized date without merging', () => {
    updateDateSettings({ dateFormat: 'DD MMM YYYY', timeFormat: '12h' })
    render(
      <ToastProvider>
        <CurrentShiftPanel shift={shift} onClosed={vi.fn()} />
      </ToastProvider>,
    )
    // The date is its own slot and the 12-hour time is its own slot, so the
    // localized meridiem can never be reordered into the middle of the date.
    // The shift opened at 16:00 UTC = 19:00 Cairo.
    expect(screen.getByText('24 سبتمبر 2026')).toBeInTheDocument()
    expect(screen.getByText(/7:00/).textContent).toContain('7:00')
  })

  // Opening must never be blocked on a round-trip: the dialog appears at once,
  // the cash field is usable and focused immediately, and only the
  // server-derived figures show a loading state. Confirming is blocked until
  // those figures exist, so stale numbers can never be submitted.
  it('opens the dialog immediately, focuses the field, and blocks confirm until loaded', async () => {
    let resolvePreview: (value: unknown) => void = () => {}
    mocks.previewShiftClose.mockReturnValue(
      new Promise((resolve) => {
        resolvePreview = resolve
      }),
    )
    render(
      <ToastProvider>
        <CurrentShiftPanel shift={shift} onClosed={vi.fn()} />
      </ToastProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /تقفيل الوردية/ }))

    // Synchronously open, with the input already mounted and focused.
    const input = screen.getByPlaceholderText('0.00') as HTMLInputElement
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: '30' } })
    expect(input).toHaveFocus()

    // Figures still loading → confirm is unavailable, nothing is submitted.
    const confirm = screen.getAllByRole('button', { name: /تأكيد تقفيل الوردية/ }).at(-1)!
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(mocks.closeShift).not.toHaveBeenCalled()

    resolvePreview({
      shift,
      closing_at: '2026-09-25 01:30:00Z',
      cash_sales: 2000,
      card_sales: 3000,
      credit_sales: 500,
      invoices_count: 3,
      expected_cash: 3000,
      cash_expenses: 0,
      expenses: 0,
      report: shiftReport,
    })

    await waitFor(() => expect(confirm).toBeEnabled())
    expect(await screen.findByText('متوازن')).toBeInTheDocument()
    // The typed value survived the load — no remount, no reset.
    expect(input).toHaveValue('30')
  })

  it('surfaces a domain error inside the dialog and allows a retry', async () => {
    mocks.previewShiftClose.mockRejectedValueOnce({ message: 'shift.not_open' })
    render(
      <ToastProvider>
        <CurrentShiftPanel shift={shift} onClosed={vi.fn()} />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /تقفيل الوردية/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('لا توجد وردية مفتوحة')
    // The form stays usable while the error is shown.
    expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument()

    mocks.previewShiftClose.mockResolvedValue({
      shift,
      closing_at: '2026-09-25 01:30:00Z',
      cash_sales: 2000,
      card_sales: 3000,
      credit_sales: 500,
      invoices_count: 3,
      expected_cash: 3000,
      cash_expenses: 0,
      expenses: 0,
      report: shiftReport,
    })
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }))
    expect(await screen.findByText('النقد المتوقع')).toBeInTheDocument()
  })
})

describe('day closing UI', () => {
  const closedShift: ShiftRow = {
    id: 7,
    business_day_id: 1,
    user_id: 2,
    user_name: 'Cashier One',
    status: 'CLOSED',
    opened_at: '2026-09-24 16:00:00Z',
    opening_cash: 1000,
    closed_at: '2026-09-24 22:00:00Z',
    cash_sales: 1000,
    card_sales: 2000,
    credit_sales: 0,
    service_charges: 0,
    discounts: 0,
    invoices_count: 1,
    expected_cash: 2000,
    actual_cash: 2000,
    cash_difference: 0,
    cafe_invoices: 1,
    wash_invoices: 0,
    hybrid_invoices: 0,
    subtotal: 0,
    total_sales: 0,
    cafe_sales: 0,
    wash_sales: 0,
    expenses: 0,
    cash_expenses: 0,
  }
  // The authoritative day report, exactly as the backend returns it.
  const day = {
    day: {
      id: 1,
      day_date: '2026-09-24',
      status: 'OPEN',
      opened_at: '2026-09-24 16:00:00Z',
      closed_at: null,
    },
    areas: { cafe_invoices: 1, wash_invoices: 1, hybrid_invoices: 0 },
    shift_count: 1,
    open_shift_count: 0,
    invoices_count: 1,
    cafe_sales: 1000,
    wash_sales: 2000,
    subtotal: 3000,
    discounts: 0,
    service_charges: 0,
    total_sales: 3000,
    cash_sales: 1000,
    card_sales: 2000,
    credit_sales: 0,
    expenses: 0,
    cash_expenses: 0,
    expense_breakdown: [],
    cash: {
      opening_cash: 1000,
      cash_inflows: 1000,
      cash_outflows: 0,
      expected_cash: 2000,
      actual_cash: 2000,
      difference: 0,
      shortage: 0,
      surplus: 0,
      status: 'BALANCED',
    },
    included_shift_ids: [7],
    shifts: [closedShift],
  }
  const dayTotals = {
    invoices_count: 1,
    cafe_sales: 1000,
    wash_sales: 2000,
    subtotal: 3000,
    discounts: 0,
    service_charges: 0,
    total_sales: 3000,
    cash: 1000,
    card: 2000,
    credit: 0,
    expenses: 0,
  }
  const settlement = { business_day_id: 1, pending_shifts: [closedShift], totals: dayTotals }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dayReport.mockResolvedValue(day)
    mocks.previewDayClose.mockResolvedValue({ report: day, open_shifts: [], open_orders: 0 })
    mocks.previewDaySettlement.mockResolvedValue(settlement)
    mocks.daySettlementHistory.mockResolvedValue([])
    mocks.settleDay.mockResolvedValue({
      id: 4,
      business_day_id: 1,
      closed_by: 1,
      closed_at: '2026-09-24 23:00:00Z',
      shift_ids: [7],
      totals: dayTotals,
      final_snapshot: false,
    })
    mocks.closeDay.mockResolvedValue({ totals: dayTotals, report: day })
    mocks.printDay.mockResolvedValue({ duplicate_suppressed: false, job_id: 1 })
  })

  it('shows a recoverable load error and retries every reconciliation source', async () => {
    mocks.dayReport.mockRejectedValueOnce({ message: 'day.not_open' })
    render(
      <ToastProvider>
        <DayClosingPanel dayId={1} revision={0} onDone={vi.fn()} />
      </ToastProvider>,
    )
    expect(await screen.findByText('لا يوجد يوم عمل مفتوح')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }))
    expect(await screen.findByRole('button', { name: /مراجعة وتسوية الورديات/ })).toBeEnabled()
    expect(mocks.dayReport).toHaveBeenCalledTimes(2)
    expect(mocks.previewDaySettlement).toHaveBeenCalledTimes(2)
    expect(mocks.daySettlementHistory).toHaveBeenCalledTimes(2)
  })

  it('settles pending shifts before final closure and previews the selected day', async () => {
    mocks.printPreviewDay.mockResolvedValue({
      doc_type: 'DAY_REPORT',
      paper_mm: 80,
      width_chars: 42,
      ops: [
        { kind: 'text', text: 'تقرير يوم العمل', align: 'center', bold: true, width: 1, height: 1 },
      ],
    })
    render(
      <ToastProvider>
        <DayClosingPanel dayId={1} revision={0} onDone={vi.fn()} />
      </ToastProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /مراجعة وتسوية الورديات/ }))
    fireEvent.click(screen.getByRole('button', { name: /معاينة قبل الطباعة/ }))
    // The document title appears in the dialog subtitle AND on the rendered
    // paper, so assert both occurrences rather than assuming a single match.
    await waitFor(() => expect(screen.getAllByText('تقرير يوم العمل')).toHaveLength(2))
    expect(mocks.printPreviewDay).toHaveBeenCalledWith(1)
    expect(mocks.closeDay).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /تأكيد حفظ التسوية/ }))
    await waitFor(() => expect(mocks.settleDay).toHaveBeenCalledTimes(1))
    expect(mocks.closeDay).not.toHaveBeenCalled()
  })

  it('closes a fully reconciled day once and prints after financial commit', async () => {
    const onDone = vi.fn().mockResolvedValue(undefined)
    mocks.previewDaySettlement.mockResolvedValue({
      business_day_id: 1,
      pending_shifts: [],
      totals: dayTotals,
    })
    mocks.daySettlementHistory.mockResolvedValue([
      {
        id: 4,
        business_day_id: 1,
        closed_by: 1,
        closed_at: '2026-09-24 23:00:00Z',
        shift_ids: [7],
        totals: dayTotals,
        final_snapshot: false,
      },
    ])
    render(
      <ToastProvider>
        <DayClosingPanel dayId={1} revision={0} onDone={onDone} />
      </ToastProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /إغلاق يوم العمل/ }))
    const button = screen.getByRole('button', { name: /تأكيد تقفيل اليوم/ })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(mocks.closeDay).toHaveBeenCalledTimes(1))
    expect(mocks.settleDay).not.toHaveBeenCalled()
    expect(mocks.printDay).toHaveBeenCalledWith(1)
    expect(mocks.printDay.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.closeDay.mock.invocationCallOrder[0],
    )
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('does not print when the final backend guard rejects closure', async () => {
    mocks.previewDaySettlement.mockResolvedValue({
      business_day_id: 1,
      pending_shifts: [],
      totals: dayTotals,
    })
    mocks.closeDay.mockRejectedValue({ message: 'day.orders_open' })
    render(
      <ToastProvider>
        <DayClosingPanel dayId={1} revision={0} onDone={vi.fn()} />
      </ToastProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /إغلاق يوم العمل/ }))
    fireEvent.click(screen.getByRole('button', { name: /تأكيد تقفيل اليوم/ }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(mocks.printDay).not.toHaveBeenCalled()
  })

  // The day card is a POS panel, not an independent cache: the POS page bumps a
  // revision whenever it reloads POS state, and the panel must re-read its own
  // sources from that signal. Without it, a completed sale left the day totals
  // frozen until the user opened the dialog.
  it('reloads its reconciliation sources whenever the POS data revision changes', async () => {
    const updated = formatMinorMoney(999_900, { variant: 'auto' })
    const { rerender, container } = render(
      <ToastProvider>
        <DayClosingPanel dayId={1} revision={0} onDone={vi.fn()} />
      </ToastProvider>,
    )
    await screen.findByRole('button', { name: /مراجعة وتسوية الورديات/ })
    expect(container.textContent).not.toContain(updated)
    expect(mocks.dayReport).toHaveBeenCalledTimes(1)
    expect(mocks.previewDaySettlement).toHaveBeenCalledTimes(1)
    expect(mocks.daySettlementHistory).toHaveBeenCalledTimes(1)

    // A completed sale lands: the POS page refreshes and bumps the revision.
    mocks.dayReport.mockResolvedValue({
      ...day,
      total_sales: 999_900,
      cash_sales: 999_900,
    })
    mocks.previewDayClose.mockResolvedValue({
      report: { ...day, total_sales: 999_900, cash_sales: 999_900 },
      open_shifts: [],
      open_orders: 0,
    })
    rerender(
      <ToastProvider>
        <DayClosingPanel dayId={1} revision={1} onDone={vi.fn()} />
      </ToastProvider>,
    )

    await waitFor(() => expect(mocks.dayReport).toHaveBeenCalledTimes(2))
    expect(mocks.previewDaySettlement).toHaveBeenCalledTimes(2)
    expect(mocks.daySettlementHistory).toHaveBeenCalledTimes(2)
    // The card itself now shows the new figure — no dialog was ever opened.
    await waitFor(() => expect(container.textContent).toContain(updated))
  })

  it('does not reload when the revision is unchanged', async () => {
    const { rerender } = render(
      <ToastProvider>
        <DayClosingPanel dayId={1} revision={3} onDone={vi.fn()} />
      </ToastProvider>,
    )
    await screen.findByRole('button', { name: /مراجعة وتسوية الورديات/ })
    rerender(
      <ToastProvider>
        <DayClosingPanel dayId={1} revision={3} onDone={vi.fn()} />
      </ToastProvider>,
    )
    rerender(
      <ToastProvider>
        <DayClosingPanel dayId={1} revision={3} onDone={vi.fn()} />
      </ToastProvider>,
    )
    expect(mocks.dayReport).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Closing cards are ONE system with two identities: the same structure and the
// same spacing/typography system, expressed through two different semantic
// accent families from Station's centralized palette.
describe('closing card system', () => {
  const shiftRow: ShiftRow = {
    id: 7,
    business_day_id: 1,
    user_id: 2,
    user_name: 'Cashier One',
    user_role: 'STAFF',
    status: 'ACTIVE',
    opened_at: '2026-09-24 16:00:00Z',
    opening_cash: 1000,
    closed_at: null,
    cash_sales: 2000,
    card_sales: 3000,
    credit_sales: 500,
    service_charges: 0,
    discounts: 0,
    invoices_count: 3,
    expected_cash: 3000,
    actual_cash: null,
    cash_difference: null,
    cafe_invoices: 1,
    wash_invoices: 0,
    hybrid_invoices: 0,
    subtotal: 0,
    total_sales: 0,
    cafe_sales: 0,
    wash_sales: 0,
    expenses: 0,
    cash_expenses: 0,
  }
  const totals = {
    invoices_count: 1,
    cafe_sales: 1000,
    wash_sales: 2000,
    subtotal: 3000,
    discounts: 0,
    service_charges: 0,
    total_sales: 3000,
    cash: 3000,
    card: 0,
    credit: 0,
    expenses: 0,
  }

  // The day report, in the authoritative backend shape. The UI renders these
  // figures; it never derives them.
  const cardDay = {
    day: {
      id: 1,
      day_date: '2026-09-24',
      status: 'OPEN',
      opened_at: '2026-09-24T08:00:00Z',
      closed_at: null,
    },
    areas: { cafe_invoices: 1, wash_invoices: 0, hybrid_invoices: 0 },
    shift_count: 1,
    open_shift_count: 0,
    invoices_count: 1,
    cafe_sales: 1000,
    wash_sales: 2000,
    subtotal: 3000,
    discounts: 0,
    service_charges: 0,
    total_sales: 3000,
    cash_sales: 3000,
    card_sales: 0,
    credit_sales: 0,
    expenses: 0,
    cash_expenses: 0,
    expense_breakdown: [],
    cash: {
      opening_cash: 0,
      cash_inflows: 3000,
      cash_outflows: 0,
      expected_cash: 3000,
      actual_cash: 3000,
      difference: 0,
      shortage: 0,
      surplus: 0,
      status: 'BALANCED',
    },
    included_shift_ids: [shiftRow.id],
    shifts: [{ ...shiftRow, status: 'CLOSED', closed_at: '2026-09-24 23:00:00Z' }],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.previewShiftClose.mockResolvedValue({
      shift: shiftRow,
      closing_at: '2026-09-25 01:30:00Z',
      cash_sales: 2000,
      card_sales: 3000,
      credit_sales: 500,
      invoices_count: 3,
      expected_cash: 3000,
      cash_expenses: 0,
      expenses: 0,
      report: {
        shift: shiftRow,
        areas: { cafe_invoices: 1, wash_invoices: 0, hybrid_invoices: 0 },
        invoices_count: 3,
        cafe_sales: 2000,
        wash_sales: 0,
        subtotal: 3000,
        discounts: 0,
        service_charges: 0,
        total_sales: 3000,
        cash_sales: 2000,
        card_sales: 3000,
        credit_sales: 500,
        expenses: 0,
        cash_expenses: 0,
        expense_breakdown: [],
        cash: {
          opening_cash: 1000,
          cash_inflows: 2000,
          cash_outflows: 0,
          expected_cash: 3000,
          actual_cash: 0,
          difference: 0,
          shortage: 0,
          surplus: 0,
          status: 'BALANCED',
        },
      },
    })
    mocks.dayReport.mockResolvedValue(cardDay)
    mocks.previewDayClose.mockResolvedValue({ report: cardDay, open_shifts: [], open_orders: 0 })
    mocks.previewDaySettlement.mockResolvedValue({
      business_day_id: 1,
      pending_shifts: [],
      totals,
    })
    mocks.daySettlementHistory.mockResolvedValue([])
  })

  afterEach(() => resetFormattingPreferences())

  it('gives both cards the same structure with distinct accent identities', async () => {
    const { container } = render(
      <ToastProvider>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <CurrentShiftPanel shift={shiftRow} onClosed={vi.fn()} />
          <DayClosingPanel dayId={1} revision={0} onDone={vi.fn()} />
        </div>
      </ToastProvider>,
    )
    await screen.findByRole('button', { name: /إغلاق يوم العمل/ })

    const cards = container.querySelectorAll('[data-closing]')
    expect(cards).toHaveLength(2)
    const [shiftCard, dayCard] = Array.from(cards)
    expect(shiftCard).toHaveAttribute('data-closing', 'shift')
    expect(dayCard).toHaveAttribute('data-closing', 'day')

    // Same structure: identity rail, title, primary metric, metric grid and a
    // single action — with only the accent family differing.
    const parts = (el: Element) => ({
      rail: el.querySelector('[aria-hidden="true"]')?.className ?? '',
      primary: el.querySelector('section')?.className ?? '',
    })
    const shift = parts(shiftCard)
    const day = parts(dayCard)
    expect(shift.rail.replaceAll('closing-shift', 'closing-X')).toBe(
      day.rail.replaceAll('closing-day', 'closing-X'),
    )
    expect(shift.primary.replaceAll('closing-shift', 'closing-X')).toBe(
      day.primary.replaceAll('closing-day', 'closing-X'),
    )

    // Distinct, intentional identities, taken from Station's tokens only.
    expect(shift.rail).toContain('bg-closing-shift-soft')
    expect(day.rail).toContain('bg-closing-day-soft')
    expect(shift.primary).toContain('bg-closing-shift-soft')
    expect(day.primary).toContain('bg-closing-day-soft')

    // No card introduces a raw palette value: every accent class on the accent
    // surfaces is a Station `closing-*` semantic token behind a utility prefix.
    const accentClasses = [shift.rail, day.rail, shift.primary, day.primary]
      .join(' ')
      .split(/\s+/)
      .filter((cls) => cls.includes('closing-'))
    expect(accentClasses.length).toBeGreaterThan(0)
    for (const cls of accentClasses) {
      expect(cls).toMatch(/^(bg|text|border)-(closing-(shift|day)(-(soft|foreground|border))?)$/)
    }
  })
})
