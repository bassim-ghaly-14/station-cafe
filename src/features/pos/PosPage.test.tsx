/**
 * Table lifecycle + takeaway UX (safe card click, explicit mutations).
 * The card container selects/inspects only; open/start/close/takeaway mutate.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import '@/lib/i18n'
import PosPage, { TableCard } from './PosPage'
import type { TableView } from '@/services/posApi'

const mocks = vi.hoisted(() => ({
  tables: vi.fn(),
  openTable: vi.fn(),
  closeEmptyTable: vi.fn(),
  startOrder: vi.fn(),
  startTakeaway: vi.fn(),
  discardOrder: vi.fn(),
  getOrder: vi.fn(),
  preview: vi.fn(),
  state: vi.fn(),
}))

vi.mock('@/services/posApi', () => ({
  api: {
    tables: mocks.tables,
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
    readyToPay: vi.fn(),
    products: vi.fn().mockResolvedValue([]),
    checkout: vi.fn(),
    printInvoice: vi.fn(),
    ticket: vi.fn(),
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

function renderCard(tv: TableView) {
  return render(
    <ToastProvider>
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
    expect(screen.queryByRole('button', { name: /إغلاق بدون طلب/ })).not.toBeInTheDocument()
    unmount()

    renderCard(table({ status: 'OPEN', session_id: 7 }))
    fireEvent.click(screen.getByRole('button', { name: /بدء طلب/ }))
    expect(mocks.startOrder).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /إغلاق بدون طلب/ })).toBeInTheDocument()
  })

  it('occupied card never offers Close Empty', () => {
    renderCard(table({ status: 'OCCUPIED', order_id: 9 }))
    expect(screen.getByRole('button', { name: /فتح الطلب/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /إغلاق بدون طلب/ })).not.toBeInTheDocument()
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
      lines: [],
    })
    mocks.preview.mockResolvedValue(null)
    mocks.startTakeaway.mockResolvedValue(5)
  })

  it('takeaway entry point starts a table-less order without opening a table', async () => {
    render(
      <ToastProvider>
        <PosPage />
      </ToastProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /طلب تيك أواي جديد/ }))
    await waitFor(() => expect(mocks.startTakeaway).toHaveBeenCalledTimes(1))
    expect(mocks.openTable).not.toHaveBeenCalled()
    expect(mocks.startOrder).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('طلب تيك أواي نشط')).toBeInTheDocument())
  })
})
