/**
 * Customer phone export dialog — scope, format, and download.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { ToastProvider } from '@/components/ui'
import CustomersPage from './CustomersPage'
import type { CustomerList, CustomerRow } from '@/services/customersApi'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  overview: vi.fn(),
  exportPhones: vi.fn(),
  downloadBlob: vi.fn(),
  role: { current: 'MANAGER' as 'STAFF' | 'MANAGER' | 'ADMIN' },
}))

vi.mock('@/services/customersApi', () => ({
  customersApi: {
    list: mocks.list,
    overview: mocks.overview,
    details: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    createCar: vi.fn(),
    remove: vi.fn(),
    exportPhones: mocks.exportPhones,
  },
}))

vi.mock('@/features/reports/charts/exports', () => ({
  downloadBlob: mocks.downloadBlob,
  resolveThemeColor: (color: string) => color,
}))

vi.mock('@/features/auth/useSession', () => ({
  useSession: () => ({ user: { id: 1, name: 'x', role: mocks.role.current } }),
  atLeast: (role: string | undefined, min: string) => {
    const rank = (v?: string) => (v === 'ADMIN' ? 3 : v === 'MANAGER' ? 2 : v === 'STAFF' ? 1 : 0)
    return rank(role) >= rank(min)
  },
}))

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

function customer(over: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: 1,
    name: 'ahmed',
    phone: '01001234567',
    notes: null,
    created_at: '2026-08-01 09:00:00Z',
    updated_at: '2026-09-01 09:00:00Z',
    plates: [],
    cars_count: 0,
    stats: null,
    ...over,
  }
}

const LIST: CustomerList = {
  financial_visible: true,
  customers: [
    customer({ id: 1, name: 'ahmed', phone: '01001234567' }),
    customer({ id: 2, name: 'karim', phone: '01111111111' }),
  ],
}

function renderPage() {
  return render(
    <ToastProvider>
      <CustomersPage />
    </ToastProvider>,
  )
}

async function openExport() {
  renderPage()
  await screen.findAllByText('ahmed')
  fireEvent.click(screen.getByRole('button', { name: 'تصدير أرقام التليفون' }))
  await screen.findByRole('dialog', { name: 'تصدير أرقام تليفونات العملاء' })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.role.current = 'MANAGER'
  mocks.list.mockResolvedValue(LIST)
  mocks.overview.mockResolvedValue({
    total_customers: 2,
    active_customers: 2,
    total_orders: 0,
    total_paid: 0,
    average_spend: 0,
    cafe_orders: 0,
    wash_orders: 0,
    takeaway_orders: 0,
    table_orders: 0,
    outstanding_credit: 0,
    top_by_orders: null,
    top_by_spend: null,
  })
  mocks.exportPhones.mockResolvedValue([{ id: 1, name: 'ahmed', phone: '01001234567' }])
})

describe('CustomerPhoneExportDialog', () => {
  it('exports selected customers with their ids as CSV by default', async () => {
    await openExport()
    fireEvent.click(screen.getByRole('checkbox', { name: 'اختيار ahmed للتصدير' }))
    expect(await screen.findByText('عملاء محددون (1)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'تصدير وتنزيل' }))
    await waitFor(() => expect(mocks.exportPhones).toHaveBeenCalledWith([1]))
    await waitFor(() =>
      expect(mocks.downloadBlob).toHaveBeenCalledWith(
        expect.any(Blob),
        expect.stringMatching(/^station-customer-phones-.*\.csv$/),
      ),
    )
    expect(await screen.findByText('تم تصدير 1 رقم تليفون')).toBeInTheDocument()
  })

  it('refuses an empty selection without calling the backend', async () => {
    await openExport()
    expect(screen.getByText('اختر عميلًا واحدًا على الأقل أولًا')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'تصدير وتنزيل' })).toBeDisabled()
    expect(mocks.exportPhones).not.toHaveBeenCalled()
  })

  it('exports all customers with no ids when that scope is chosen', async () => {
    await openExport()
    fireEvent.click(screen.getByRole('radio', { name: 'كل العملاء' }))
    fireEvent.click(screen.getByRole('button', { name: 'تصدير وتنزيل' }))
    await waitFor(() => expect(mocks.exportPhones).toHaveBeenCalledWith(undefined))
  })

  it('downloads a vcf file when VCF is chosen', async () => {
    await openExport()
    fireEvent.click(screen.getByRole('radio', { name: 'كل العملاء' }))
    fireEvent.change(screen.getByLabelText('صيغة الملف'), { target: { value: 'vcf' } })
    fireEvent.click(screen.getByRole('button', { name: 'تصدير وتنزيل' }))
    await waitFor(() =>
      expect(mocks.downloadBlob).toHaveBeenCalledWith(
        expect.any(Blob),
        expect.stringMatching(/^station-customer-contacts-.*\.vcf$/),
      ),
    )
  })

  it('reports an empty export in Arabic without downloading', async () => {
    await openExport()
    fireEvent.click(screen.getByRole('radio', { name: 'كل العملاء' }))
    mocks.exportPhones.mockResolvedValueOnce([])
    fireEvent.click(screen.getByRole('button', { name: 'تصدير وتنزيل' }))
    expect(await screen.findByText('لا توجد أرقام تليفون صالحة للتصدير')).toBeInTheDocument()
    expect(mocks.downloadBlob).not.toHaveBeenCalled()
  })

  it('offers a cashier no export affordance at all', async () => {
    mocks.role.current = 'STAFF'
    mocks.list.mockResolvedValue({ financial_visible: false, customers: [customer()] })
    renderPage()
    await screen.findAllByText('ahmed')
    expect(screen.queryByRole('button', { name: 'تصدير أرقام التليفون' })).not.toBeInTheDocument()
  })

  it('selects all visible rows with one checkbox', async () => {
    await openExport()
    fireEvent.click(screen.getByRole('checkbox', { name: 'تحديد الظاهر' }))
    expect(await screen.findByText('عملاء محددون (2)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'تصدير وتنزيل' }))
    await waitFor(() => expect(mocks.exportPhones).toHaveBeenCalledWith([1, 2]))
  })
})
