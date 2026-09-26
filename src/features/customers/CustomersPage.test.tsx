/**
 * The customers page is the security-sensitive screen of this feature, so its
 * tests assert what each role is actually GIVEN, not what it hides:
 *
 *  - a cashier receives a list with no aggregate at all: no money columns, no
 *    KPI band, no details action — and the page never even asks the backend for
 *    the analytics it is not allowed to have;
 *  - a manager receives the real aggregate, the KPI band and the drawer;
 *  - the four page states (loading, empty, no-results, failure) each render
 *    their own presentation, and adding a customer goes through the shared API.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { ToastProvider } from '@/components/ui'
import CustomersPage from './CustomersPage'
import { customerAvatarTone } from '@/lib/customer-visual'
import type {
  CustomerDetails,
  CustomerList,
  CustomerOverview,
  CustomerRow,
} from '@/services/customersApi'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  overview: vi.fn(),
  details: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  createCar: vi.fn(),
  role: { current: 'MANAGER' as 'STAFF' | 'MANAGER' | 'ADMIN' },
}))

vi.mock('@/services/customersApi', () => ({
  customersApi: {
    list: mocks.list,
    overview: mocks.overview,
    details: mocks.details,
    create: mocks.create,
    update: mocks.update,
    createCar: mocks.createCar,
  },
}))

vi.mock('@/features/auth/useSession', () => ({
  useSession: () => ({ user: { id: 1, name: 'موظف', role: mocks.role.current } }),
  atLeast: (role: string | undefined, min: string) => {
    const rank = (value?: string) =>
      value === 'ADMIN' ? 3 : value === 'MANAGER' ? 2 : value === 'STAFF' ? 1 : 0
    return rank(role) >= rank(min)
  },
}))

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

function stats(over: Partial<NonNullable<CustomerRow['stats']>> = {}) {
  return {
    invoices_count: 3,
    total: 19_500,
    paid: 11_500,
    discounts: 1_000,
    service_charges: 500,
    average_order: 6_500,
    cafe_orders: 2,
    cafe_total: 6_000,
    wash_orders: 2,
    wash_total: 14_000,
    takeaway_orders: 1,
    table_orders: 2,
    first_at: '2026-09-01 10:00:00Z',
    last_at: '2026-09-10 12:00:00Z',
    credit_outstanding: 5_000,
    credit_original: 7_000,
    credit_paid: 2_000,
    credit_status: 'PARTIALLY_PAID',
    ...over,
  }
}

function customer(over: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: 1,
    name: 'أحمد سيد',
    phone: '01001234567',
    notes: null,
    created_at: '2026-08-01 09:00:00Z',
    updated_at: '2026-09-01 09:00:00Z',
    plates: ['أ ب ج ١٢٣٤'],
    cars_count: 1,
    stats: null,
    ...over,
  }
}

const MANAGER_LIST: CustomerList = {
  financial_visible: true,
  customers: [customer({ stats: stats() })],
}

// The backend sends no aggregate key at all for a cashier.
const CASHIER_LIST: CustomerList = {
  financial_visible: false,
  customers: [customer()],
}

const OVERVIEW: CustomerOverview = {
  total_customers: 12,
  active_customers: 5,
  total_orders: 9,
  total_paid: 24_000,
  average_spend: 4_800,
  cafe_orders: 7,
  wash_orders: 2,
  takeaway_orders: 4,
  table_orders: 5,
  outstanding_credit: 5_000,
  top_by_orders: { customer_id: 1, name: 'أحمد سيد', value: 3 },
  top_by_spend: { customer_id: 1, name: 'أحمد سيد', value: 11_500 },
}

const DETAILS: CustomerDetails = {
  customer: { id: 1, name: 'أحمد سيد', phone: '01001234567', notes: 'عميل دائم' },
  created_at: '2026-08-01 09:00:00Z',
  cars: [{ id: 4, customer_id: 1, plate_no: 'أ ب ج ١٢٣٤', car_model: 'تويوتا', notes: null }],
  stats: stats(),
  activity: [
    {
      invoice_no: 4,
      order_type: 'TAKEAWAY',
      table_label: null,
      takeaway_no: 7,
      status: 'PAID',
      total: 8_000,
      paid_amount: 8_000,
      cafe_total: 0,
      wash_total: 8_000,
      created_at: '2026-09-10 12:00:00Z',
    },
  ],
}

function renderPage() {
  return render(
    <ToastProvider>
      <CustomersPage />
    </ToastProvider>,
  )
}

describe('CustomersPage — cashier (no financial analytics)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.role.current = 'STAFF'
    mocks.list.mockResolvedValue(CASHIER_LIST)
  })

  it('lists customers without any money column, KPI band or details action', async () => {
    renderPage()

    expect(await screen.findByText('أحمد سيد')).toBeInTheDocument()
    // Identity is what a cashier is served with.
    expect(screen.getByText('01001234567')).toBeInTheDocument()
    expect(screen.getByText('أ ب ج ١٢٣٤')).toBeInTheDocument()
    // The financial columns are not rendered at all.
    expect(screen.queryByText('المدفوع')).not.toBeInTheDocument()
    expect(screen.queryByText('الرصيد الآجل')).not.toBeInTheDocument()
    expect(screen.queryByText('إجمالي العملاء')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /تفاصيل/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /تعديل/ })).not.toBeInTheDocument()
    // Identity and vehicle state are operational, not financial, so a cashier
    // keeps both.
    expect(screen.getByTestId('customer-avatar')).toBeInTheDocument()
    expect(screen.getByText('لديه سيارات')).toBeInTheDocument()
  })

  it('never requests the analytics it is not allowed to receive', async () => {
    renderPage()

    await screen.findByText('أحمد سيد')
    expect(mocks.overview).not.toHaveBeenCalled()
    expect(mocks.details).not.toHaveBeenCalled()
    // The period control is manager-only, so a cashier is never offered one.
    expect(screen.queryByRole('button', { name: 'الفترة الزمنية' })).not.toBeInTheDocument()
  })

  it('still allows the operational job: adding a customer', async () => {
    mocks.create.mockResolvedValue(11)
    renderPage()
    await screen.findByText('أحمد سيد')

    fireEvent.click(screen.getAllByRole('button', { name: 'عميل جديد' })[0])
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('اسم العميل'), {
      target: { value: 'عميل جديد' },
    })
    fireEvent.change(within(dialog).getByLabelText('رقم التليفون'), {
      target: { value: '01099998888' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }))

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        name: 'عميل جديد',
        phone: '01099998888',
        notes: null,
      }),
    )
  })
})

describe('CustomersPage — manager (customer intelligence)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.role.current = 'MANAGER'
    mocks.list.mockResolvedValue(MANAGER_LIST)
    mocks.overview.mockResolvedValue(OVERVIEW)
    mocks.details.mockResolvedValue(DETAILS)
  })

  it('renders the KPI band from the overview payload', async () => {
    renderPage()

    expect(await screen.findByText('إجمالي العملاء')).toBeInTheDocument()
    expect(screen.getByText('العملاء النشطون')).toBeInTheDocument()
    // Real figures, not placeholders.
    expect(screen.getByText('12')).toBeInTheDocument()
    // The named leaders are the ones the backend resolved.
    expect(screen.getAllByText('أحمد سيد').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/3 طلب/)).toBeInTheDocument()
  })

  it('renders a deterministic customer avatar and a vehicle badge', async () => {
    renderPage()
    await screen.findByText('إجمالي العملاء')

    // An avatar is rendered, and its tone is the one the ID deterministically
    // maps to — not a fresh pick on every render.
    const avatar = screen.getAllByTestId('customer-avatar')[0]
    expect(avatar).toHaveAttribute(
      'data-customer-avatar-tone',
      String(customerAvatarTone(customer().id).slot),
    )
    // The name is still the identity — the avatar is decorative beside it.
    expect(avatar).toHaveAttribute('aria-hidden', 'true')
    expect(avatar).toHaveTextContent('أس')
    // The vehicle state is stated in words, not only by color.
    expect(screen.getByText('لديه سيارات')).toBeInTheDocument()

    // Re-rendering (a re-search, a period change) must not repaint the avatar.
    fireEvent.change(screen.getByLabelText('بحث عن عميل'), { target: { value: 'أحمد' } })
    await waitFor(() => expect(mocks.list).toHaveBeenCalled())
    expect(screen.getAllByTestId('customer-avatar')[0]).toHaveAttribute(
      'data-customer-avatar-tone',
      String(customerAvatarTone(customer().id).slot),
    )
  })

  it('states the absence of vehicles in words as well', async () => {
    mocks.list.mockResolvedValue({
      financial_visible: true,
      customers: [customer({ cars_count: 0, plates: [] })],
    })
    renderPage()
    await screen.findByText('إجمالي العملاء')

    expect(screen.getByText('بدون سيارات')).toBeInTheDocument()
    expect(screen.queryByText('لديه سيارات')).not.toBeInTheDocument()
  })

  it('lays out the toolbar as search + create, with the period on its own row', async () => {
    renderPage()
    await screen.findByText('إجمالي العملاء')

    // Search and the create action share one row; the period control does not.
    const search = screen.getByLabelText('بحث عن عميل')
    const create = screen.getByRole('button', { name: 'عميل جديد' })
    const period = screen.getByRole('button', { name: /فترة التحليل/ })

    const searchRow = search.closest('div')?.parentElement
    expect(searchRow).toContainElement(create)
    expect(searchRow).not.toContainElement(period)
  })

  it('shows the activity columns and opens the details drawer with its statistics', async () => {
    renderPage()
    await screen.findByText('إجمالي العملاء')

    expect(screen.getByText('المدفوع')).toBeInTheDocument()
    expect(screen.getByText('الرصيد الآجل')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'تفاصيل أحمد سيد' }))

    const drawer = await screen.findByRole('dialog', { name: 'أحمد سيد' })
    // The panel reads as a profile: identity, performance, the two separate
    // axes, then the real invoices.
    expect(within(drawer).getByText('الملف الشخصي')).toBeInTheDocument()
    expect(within(drawer).getByText('ملخص الأداء')).toBeInTheDocument()
    expect(within(drawer).getByText('توزيع النشاط')).toBeInTheDocument()
    expect(within(drawer).getByText('توزيع نوع الطلب')).toBeInTheDocument()
    expect(within(drawer).getByText('آخر الفواتير')).toBeInTheDocument()
    // The recent invoice of the real payload is listed.
    expect(within(drawer).getByText('#4')).toBeInTheDocument()
    expect(mocks.details).toHaveBeenCalledWith(1, { from: '', to: '' })
  })

  it('offers the edit action and sends the update through the API', async () => {
    mocks.update.mockResolvedValue(undefined)
    renderPage()
    await screen.findByText('إجمالي العملاء')

    fireEvent.click(screen.getByRole('button', { name: 'تعديل أحمد سيد' }))
    const dialog = await screen.findByRole('dialog', { name: 'تعديل بيانات العميل' })
    // The form is seeded from the record being edited.
    expect(within(dialog).getByLabelText('اسم العميل')).toHaveValue('أحمد سيد')
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }))

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(1, {
        name: 'أحمد سيد',
        phone: '01001234567',
        notes: null,
      }),
    )
  })

  it('searches live through the backend', async () => {
    renderPage()
    await screen.findByText('إجمالي العملاء')

    fireEvent.change(screen.getByLabelText('بحث عن عميل'), { target: { value: 'سيد' } })

    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith('سيد', { from: '', to: '' }))
  })

  it('reports a failed drawer read and can retry it', async () => {
    mocks.details.mockRejectedValueOnce({ message: 'db.error' })
    renderPage()
    await screen.findByText('إجمالي العملاء')

    fireEvent.click(screen.getByRole('button', { name: 'تفاصيل أحمد سيد' }))
    const drawer = await screen.findByRole('dialog', { name: 'أحمد سيد' })
    expect(within(drawer).getByRole('alert')).toBeInTheDocument()

    // The retry must issue a NEW read, not just re-render the same failure.
    fireEvent.click(within(drawer).getByRole('button', { name: /إعادة المحاولة/ }))
    expect(await within(drawer).findByText('ملخص الأداء')).toBeInTheDocument()
    expect(mocks.details).toHaveBeenCalledTimes(2)
  })
})

describe('CustomersPage — states', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.role.current = 'MANAGER'
    mocks.overview.mockResolvedValue(OVERVIEW)
  })

  it('shows a loading placeholder before the first list arrives', () => {
    mocks.list.mockReturnValue(new Promise(() => {}))
    renderPage()

    expect(screen.getByLabelText('جارٍ تحميل الجدول')).toBeInTheDocument()
  })

  it('distinguishes "no customers" from "no search results"', async () => {
    mocks.list.mockResolvedValue({ financial_visible: false, customers: [] })
    renderPage()

    expect(await screen.findByText('لا يوجد عملاء مسجلون بعد')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('بحث عن عميل'), { target: { value: 'لا يوجد' } })
    expect(await screen.findByText('لا يوجد عملاء مطابقون للبحث')).toBeInTheDocument()
  })

  it('reports a failed list with a retry, not an empty table', async () => {
    mocks.list.mockRejectedValue({ message: 'db.error' })
    renderPage()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /إعادة المحاولة/ })).toBeInTheDocument()
  })
})
