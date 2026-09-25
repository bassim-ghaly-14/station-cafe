/**
 * Operation history — the states that make an operations screen trustworthy.
 *
 * The critical behaviour is that "the log is empty" and "your filters hid
 * everything" are DIFFERENT screens with different copy and different actions,
 * and that no recorded code ever reaches the user in English.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { ToastProvider } from '@/components/ui'
import type { AuditEntry } from '@/services/opsApi'
import ReportsPage from '../ReportsPage'

const mocks = vi.hoisted(() => ({
  salesByDay: vi.fn(),
  productSales: vi.fn(),
  analyticsCharts: vi.fn(),
  audit: vi.fn(),
  printJobs: vi.fn(),
  printConfig: vi.fn(),
  printTest: vi.fn(),
}))

vi.mock('@/services/opsApi', async () => {
  const actual = await vi.importActual<typeof import('@/services/opsApi')>('@/services/opsApi')
  return {
    ...actual,
    opsApi: {
      salesByDay: mocks.salesByDay,
      productSales: mocks.productSales,
      analyticsCharts: mocks.analyticsCharts,
      audit: mocks.audit,
      printJobs: mocks.printJobs,
      printConfig: mocks.printConfig,
      printTest: mocks.printTest,
    },
  }
})

/** Rows shaped exactly like the `list_audit` command returns them. */
const entries: AuditEntry[] = [
  {
    id: 3,
    actor_id: 2,
    actor_name: 'محمود',
    actor_role: 'MANAGER',
    action: 'invoice.created',
    entity_type: 'invoice',
    entity_id: '1042',
    after_json: '{"total":15000,"status":"PAID"}',
    created_at: '2026-09-25 14:30:00Z',
  },
  {
    id: 2,
    actor_id: 1,
    actor_name: 'سارة',
    actor_role: 'STAFF',
    action: 'shift.opened',
    entity_type: 'shift',
    entity_id: '7',
    after_json: null,
    created_at: '2026-09-25 09:05:00Z',
  },
  {
    id: 1,
    actor_id: 1,
    actor_name: 'سارة',
    actor_role: 'STAFF',
    action: 'catalog.price_changed',
    entity_type: 'product',
    entity_id: '55',
    after_json: null,
    created_at: '2026-09-24 18:40:00Z',
  },
]

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

function renderAuditTab() {
  const utils = render(
    <ToastProvider>
      <ReportsPage />
    </ToastProvider>,
  )
  fireEvent.click(screen.getByRole('tab', { name: 'سجل العمليات' }))
  return utils
}

describe('Operations history', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.salesByDay.mockReset().mockResolvedValue([])
    mocks.productSales.mockReset().mockResolvedValue([])
    mocks.analyticsCharts.mockReset().mockResolvedValue({ charts: [] })
    mocks.audit.mockReset().mockResolvedValue(entries)
    mocks.printJobs.mockReset().mockResolvedValue([])
    mocks.printConfig.mockReset().mockResolvedValue({
      target: 'none',
      arabic_mode: 'CP1256',
      codepage: 22,
      logo: true,
      duplicate_window_secs: 60,
    })
    mocks.printTest.mockReset()
  })

  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage(DEFAULT_LOCALE)
    })
  })

  it('renders the log as a real table with translated operations and no English codes', async () => {
    const { container } = renderAuditTab()

    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'العملية' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'النوع' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'التاريخ والوقت' })).toBeInTheDocument()

    expect(screen.getByText('إنشاء فاتورة')).toBeInTheDocument()
    expect(screen.getByText('فتح وردية')).toBeInTheDocument()
    expect(screen.getByText('تغيير سعر')).toBeInTheDocument()

    // The recorded codes and the raw JSON payload must never be on screen.
    expect(container.textContent).not.toContain('invoice.created')
    expect(container.textContent).not.toContain('after_json')
    expect(container.textContent).not.toContain('"total"')
  })

  it('gives each operation type an icon tile instead of a filled pill', async () => {
    renderAuditTab()
    await screen.findByText('إنشاء فاتورة')

    // Scoped to the table: the same labels also appear as filter options.
    const table = within(screen.getByRole('table'))
    const typeCell = table.getByText('الفواتير والمدفوعات').closest('td')
    expect(typeCell?.querySelector('svg')).toBeInTheDocument()
    expect(table.getByText('الورديات وأيام العمل')).toBeInTheDocument()
    expect(table.getByText('الأصناف والأسعار')).toBeInTheDocument()
  })

  it('distinguishes an empty log from filters that match nothing', async () => {
    renderAuditTab()
    await screen.findByText('إنشاء فاتورة')

    // A search that excludes everything is NOT "there are no operations".
    fireEvent.change(screen.getByRole('searchbox', { name: 'البحث في السجل' }), {
      target: { value: 'لا-يوجد-مثل-هذا' },
    })

    expect(await screen.findByText('لا توجد نتائج مطابقة للفلاتر الحالية')).toBeInTheDocument()
    expect(screen.getByText(/يوجد في السجل 3 عملية/)).toBeInTheDocument()
    expect(screen.queryByText('لا توجد عمليات حتى الآن')).not.toBeInTheDocument()
  })

  it('offers a direct reset from the no-results state', async () => {
    renderAuditTab()
    await screen.findByText('إنشاء فاتورة')

    fireEvent.change(screen.getByRole('searchbox', { name: 'البحث في السجل' }), {
      target: { value: 'لا-يوجد' },
    })
    // The toolbar reset and the empty-state reset are both offered; either works.
    fireEvent.click((await screen.findAllByRole('button', { name: /مسح الفلاتر/ })).at(-1)!)

    expect(await screen.findByText('إنشاء فاتورة')).toBeInTheDocument()
    expect(screen.queryByText('لا توجد نتائج مطابقة للفلاتر الحالية')).not.toBeInTheDocument()
  })

  it('searches the Arabic labels the user can actually see', async () => {
    renderAuditTab()
    await screen.findByText('إنشاء فاتورة')

    fireEvent.change(screen.getByRole('searchbox', { name: 'البحث في السجل' }), {
      target: { value: 'فاتورة' },
    })

    await waitFor(() => expect(screen.queryByText('فتح وردية')).not.toBeInTheDocument())
    expect(screen.getByText('إنشاء فاتورة')).toBeInTheDocument()
    // Filtering happens on the loaded window: one fetch, not one per keystroke.
    expect(mocks.audit).toHaveBeenCalledTimes(1)
  })

  it('filters by operation type and by operator', async () => {
    renderAuditTab()
    await screen.findByText('إنشاء فاتورة')

    fireEvent.change(screen.getByRole('combobox', { name: 'نوع العملية' }), {
      target: { value: 'operations' },
    })
    await waitFor(() => expect(screen.queryByText('إنشاء فاتورة')).not.toBeInTheDocument())
    expect(screen.getByText('فتح وردية')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: 'المستخدم' }), {
      target: { value: '2' },
    })
    // محمود recorded the invoice, not the shift, so this combination is empty.
    expect(await screen.findByText('لا توجد نتائج مطابقة للفلاتر الحالية')).toBeInTheDocument()
  })

  it('shows a genuinely empty log with different copy and no reset', async () => {
    mocks.audit.mockResolvedValue([])
    renderAuditTab()

    expect(await screen.findByText('لا توجد عمليات حتى الآن')).toBeInTheDocument()
    expect(screen.queryByText('لا توجد نتائج مطابقة للفلاتر الحالية')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /مسح الفلاتر/ })).not.toBeInTheDocument()
  })

  it('surfaces a load failure with a retry instead of an empty list', async () => {
    mocks.audit.mockRejectedValue(new Error('internal_error'))
    renderAuditTab()

    expect(await screen.findByText('حدث خطأ غير متوقع، حاول مرة أخرى')).toBeInTheDocument()
    expect(screen.queryByText('لا توجد عمليات حتى الآن')).not.toBeInTheDocument()

    mocks.audit.mockResolvedValue(entries)
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }))
    expect(await screen.findByText('إنشاء فاتورة')).toBeInTheDocument()
  })

  it('opens a details dialog showing only fields the record actually has', async () => {
    renderAuditTab()
    await screen.findByText('إنشاء فاتورة')

    fireEvent.click(screen.getByRole('button', { name: /عرض تفاصيل العملية: إنشاء فاتورة/ }))
    const dialog = await screen.findByRole('dialog', { name: 'تفاصيل العملية' })

    expect(within(dialog).getByText('إنشاء فاتورة')).toBeInTheDocument()
    expect(within(dialog).getByText('محمود')).toBeInTheDocument()
    expect(within(dialog).getByText('مدير')).toBeInTheDocument()
    expect(within(dialog).getByText('فاتورة')).toBeInTheDocument()
    expect(within(dialog).getByText(/المرجع #1042/)).toBeInTheDocument()
    // The recorded payload is shown, pretty-printed, as stored data.
    expect(within(dialog).getByText(/"total": 15000/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'إغلاق' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'تفاصيل العملية' })).not.toBeInTheDocument(),
    )
  })

  it('says so when an operation carries no extra recorded data', async () => {
    renderAuditTab()
    await screen.findByText('فتح وردية')

    fireEvent.click(screen.getByRole('button', { name: /عرض تفاصيل العملية: فتح وردية/ }))
    const dialog = await screen.findByRole('dialog', { name: 'تفاصيل العملية' })

    expect(within(dialog).getByText('لم تُسجَّل بيانات إضافية لهذه العملية.')).toBeInTheDocument()
  })

  it('labels an unmapped action in Arabic rather than leaking its code', async () => {
    mocks.audit.mockResolvedValue([
      {
        id: 9,
        actor_id: 1,
        actor_name: 'سارة',
        actor_role: 'STAFF',
        action: 'loyalty.points_redeemed',
        entity_type: 'loyalty_account',
        entity_id: '4',
        after_json: null,
        created_at: '2026-09-25 12:00:00Z',
      },
    ])
    const { container } = renderAuditTab()

    expect(await screen.findByText('عملية مسجّلة')).toBeInTheDocument()
    const table = within(screen.getByRole('table'))
    expect(table.getByText('عمليات أخرى')).toBeInTheDocument()
    expect(table.getByText('سجل')).toBeInTheDocument()
    expect(container.textContent).not.toContain('loyalty')
  })

  it('requests the log once per load, with a bounded window', async () => {
    renderAuditTab()
    await screen.findByText('إنشاء فاتورة')

    expect(mocks.audit).toHaveBeenCalledTimes(1)
    expect(mocks.audit).toHaveBeenCalledWith(200)
  })
})
