/**
 * Print status panel contract.
 *
 * The panel is a presentation layer over the printing service: it must show the
 * recorded jobs with human-readable Arabic names, distinguish "printer not
 * configured" from an actual print failure, and never render a backend
 * identifier (document type, status code or `printer.*` error key).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import '@/lib/i18n'
import type { PrintConfig, PrintJobRow } from '@/services/opsApi'
import { PrintStatusPanel } from './PrintStatusPanel'

const mocks = vi.hoisted(() => ({
  printJobs: vi.fn(),
  printConfig: vi.fn(),
  printTest: vi.fn(),
}))

vi.mock('@/services/opsApi', () => ({
  opsApi: {
    printJobs: mocks.printJobs,
    printConfig: mocks.printConfig,
    printTest: mocks.printTest,
  },
}))

function job(over: Partial<PrintJobRow> = {}): PrintJobRow {
  return {
    id: 41,
    doc_type: 'CAFE_INVOICE',
    status: 'PRINTED',
    attempts: 1,
    error: null,
    created_at: '2026-09-25 14:30:00',
    // Exact shape the printing service stores/returns.
    ...over,
  }
}

function renderPanel() {
  return render(
    <div dir="rtl">
      <ToastProvider>
        <PrintStatusPanel />
      </ToastProvider>
    </div>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.printJobs.mockResolvedValue([])
  mocks.printConfig.mockResolvedValue({
    target: 'share:XP80',
    arabic_mode: 'CP1256',
    codepage: 22,
    logo: true,
    duplicate_window_secs: 60,
  } satisfies PrintConfig)
  mocks.printTest.mockResolvedValue({
    doc_type: 'TEST',
    target: 'share:XP80',
    bytes: 128,
    duplicate_suppressed: false,
  })
})

describe('PrintStatusPanel', () => {
  it('loads the recorded jobs and the existing printer configuration', async () => {
    renderPanel()
    await waitFor(() => expect(mocks.printJobs).toHaveBeenCalledWith(30))
    expect(mocks.printConfig).toHaveBeenCalledTimes(1)
  })

  it('renders a recorded job with a human-readable document name and status', async () => {
    mocks.printJobs.mockResolvedValue([job()])
    const { container } = renderPanel()
    expect(await screen.findByText('فاتورة كافيه')).toBeInTheDocument()
    expect(screen.getByText('تمت الطباعة')).toBeInTheDocument()
    expect(screen.getByText('عدد المحاولات:')).toBeInTheDocument()
    expect(container.textContent).not.toContain('CAFE_INVOICE')
    expect(container.textContent).not.toContain('PRINTED')
  })

  it('names every document type instead of showing its code', async () => {
    mocks.printJobs.mockResolvedValue([
      job({ id: 5, doc_type: 'TAKEAWAY_INVOICE' }),
      job({ id: 4, doc_type: 'WASH_TICKET' }),
      job({ id: 3, doc_type: 'SHIFT_REPORT' }),
      job({ id: 2, doc_type: 'DAY_REPORT' }),
      job({ id: 1, doc_type: 'TEST' }),
    ])
    const { container } = renderPanel()

    expect(await screen.findByText('إيصال طلب خارجي')).toBeInTheDocument()
    expect(screen.getByText('تذكرة مغسلة سيارة')).toBeInTheDocument()
    expect(screen.getByText('تقرير وردية')).toBeInTheDocument()
    expect(screen.getByText('تقرير يوم العمل')).toBeInTheDocument()
    expect(screen.getByText('صفحة اختبار الطباعة')).toBeInTheDocument()
    for (const code of ['TAKEAWAY_INVOICE', 'WASH_TICKET', 'SHIFT_REPORT', 'DAY_REPORT', 'TEST']) {
      expect(container.textContent).not.toContain(code)
    }
  })

  it('explains a failed print in Arabic without exposing the recorded error key', async () => {
    mocks.printJobs.mockResolvedValue([
      job({ status: 'FAILED', attempts: 2, error: 'printer error: printer.not_configured' }),
    ])
    const { container } = renderPanel()

    expect(await screen.findByText('فشلت الطباعة')).toBeInTheDocument()
    expect(screen.getByText('لم يتم إعداد الطابعة بعد')).toBeInTheDocument()
    expect(container.textContent).not.toContain('printer.not_configured')
    expect(container.textContent).not.toContain('printer error')
  })

  it('still gives a reason when a failed job recorded no error', async () => {
    mocks.printJobs.mockResolvedValue([job({ status: 'FAILED', error: null })])
    renderPanel()

    expect(await screen.findByText('حدث خطأ أثناء الطباعة.')).toBeInTheDocument()
  })

  it('degrades unmapped values to safe localized text instead of raw codes', async () => {
    mocks.printJobs.mockResolvedValue([
      job({ doc_type: 'SOME_FUTURE_DOC', status: 'PRINT_FAILED' }),
    ])
    const { container } = renderPanel()

    expect(await screen.findByText('مستند طباعة')).toBeInTheDocument()
    expect(screen.getByText('حالة غير معروفة')).toBeInTheDocument()
    expect(container.textContent).not.toContain('SOME_FUTURE_DOC')
    expect(container.textContent).not.toContain('PRINT_FAILED')
  })

  it('supports a job that is still awaiting the printer', async () => {
    mocks.printJobs.mockResolvedValue([job({ status: 'PENDING' })])
    renderPanel()

    expect(await screen.findByText('بانتظار الطباعة')).toBeInTheDocument()
    expect(screen.getByText('لم تصدر نتيجة لهذه العملية بعد')).toBeInTheDocument()
  })

  it('keeps the numeric job reference laid out left-to-right inside RTL text', async () => {
    mocks.printJobs.mockResolvedValue([job({ id: 77 })])
    renderPanel()

    const reference = await screen.findByText('#77')
    expect(reference).toHaveAttribute('dir', 'ltr')
  })

  it('holds the loading layout until the jobs resolve', async () => {
    let resolveJobs: ((rows: PrintJobRow[]) => void) | undefined
    mocks.printJobs.mockReturnValue(
      new Promise<PrintJobRow[]>((done) => {
        resolveJobs = done
      }),
    )
    renderPanel()

    expect(screen.getByLabelText('جارٍ تحميل الجدول')).toBeInTheDocument()
    expect(screen.queryByText('لا توجد عمليات طباعة بعد')).not.toBeInTheDocument()

    resolveJobs?.([])
    expect(await screen.findByText('لا توجد عمليات طباعة بعد')).toBeInTheDocument()
  })

  it('shows the empty state when no job was ever recorded', async () => {
    renderPanel()
    expect(await screen.findByText('لا توجد عمليات طباعة بعد')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('surfaces a job-history failure with a retry instead of fabricating rows', async () => {
    mocks.printJobs.mockRejectedValueOnce({ message: 'internal_error' })
    mocks.printJobs.mockResolvedValueOnce([job()])
    renderPanel()

    expect(
      await within(await screen.findByRole('alert')).findByText('حدث خطأ غير متوقع، حاول مرة أخرى'),
    ).toBeInTheDocument()
    expect(mocks.printJobs).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /إعادة المحاولة/ }))
    expect(await screen.findByText('فاتورة كافيه')).toBeInTheDocument()
    expect(mocks.printJobs).toHaveBeenCalledTimes(2)
  })

  it('reloads the recorded jobs on demand', async () => {
    renderPanel()
    await waitFor(() => expect(mocks.printJobs).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'تحديث' }))

    await waitFor(() => expect(mocks.printJobs).toHaveBeenCalledTimes(2))
    expect(mocks.printConfig).toHaveBeenCalledTimes(2)
  })
})

describe('PrintStatusPanel printer configuration', () => {
  it('explains a missing configuration separately from a print failure', async () => {
    mocks.printConfig.mockResolvedValue({
      target: 'none',
      arabic_mode: 'CP1256',
      codepage: 22,
      logo: true,
      duplicate_window_secs: 60,
    } satisfies PrintConfig)
    renderPanel()

    expect(await screen.findByText('لم يتم إعداد الطابعة بعد')).toBeInTheDocument()
    expect(
      screen.getByText('اضبط الطابعة أولًا لتتمكن من طباعة الفواتير والتذاكر من هذا الجهاز.'),
    ).toBeInTheDocument()
    // The notice is a configuration fact, not a job result.
    expect(screen.getByText('لا توجد عمليات طباعة بعد')).toBeInTheDocument()
  })

  it('claims no printer state when the configuration cannot be read', async () => {
    mocks.printConfig.mockRejectedValue({ message: 'auth.forbidden' })
    renderPanel()

    await screen.findByText('لا توجد عمليات طباعة بعد')
    expect(screen.queryByText('لم يتم إعداد الطابعة بعد')).not.toBeInTheDocument()
  })
})

describe('PrintStatusPanel test print', () => {
  it('sends the existing test page and reloads the history', async () => {
    mocks.printJobs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([job({ doc_type: 'TEST', status: 'PRINTED' })])
    renderPanel()
    await screen.findByText('لا توجد عمليات طباعة بعد')

    fireEvent.click(screen.getByRole('button', { name: 'طباعة تجريبية' }))

    expect(await screen.findByText('تم إرسال الطباعة')).toBeInTheDocument()
    expect(await screen.findByText('صفحة اختبار الطباعة')).toBeInTheDocument()
    expect(mocks.printTest).toHaveBeenCalledTimes(1)
  })

  it('reports a test-print failure in Arabic, never as a raw code', async () => {
    mocks.printTest.mockRejectedValue({ message: 'printer.not_configured' })
    const { container } = renderPanel()
    await screen.findByText('لا توجد عمليات طباعة بعد')

    fireEvent.click(screen.getByRole('button', { name: 'طباعة تجريبية' }))

    expect(await screen.findByText('لم يتم إعداد الطابعة بعد')).toBeInTheDocument()
    expect(container.textContent).not.toContain('printer.not_configured')
  })

  it('reports a duplicate-suppressed test print with the existing message', async () => {
    mocks.printTest.mockResolvedValue({
      doc_type: 'TEST',
      target: 'share:XP80',
      bytes: 128,
      duplicate_suppressed: true,
    })
    renderPanel()
    await screen.findByText('لا توجد عمليات طباعة بعد')

    fireEvent.click(screen.getByRole('button', { name: 'طباعة تجريبية' }))

    expect(await screen.findByText('تم منع طباعة مكررة (نفس المستند)')).toBeInTheDocument()
  })
})
