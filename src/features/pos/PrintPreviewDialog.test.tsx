/**
 * Print preview + reprint contract:
 *  - the preview is read-only (only the preview_* command is called),
 *  - reprint calls the EXISTING print command with the SAME document id,
 *  - nothing is created or mutated, reprint is blocked while printing,
 *  - backend errors surface with a retry.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import '@/lib/i18n'
import type { PrintPreview } from '@/services/posApi'
import { PrintPreviewDialog } from './PrintPreviewDialog'

const mocks = vi.hoisted(() => ({
  printPreviewInvoice: vi.fn(),
  printPreviewTicket: vi.fn(),
  printPreviewShift: vi.fn(),
  printPreviewDay: vi.fn(),
  printInvoice: vi.fn(),
  printTicket: vi.fn(),
}))

vi.mock('@/services/posApi', async (importOriginal) => ({
  // Partial mock: the real payload guard (`isPrintPreview`) stays in place, only
  // the commands the dialog drives are replaced.
  ...(await importOriginal<typeof import('@/services/posApi')>()),
  api: {
    printPreviewInvoice: mocks.printPreviewInvoice,
    printPreviewTicket: mocks.printPreviewTicket,
    printPreviewShift: mocks.printPreviewShift,
    printPreviewDay: mocks.printPreviewDay,
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

  it('is disabled until the document arrives and surfaces a typed business reason with a retry', async () => {
    mocks.printPreviewInvoice.mockRejectedValueOnce({ message: 'wash.ticket_not_issued' })
    mocks.printPreviewInvoice.mockResolvedValueOnce(preview('CAFE_INVOICE', 'فاتورة رقم 1001'))

    renderDialog({ kind: 'invoice', invoice_id: 1001 })

    // The calm, document-neutral headline is the primary message; the specific
    // translated business reason is context underneath it.
    expect(await screen.findByText('تعذر عرض المعاينة')).toBeInTheDocument()
    expect(screen.getByText('لم تُصدر تذكرة مغسلة لهذا الطلب بعد')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    // headline + explanation + the specific translated reason, and nothing else.
    expect(screen.getByRole('alert').querySelectorAll('p')).toHaveLength(2)
    expect(screen.getByRole('button', { name: /إعادة طبع/ })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /إعادة المحاولة/ }))
    expect(await screen.findByText('فاتورة رقم 1001')).toBeInTheDocument()
    expect(mocks.printPreviewInvoice).toHaveBeenCalledTimes(2)
  })

  it('never leaks a raw backend message into the error state', async () => {
    // An unmapped code must degrade to generic copy, not surface the raw value,
    // and must not add a technical "detail" line either.
    mocks.printPreviewInvoice.mockRejectedValueOnce({
      message: 'rusqlite_query_failed_at_line_4122',
    })

    renderDialog({ kind: 'invoice', invoice_id: 1001 })

    expect(await screen.findByText('تعذر عرض المعاينة')).toBeInTheDocument()
    expect(
      screen.getByText(
        'حدثت مشكلة أثناء تجهيز المعاينة. حاول مرة أخرى، وإذا استمرت المشكلة يمكنك المتابعة بدون المعاينة.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/rusqlite_query_failed_at_line_4122/)).not.toBeInTheDocument()
    // No half-translated key and no technical sub-line either: without a mapped
    // code the alert carries only the headline and its explanation.
    const alert = screen.getByRole('alert')
    expect(alert).not.toHaveTextContent('errors.')
    expect(alert.querySelectorAll('p')).toHaveLength(1)
  })

  it('shows a document-shaped loading state instead of the empty state while fetching', async () => {
    let release: (value: unknown) => void = () => {}
    mocks.printPreviewInvoice.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )

    renderDialog({ kind: 'invoice', invoice_id: 1001 })

    const status = screen.getByRole('status', { name: 'جارٍ تجهيز المعاينة' })
    expect(status).toHaveAttribute('aria-busy', 'true')
    // Loading must never be confused with "there is no document", nor with a
    // failure that has not happened yet.
    expect(screen.queryByText('لا توجد فاتورة للمعاينة')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    release(preview('CAFE_INVOICE', 'فاتورة رقم 1001'))
    expect(await screen.findByText('فاتورة رقم 1001')).toBeInTheDocument()
  })

  it('shows the empty state — not the error state — when the document has nothing to print', async () => {
    mocks.printPreviewInvoice.mockResolvedValue({
      doc_type: 'CAFE_INVOICE',
      paper_mm: 80,
      width_chars: 42,
      ops: [],
    })

    renderDialog({ kind: 'invoice', invoice_id: 1001 })

    expect(await screen.findByText('لا توجد فاتورة للمعاينة')).toBeInTheDocument()
    expect(screen.getByText('لا تتوفر بيانات فاتورة يمكن عرضها حالياً.')).toBeInTheDocument()
    // Distinct from the failure state, and announced as ordinary information.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('تعذر عرض المعاينة')).not.toBeInTheDocument()
  })
  it('names the document that came back empty — a report never reads as an invoice', async () => {
    const empty = (doc_type: string) => ({
      doc_type,
      paper_mm: 80,
      width_chars: 42,
      ops: [],
    })
    mocks.printPreviewShift.mockResolvedValue(empty('SHIFT_REPORT'))
    mocks.printPreviewDay.mockResolvedValue(empty('DAY_REPORT'))
    mocks.printPreviewTicket.mockResolvedValue(empty('WASH_TICKET'))

    const { unmount } = render(
      <ToastProvider>
        <PrintPreviewDialog target={{ kind: 'shift_report', shift_id: 7 }} onClose={vi.fn()} />
      </ToastProvider>,
    )
    expect(await screen.findByText('لا يوجد تقرير للمعاينة')).toBeInTheDocument()
    expect(screen.getByText('لا تتوفر بيانات تقرير يمكن عرضها حالياً.')).toBeInTheDocument()
    unmount()

    render(
      <ToastProvider>
        <PrintPreviewDialog target={{ kind: 'day_report', day_id: 1 }} onClose={vi.fn()} />
      </ToastProvider>,
    )
    expect(await screen.findByText('لا يوجد تقرير للمعاينة')).toBeInTheDocument()
    expect(screen.queryByText('لا توجد فاتورة للمعاينة')).not.toBeInTheDocument()
    unmount()

    render(
      <ToastProvider>
        <PrintPreviewDialog target={{ kind: 'wash_ticket', order_id: 9 }} onClose={vi.fn()} />
      </ToastProvider>,
    )
    expect(await screen.findByText('لا توجد تذكرة للمعاينة')).toBeInTheDocument()
  })

  it('treats a malformed or missing payload as a failure, never as an empty document', async () => {
    // A broken payload is a backend bug: showing "nothing to preview" would hide
    // it, and rendering it would crash the receipt renderer.
    const payloads = [
      undefined,
      null,
      { doc_type: 'CAFE_INVOICE' },
      { doc_type: 'CAFE_INVOICE', paper_mm: 80, width_chars: 42, ops: null },
    ]

    for (const payload of payloads) {
      mocks.printPreviewInvoice.mockResolvedValueOnce(payload)
      const { unmount } = render(
        <ToastProvider>
          <PrintPreviewDialog target={{ kind: 'invoice', invoice_id: 1001 }} onClose={vi.fn()} />
        </ToastProvider>,
      )

      expect(await screen.findByText('تعذر عرض المعاينة')).toBeInTheDocument()
      expect(screen.getByText('بيانات المعاينة غير صالحة — أعد المحاولة')).toBeInTheDocument()
      expect(screen.queryByText('لا توجد فاتورة للمعاينة')).not.toBeInTheDocument()
      unmount()
    }
  })
  it('retries exactly once, shows loading in between, and drops the stale error', async () => {
    mocks.printPreviewInvoice.mockRejectedValueOnce({ message: 'invoice.not_found' })
    let release: (value: unknown) => void = () => {}
    mocks.printPreviewInvoice.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )

    renderDialog({ kind: 'invoice', invoice_id: 1001 })

    fireEvent.click(await screen.findByRole('button', { name: /إعادة المحاولة/ }))

    // The error is replaced immediately: the retry control disappears with it,
    // so the same failure cannot be requested twice.
    await screen.findByRole('status', { name: 'جارٍ تجهيز المعاينة' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(mocks.printPreviewInvoice).toHaveBeenCalledTimes(2)

    release(preview('CAFE_INVOICE', 'فاتورة رقم 1001'))
    expect(await screen.findByText('فاتورة رقم 1001')).toBeInTheDocument()
    expect(screen.queryByText('تعذر عرض المعاينة')).not.toBeInTheDocument()
    expect(mocks.printPreviewInvoice).toHaveBeenCalledTimes(2)
  })

  it('never lets a stale answer paint over a newly selected document', async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    mocks.printPreviewInvoice.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve
      }),
    )
    mocks.printPreviewInvoice.mockResolvedValue(preview('CAFE_INVOICE', 'فاتورة رقم 2002'))

    const { rerender } = render(
      <ToastProvider>
        <PrintPreviewDialog target={{ kind: 'invoice', invoice_id: 1001 }} onClose={vi.fn()} />
      </ToastProvider>,
    )
    // Switch target while the first document is still loading.
    rerender(
      <ToastProvider>
        <PrintPreviewDialog target={{ kind: 'invoice', invoice_id: 2002 }} onClose={vi.fn()} />
      </ToastProvider>,
    )

    expect(await screen.findByText('فاتورة رقم 2002')).toBeInTheDocument()

    // The abandoned answer for document A must be discarded, not rendered.
    resolveFirst(preview('CAFE_INVOICE', 'فاتورة رقم 1001'))
    await waitFor(() => expect(mocks.printPreviewInvoice).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('فاتورة رقم 1001')).not.toBeInTheDocument()
    expect(screen.getByText('فاتورة رقم 2002')).toBeInTheDocument()
  })

  it('reloads the current target after the document changed under an open dialog', async () => {
    mocks.printPreviewInvoice.mockRejectedValueOnce({ message: 'invoice.not_found' })
    mocks.printPreviewInvoice.mockResolvedValue(preview('CAFE_INVOICE', 'فاتورة رقم 2002'))

    const { rerender } = render(
      <ToastProvider>
        <PrintPreviewDialog target={{ kind: 'invoice', invoice_id: 1001 }} onClose={vi.fn()} />
      </ToastProvider>,
    )
    await screen.findByRole('alert')

    rerender(
      <ToastProvider>
        <PrintPreviewDialog target={{ kind: 'invoice', invoice_id: 2002 }} onClose={vi.fn()} />
      </ToastProvider>,
    )

    expect(await screen.findByText('فاتورة رقم 2002')).toBeInTheDocument()
    await waitFor(() => expect(mocks.printPreviewInvoice).toHaveBeenCalledTimes(2))
    // The reload belonged to invoice 2002, never to the abandoned 1001.
    expect(mocks.printPreviewInvoice).toHaveBeenLastCalledWith(2002)
  })

  it('drops an in-flight answer when the dialog is closed', async () => {
    let release: (value: unknown) => void = () => undefined
    mocks.printPreviewInvoice.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )

    const { unmount } = render(
      <ToastProvider>
        <PrintPreviewDialog target={{ kind: 'invoice', invoice_id: 1001 }} onClose={vi.fn()} />
      </ToastProvider>,
    )
    await screen.findByRole('status')
    unmount()

    // Nothing may be written into a closed dialog.
    release(preview('CAFE_INVOICE', 'فاتورة رقم 1001'))
    await waitFor(() => expect(mocks.printPreviewInvoice).toHaveBeenCalledTimes(1))
  })
})

/**
 * The preview's RESPONSIVE contract — the shell it is shown in, the single
 * scroll owner, and the fit between a fixed 80mm paper and a phone's width.
 *
 * These are the assertions that were missing when the document was drawn at a
 * constant 1.3 (2 expanded) inside a box that can offer it ~280px on a 360px
 * phone: the paper overflowed and the viewer clipped it, so both sides of every
 * invoice were unreachable rather than merely scrolled.
 */
describe('PrintPreviewDialog on a narrow viewport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.printPreviewInvoice.mockResolvedValue(preview('CAFE_INVOICE', 'فاتورة رقم 1001'))
  })

  /** The dialog shell: the element that owns the dialog's own measurements. */
  async function shell() {
    render(
      <ToastProvider>
        <PrintPreviewDialog target={{ kind: 'invoice', invoice_id: 1001 }} onClose={vi.fn()} />
      </ToastProvider>,
    )
    await screen.findByText('فاتورة رقم 1001')
    return screen.getByRole('dialog')
  }

  it('is a near-full-width sheet with real margins, not a fixed pixel width', async () => {
    const dialog = await shell()

    // `w-[min(calc(100vw-1rem),30rem)]`: the width is derived from the viewport
    // and capped, so a 320px phone and a desktop both get a sensible dialog and
    // no hardcoded measurement can push it past the screen edge.
    expect(dialog.className).toContain('w-[min(calc(100vw-1rem),30rem)]')
    // The shared dialog's own phone sheet behaviour, including `dvh` rather than
    // `vh`, is still what bounds it.
    expect(dialog.className).toContain('max-h-[92dvh]')
    expect(dialog.className).not.toContain('100vh')
  })

  it('makes fullscreen a true viewport-filling surface on a phone', async () => {
    const dialog = await shell()
    fireEvent.click(screen.getByRole('button', { name: 'توسيع المعاينة' }))

    // Below `sm` the surface stops being a sheet: no side margin, no rounded
    // top, no border, and the full dynamic viewport height…
    expect(dialog.className).toContain('max-w-none')
    expect(dialog.className).toContain('max-h-dvh')
    expect(dialog.className).toContain('rounded-none')
    expect(dialog.className).toContain('border-0')
    // …with the top safe-area inset respected, so the header clears a notch.
    expect(dialog.className).toContain('pt-[env(safe-area-inset-top)]')
    // …and the desktop measurement is explicitly restored from `sm` up, so the
    // fullscreen feature on a desktop is untouched by the phone treatment.
    expect(dialog.className).toContain('sm:max-w-2xl')
    expect(dialog.className).toContain('sm:max-h-[calc(100dvh-1rem)]')
    expect(dialog.className).toContain('sm:rounded-lg')
  })

  it('has exactly one scroll owner: the dialog, not the document frame', async () => {
    await shell()
    const viewer = screen.getByTestId('print-preview-viewer')

    // The viewer used to declare itself a scroll container with no height to
    // scroll in, inside a dialog that already scrolls — two owners for one
    // document. It is a frame now, and the clipping is a rounding guard only.
    expect(viewer.className).not.toContain('overflow-y-auto')
    expect(viewer.className).toContain('overflow-x-hidden')
    expect(viewer.className).toContain('min-w-0')
    // The dialog is the single owner, exactly as every other dialog in the app.
    expect(screen.getByRole('dialog').className).toContain('overflow-y-auto')
  })

  it('keeps close and expand reachable in the header while the document scrolls', async () => {
    await shell()

    // Both controls are in the sticky header — the one part of the dialog that
    // does not scroll away — and neither can be squeezed by the Arabic title.
    // Scoped to the header, because the footer carries a "close" action too and
    // only the header's is the always-reachable one.
    const heading = screen.getByRole('heading', { name: 'معاينة الطباعة' })
    const header = within(heading.parentElement as HTMLElement)
    const expand = header.getByRole('button', { name: 'توسيع المعاينة' })
    const close = header.getByRole('button', { name: 'إغلاق' })
    expect(expand.className).toContain('shrink-0')
    expect(heading.className).toContain('min-w-0')
    // Focus behaviour is unchanged by the control moving: the dialog's own
    // dismiss control is still where focus lands on opening.
    expect(close).toHaveFocus()
    // …and the control is still operable by keyboard from there.
    expand.focus()
    fireEvent.click(expand)
    expect(header.getByRole('button', { name: 'تصغير المعاينة' })).toBeInTheDocument()
  })

  it('fits the fixed 80mm paper into the width actually on screen', async () => {
    // jsdom has no layout, so the measured width is stubbed the way a 360px
    // phone's centering row would report it. The scale has to follow it —
    // otherwise the document is drawn wider than the box and clipped.
    const available = 280
    const spy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(available)
    try {
      await shell()
      const scaling = screen.getByTestId('print-preview-scaling')
      const paper = screen.getByLabelText('معاينة الإيصال الحراري')

      // The paper is STILL 80mm — the fit scales the document, it never resizes
      // the paper or anything the printer is told.
      expect(paper.style.width).toBe('80mm')
      const scale = Number(scaling.getAttribute('data-preview-scale'))
      expect(scale).toBeLessThan(1.3)
      expect(80 * (96 / 25.4) * scale).toBeLessThanOrEqual(available)
    } finally {
      spy.mockRestore()
    }
  })
})
