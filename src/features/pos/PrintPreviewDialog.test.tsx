/**
 * Print preview + reprint contract:
 *  - the preview is read-only (only the preview_* command is called),
 *  - reprint calls the EXISTING print command with the SAME document id,
 *  - nothing is created or mutated, reprint is blocked while printing,
 *  - backend errors surface with a retry.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import '@/lib/i18n'
import type { PrintPreview } from '@/services/posApi'
import { PrintPreviewDialog } from './PrintPreviewDialog'

const mocks = vi.hoisted(() => ({
  printPreviewInvoice: vi.fn(),
  printPreviewTicket: vi.fn(),
  printInvoice: vi.fn(),
  printTicket: vi.fn(),
}))

vi.mock('@/services/posApi', () => ({
  api: {
    printPreviewInvoice: mocks.printPreviewInvoice,
    printPreviewTicket: mocks.printPreviewTicket,
    printInvoice: mocks.printInvoice,
    printTicket: mocks.printTicket,
  },
}))

function preview(docType: string, text: string): PrintPreview {
  return {
    doc_type: docType,
    paper_mm: 80,
    width_chars: 42,
    ops: [
      { kind: 'text', text, align: 'right', bold: false, width: 1, height: 1 },
      { kind: 'cut' },
    ],
  }
}

function renderDialog(target: Parameters<typeof PrintPreviewDialog>[0]['target']) {
  const onClose = vi.fn()
  render(
    <ToastProvider>
      <PrintPreviewDialog target={target} onClose={onClose} />
    </ToastProvider>,
  )
  return onClose
}

const outcome = {
  doc_type: 'CAFE_INVOICE',
  target: 'share:XP80',
  bytes: 512,
  duplicate_suppressed: false,
}

describe('PrintPreviewDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('expands the receipt preview itself without changing the logical paper', async () => {
    mocks.printPreviewInvoice.mockResolvedValue(preview('CAFE_INVOICE', 'فاتورة رقم 1001'))

    renderDialog({ kind: 'invoice', invoice_id: 1001 })
    await screen.findByText('فاتورة رقم 1001')
    const paper = screen.getByLabelText('معاينة الإيصال الحراري')
    const viewer = screen.getByTestId('print-preview-viewer')
    const centering = screen.getByTestId('print-preview-centering')
    const scaling = screen.getByTestId('print-preview-scaling')
    expect(paper.style.width).toBe('80mm')
    expect(paper).toHaveAttribute('data-width-chars', '42')
    expect(scaling).toHaveAttribute('data-preview-scale', '1.3')
    expect(scaling.style.zoom).toBe('1.3')
    expect(scaling).toContainElement(paper)
    expect(viewer).toHaveAttribute('dir', 'ltr')
    expect(centering).toHaveAttribute('dir', 'ltr')
    expect(centering).toHaveClass('justify-center')

    fireEvent.click(screen.getByRole('button', { name: 'توسيع المعاينة' }))
    expect(screen.getByRole('button', { name: 'تصغير المعاينة' })).toBeInTheDocument()
    expect(paper.style.width).toBe('80mm')
    expect(scaling).toHaveAttribute('data-preview-scale', '2')
    expect(scaling.style.zoom).toBe('2')
    expect(scaling).toContainElement(paper)

    fireEvent.click(screen.getByRole('button', { name: 'تصغير المعاينة' }))
    expect(screen.getByRole('button', { name: 'توسيع المعاينة' })).toBeInTheDocument()
    expect(paper.style.width).toBe('80mm')
    expect(scaling).toHaveAttribute('data-preview-scale', '1.3')
    expect(scaling.style.zoom).toBe('1.3')
  })

  it('keeps the paper centered when the application context is RTL', async () => {
    mocks.printPreviewInvoice.mockResolvedValue(preview('CAFE_INVOICE', 'فاتورة رقم 1001'))

    render(
      <div dir="rtl">
        <ToastProvider>
          <PrintPreviewDialog target={{ kind: 'invoice', invoice_id: 1001 }} onClose={vi.fn()} />
        </ToastProvider>
      </div>,
    )

    await screen.findByText('فاتورة رقم 1001')
    const viewer = screen.getByTestId('print-preview-viewer')
    const paper = screen.getByLabelText('معاينة الإيصال الحراري')
    const centering = screen.getByTestId('print-preview-centering')
    expect(viewer).toHaveAttribute('dir', 'ltr')
    expect(centering).toHaveClass('justify-center')
    expect(paper).not.toHaveClass('ml-', 'mr-', 'translate-x-')
  })

  it('previews a persisted invoice and reprints that same invoice id', async () => {
    mocks.printPreviewInvoice.mockResolvedValue(preview('CAFE_INVOICE', 'فاتورة رقم 1001'))
    mocks.printInvoice.mockResolvedValue(outcome)

    renderDialog({ kind: 'invoice', invoice_id: 1001 })

    expect(await screen.findByText('فاتورة رقم 1001')).toBeInTheDocument()
    expect(mocks.printPreviewInvoice).toHaveBeenCalledWith(1001)
    // Previewing must never print or create anything.
    expect(mocks.printInvoice).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /إعادة طبع/ }))

    await waitFor(() => expect(mocks.printInvoice).toHaveBeenCalledWith(1001))
    expect(mocks.printInvoice).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('تم إرسال الطباعة')).toBeInTheDocument()
  })

  it('reports duplicate-suppressed reprints using the existing message', async () => {
    mocks.printPreviewInvoice.mockResolvedValue(preview('CAFE_INVOICE', 'فاتورة رقم 1001'))
    mocks.printInvoice.mockResolvedValue({ ...outcome, duplicate_suppressed: true })

    renderDialog({ kind: 'invoice', invoice_id: 1001 })
    fireEvent.click(await screen.findByRole('button', { name: /إعادة طبع/ }))

    expect(await screen.findByText('تم منع طباعة مكررة (نفس المستند)')).toBeInTheDocument()
  })

  it('previews and reprints an issued wash ticket by order id', async () => {
    mocks.printPreviewTicket.mockResolvedValue(preview('WASH_TICKET', 'رقم الانتظار'))
    mocks.printTicket.mockResolvedValue({ ...outcome, doc_type: 'WASH_TICKET' })

    renderDialog({ kind: 'wash_ticket', order_id: 9 })

    expect(await screen.findByText('رقم الانتظار')).toBeInTheDocument()
    expect(await screen.findByText('تذكرة مغسلة سيارة')).toBeInTheDocument()
    expect(mocks.printPreviewTicket).toHaveBeenCalledWith(9)

    fireEvent.click(screen.getByRole('button', { name: /إعادة طبع/ }))
    await waitFor(() => expect(mocks.printTicket).toHaveBeenCalledWith(9))
    expect(mocks.printPreviewInvoice).not.toHaveBeenCalled()
  })

  it('blocks reprint while the print operation is in flight', async () => {
    mocks.printPreviewInvoice.mockResolvedValue(preview('CAFE_INVOICE', 'فاتورة رقم 1001'))
    let release: (value: unknown) => void = () => {}
    mocks.printInvoice.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )

    renderDialog({ kind: 'invoice', invoice_id: 1001 })
    fireEvent.click(await screen.findByRole('button', { name: /إعادة طبع/ }))

    const busy = screen.getByRole('button', { name: /جارٍ التحميل|إعادة طبع/ })
    await waitFor(() => expect(busy).toBeDisabled())
    release(outcome)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /إعادة طبع/ })).not.toBeDisabled(),
    )
  })

  it('is disabled until the document arrives and surfaces backend errors with a retry', async () => {
    mocks.printPreviewInvoice.mockRejectedValueOnce({ message: 'wash.ticket_not_issued' })
    mocks.printPreviewInvoice.mockResolvedValueOnce(preview('CAFE_INVOICE', 'فاتورة رقم 1001'))

    renderDialog({ kind: 'invoice', invoice_id: 1001 })

    expect(await screen.findByText('لم تُصدر تذكرة مغسلة لهذا الطلب بعد')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /إعادة طبع/ })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /إعادة المحاولة/ }))
    expect(await screen.findByText('فاتورة رقم 1001')).toBeInTheDocument()
    expect(mocks.printPreviewInvoice).toHaveBeenCalledTimes(2)
  })
})
