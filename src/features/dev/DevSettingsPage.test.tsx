import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import DevSettingsPage from './DevSettingsPage'

const mocks = vi.hoisted(() => ({
  user: { role: 'ADMIN' as 'ADMIN' | 'STAFF' },
  loadOfficial: vi.fn(),
  clear: vi.fn(),
  clearSessionToken: vi.fn(),
  clearLocalSession: vi.fn(),
  serviceCharge: vi.fn(),
  discountAuthorization: vi.fn(),
  setDiscountAuthorizationPassword: vi.fn(),
  setServiceCharge: vi.fn(),
  setCredit: vi.fn(),
  credit: vi.fn(),
  tables: vi.fn(),
  setTableCount: vi.fn(),
}))
vi.mock('@/features/auth/useSession', () => ({
  useSession: () => ({
    user: mocks.user,
    clearSessionToken: mocks.clearSessionToken,
    clearLocalSession: mocks.clearLocalSession,
  }),
}))
vi.mock('@/services/developerApi', () => ({
  developerApi: {
    loadOfficial: mocks.loadOfficial,
    clear: mocks.clear,
    setReseedToken: vi.fn(),
    takeReseedToken: () => 'one-time-grant',
    clearReseedToken: vi.fn(),
  },
}))
vi.mock('@/services/posApi', () => ({
  api: { tables: mocks.tables, setTableCount: mocks.setTableCount },
  settingsApi: {
    serviceCharge: mocks.serviceCharge,
    discountAuthorization: mocks.discountAuthorization,
    setDiscountAuthorizationPassword: mocks.setDiscountAuthorizationPassword,
    setServiceCharge: mocks.setServiceCharge,
    setCredit: mocks.setCredit,
    credit: mocks.credit,
  },
}))

function page() {
  return render(
    <ToastProvider>
      <DevSettingsPage />
    </ToastProvider>,
  )
}

describe('DevSettingsPage', () => {
  beforeEach(() => {
    mocks.user.role = 'ADMIN'
    mocks.loadOfficial.mockReset().mockResolvedValue(undefined)
    mocks.clear.mockReset().mockResolvedValue('one-time-grant')
    mocks.clearSessionToken.mockReset()
    mocks.clearLocalSession.mockReset()
    mocks.serviceCharge.mockReset().mockResolvedValue({ amounts: [1000, 3000, 5000] })
    mocks.discountAuthorization.mockReset().mockResolvedValue({ configured: false })
    mocks.setDiscountAuthorizationPassword.mockReset().mockResolvedValue(undefined)
    mocks.setServiceCharge.mockReset().mockResolvedValue(undefined)
    mocks.setCredit.mockReset().mockResolvedValue(undefined)
    mocks.credit
      .mockReset()
      .mockResolvedValue({ enabled: true, mode: 'LIST', allowed_customer_ids: [] })
    mocks.tables.mockReset().mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        id: index + 1,
        label: `طاولة ${String(index + 1).padStart(2, '0')}`,
        status: 'EMPTY',
        order_id: null,
        session_id: null,
        items_count: 0,
        total_minor: 0,
        opened_at: null,
        opens_today: 0,
        closed_empty_today: 0,
      })),
    )
    mocks.setTableCount.mockReset().mockResolvedValue(undefined)
  })

  it('hides the page from staff', () => {
    mocks.user.role = 'STAFF'
    page()
    expect(screen.queryByRole('heading', { name: 'إعدادات المطوّر' })).not.toBeInTheDocument()
  })

  it('only exposes numeric table count control', async () => {
    page()
    await waitFor(() => expect(screen.getByLabelText('عدد الطاولات')).toHaveTextContent('12'))
    expect(screen.getByLabelText('إنقاص')).toBeInTheDocument()
    expect(screen.getByLabelText('زيادة')).toBeInTheDocument()
    expect(screen.queryByText('إضافة طاولة')).not.toBeInTheDocument()
    expect(screen.queryByText('تعطيل')).not.toBeInTheDocument()
  })

  it('applies an incremented table count', async () => {
    page()
    await waitFor(() => expect(screen.getByLabelText('عدد الطاولات')).toHaveTextContent('12'))
    fireEvent.click(screen.getByLabelText('زيادة'))
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))
    await waitFor(() => expect(mocks.setTableCount).toHaveBeenCalledWith(13))
  })

  it('configures fixed service charge amounts without exposing a stored password', async () => {
    page()
    await waitFor(() => expect(screen.getByLabelText('رسوم الخدمة 1')).toHaveValue(10))
    fireEvent.change(screen.getByLabelText('رسوم الخدمة 1'), { target: { value: '15' } })
    fireEvent.change(screen.getByLabelText('كلمة مرور تفويض الخصم'), {
      target: { value: 'approve123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الإعدادات' }))
    await waitFor(() =>
      expect(mocks.setServiceCharge).toHaveBeenCalledWith({ amounts: [1500, 3000, 5000] }),
    )
    expect(mocks.setDiscountAuthorizationPassword).toHaveBeenCalledWith('approve123')
    expect(screen.queryByDisplayValue('approve123')).not.toBeInTheDocument()
  })

  it('retains the developer database tools', async () => {
    page()
    fireEvent.click(screen.getByRole('button', { name: 'تحميل بيانات رسمية' }))
    await waitFor(() => expect(mocks.loadOfficial).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'مسح قاعدة البيانات بالكامل' }))
    const dialog = screen.getByRole('dialog', { name: 'تأكيد مسح قاعدة البيانات بالكامل' })
    expect(within(dialog).getByText(/سيتم الاحتفاظ بحساب المطور ADMIN فقط/)).toBeInTheDocument()
  })
})
