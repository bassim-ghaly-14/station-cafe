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
import { SessionProvider } from '@/features/auth/useSession'
import type { AuditEntry } from '@/services/opsApi'
import ReportsPage from '../ReportsPage'

const mocks = vi.hoisted(() => ({
  analyticsCharts: vi.fn(),
  audit: vi.fn(),
  printJobs: vi.fn(),
  printConfig: vi.fn(),
  printTest: vi.fn(),
  me: vi.fn(),
}))

vi.mock('@/services/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ipc')>()
  return {
    ...actual,
    // Only the session probe is intercepted: `me` decides the viewer's role,
    // everything else keeps the real implementation.
    call: (cmd: string, args?: Record<string, unknown>) =>
      cmd === 'me' ? mocks.me(args) : actual.call(cmd, args),
  }
})

vi.mock('@/services/opsApi', async () => {
  const actual = await vi.importActual<typeof import('@/services/opsApi')>('@/services/opsApi')
  return {
    ...actual,
    opsApi: {
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
    // Shaped exactly like the `invoice.created` snapshot the backend writes.
    after_json:
      '{"invoice_no":"1042","method":"CARD","total":15000,"discount":0,"service_charge":0,"order_type":"TABLE","takeaway_no":null}',
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

/**
 * The same tab, seen by a signed-in ADMIN.
 *
 * A session token plus a resolved `me` are what make the viewer an admin, so this
 * exercises the real role plumbing rather than a prop.
 */
function renderAuditTabAs(role: 'ADMIN' | 'MANAGER') {
  localStorage.setItem('station.session.token', 'test-token')
  const utils = render(
    <ToastProvider>
      <SessionProvider>
        <ReportsPage />
      </SessionProvider>
    </ToastProvider>,
  )
  fireEvent.click(screen.getByRole('tab', { name: 'سجل العمليات' }))
  return { ...utils, role }
}

describe('Operations history', () => {
  beforeEach(() => {
    localStorage.clear()
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
    mocks.me.mockReset().mockResolvedValue({
      id: 9,
      name: 'مالك',
      phone: null,
      role: 'ADMIN',
      status: 'ACTIVE',
      created_at: '2026-01-01 00:00:00Z',
      updated_at: '2026-01-01 00:00:00Z',
    })
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
    expect(screen.getByRole('columnheader', { name: 'التفاصيل' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'القسم' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'المستخدم' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'التاريخ والوقت' })).toBeInTheDocument()

    expect(screen.getByText('إنشاء فاتورة')).toBeInTheDocument()
    expect(screen.getByText('فتح وردية')).toBeInTheDocument()
    expect(screen.getByText('تغيير سعر')).toBeInTheDocument()

    // The recorded codes and the raw JSON payload must never be on screen.
    expect(container.textContent).not.toContain('invoice.created')
    expect(container.textContent).not.toContain('after_json')
    expect(container.textContent).not.toContain('"total"')
  })

  it('shows a manager business summary of the operation, not a developer log', async () => {
    renderAuditTab()
    await screen.findByText('إنشاء فاتورة')

    const table = within(screen.getByRole('table'))
    // Invoice number + total, straight from the stored snapshot.
    expect(table.getByText('1042 · 150.00 ج.م')).toBeInTheDocument()
    // The internal element reference is an ADMIN capability, never a manager one.
    expect(screen.queryByRole('columnheader', { name: 'العنصر' })).not.toBeInTheDocument()
    expect(table.queryByText('#1042')).not.toBeInTheDocument()
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
    expect(screen.queryByText('لا توجد عمليات مسجّلة بعد')).not.toBeInTheDocument()
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

  it('filters by operation area and by operator', async () => {
    renderAuditTab()
    await screen.findByText('إنشاء فاتورة')

    fireEvent.change(screen.getByRole('combobox', { name: 'القسم' }), {
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

    expect(await screen.findByText('لا توجد عمليات مسجّلة بعد')).toBeInTheDocument()
    expect(screen.queryByText('لا توجد نتائج مطابقة للفلاتر الحالية')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /مسح الفلاتر/ })).not.toBeInTheDocument()
  })

  it('surfaces a load failure with a retry instead of an empty list', async () => {
    mocks.audit.mockRejectedValue(new Error('internal_error'))
    renderAuditTab()

    expect(await screen.findByText('حدث خطأ غير متوقع، حاول مرة أخرى')).toBeInTheDocument()
    expect(screen.queryByText('لا توجد عمليات مسجّلة بعد')).not.toBeInTheDocument()

    mocks.audit.mockResolvedValue(entries)
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }))
    expect(await screen.findByText('إنشاء فاتورة')).toBeInTheDocument()
  })

  it('gives a manager a human-readable details dialog and no technical payload', async () => {
    renderAuditTab()
    await screen.findByText('إنشاء فاتورة')

    fireEvent.click(screen.getByRole('button', { name: /عرض تفاصيل العملية: إنشاء فاتورة/ }))
    const dialog = await screen.findByRole('dialog', { name: 'تفاصيل العملية' })

    // 1 — a plain Arabic summary of what happened.
    expect(within(dialog).getByText('ملخص العملية')).toBeInTheDocument()
    expect(within(dialog).getByText('تم إنشاء فاتورة.')).toBeInTheDocument()

    // 2 — the business facts, in the manager's own terms.
    expect(within(dialog).getByText('التفاصيل')).toBeInTheDocument()
    expect(within(dialog).getByText('محمود')).toBeInTheDocument()
    expect(within(dialog).getByText('مدير')).toBeInTheDocument()
    expect(within(dialog).getByText('القسم')).toBeInTheDocument()
    // The area is named twice on purpose: the summary badge and the field.
    expect(within(dialog).getAllByText('الفواتير والمدفوعات')).toHaveLength(2)
    expect(within(dialog).getByText('العنصر المتأثر')).toBeInTheDocument()
    expect(within(dialog).getByText('فاتورة')).toBeInTheDocument()
    expect(within(dialog).getByText('رقم الفاتورة')).toBeInTheDocument()
    expect(within(dialog).getByText('1042')).toBeInTheDocument()
    expect(within(dialog).getByText('الإجمالي')).toBeInTheDocument()
    expect(within(dialog).getByText('150.00 ج.م')).toBeInTheDocument()
    expect(within(dialog).getByText('طريقة الدفع')).toBeInTheDocument()
    expect(within(dialog).getByText('بطاقة')).toBeInTheDocument()

    // 3 — never for a manager: the technical section, the stored codes, the
    // internal ids, or anything that smells of a raw payload.
    expect(within(dialog).queryByText('المعلومات التقنية')).not.toBeInTheDocument()
    expect(within(dialog).queryByText('invoice.created')).not.toBeInTheDocument()
    expect(dialog.textContent).not.toContain('#1042')
    expect(dialog.textContent).not.toContain('"total"')
    expect(dialog.textContent).not.toContain('after_json')

    fireEvent.click(within(dialog).getByRole('button', { name: 'إغلاق' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'تفاصيل العملية' })).not.toBeInTheDocument(),
    )
  })

  it('gives an admin the same summary plus the full technical audit detail', async () => {
    renderAuditTabAs('ADMIN')
    await screen.findByText('إنشاء فاتورة')

    const table = within(screen.getByRole('table'))
    // ADMIN keeps the affected element and its stored reference.
    expect(screen.getByRole('columnheader', { name: 'العنصر' })).toBeInTheDocument()
    expect(table.getByText('#1042')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /عرض تفاصيل العملية: إنشاء فاتورة/ }))
    const dialog = await screen.findByRole('dialog', { name: 'تفاصيل العملية' })

    // The human summary is still first…
    expect(within(dialog).getByText('تم إنشاء فاتورة.')).toBeInTheDocument()
    expect(within(dialog).getByText('رقم الفاتورة')).toBeInTheDocument()

    // …and the technical block keeps every existing audit value available.
    expect(within(dialog).getByText('المعلومات التقنية')).toBeInTheDocument()
    expect(within(dialog).getByText('رمز العملية')).toBeInTheDocument()
    expect(within(dialog).getByText('invoice.created')).toBeInTheDocument()
    expect(within(dialog).getByText('نوع السجل')).toBeInTheDocument()
    expect(within(dialog).getByText('المرجع')).toBeInTheDocument()
    expect(within(dialog).getByText('#1042')).toBeInTheDocument()
    expect(within(dialog).getByText('رقم السجل')).toBeInTheDocument()
    expect(within(dialog).getByText(/"total": 15000/)).toBeInTheDocument()
  })

  it('says so when an operation carries no extra recorded data', async () => {
    renderAuditTab()
    await screen.findByText('فتح وردية')

    fireEvent.click(screen.getByRole('button', { name: /عرض تفاصيل العملية: فتح وردية/ }))
    const dialog = await screen.findByRole('dialog', { name: 'تفاصيل العملية' })

    // A safe sentence, never a dump of nothing.
    expect(within(dialog).getByText('تم فتح وردية.')).toBeInTheDocument()
    expect(
      within(dialog).getByText('لا تتوفر تفاصيل إضافية يمكن عرضها لهذه العملية.'),
    ).toBeInTheDocument()
    expect(within(dialog).queryByText('المعلومات التقنية')).not.toBeInTheDocument()
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
        after_json: '{"points": 40}',
        created_at: '2026-09-25 12:00:00Z',
      },
    ])
    const { container } = renderAuditTab()

    expect(await screen.findByText('عملية غير معروفة')).toBeInTheDocument()
    const table = within(screen.getByRole('table'))
    expect(table.getByText('عمليات أخرى')).toBeInTheDocument()
    expect(container.textContent).not.toContain('loyalty')
    // The payload of an undeclared action is never rendered, not even partially.
    expect(container.textContent).not.toContain('40')

    fireEvent.click(screen.getByRole('button', { name: /عرض تفاصيل العملية/ }))
    const dialog = await screen.findByRole('dialog', { name: 'تفاصيل العملية' })
    // The unmapped element degrades to a neutral Arabic noun, and the stored
    // action code is still not shown to a manager.
    expect(within(dialog).getByText('سجل')).toBeInTheDocument()
    expect(dialog.textContent).not.toContain('loyalty.points_redeemed')
    expect(within(dialog).queryByText('المعلومات التقنية')).not.toBeInTheDocument()
  })

  it('requests the log once per load, with a bounded window', async () => {
    renderAuditTab()
    await screen.findByText('إنشاء فاتورة')

    expect(mocks.audit).toHaveBeenCalledTimes(1)
    expect(mocks.audit).toHaveBeenCalledWith(200)
  })
})
