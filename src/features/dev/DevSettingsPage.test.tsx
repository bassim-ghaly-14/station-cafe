import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import {
  DEFAULT_FORMATTING,
  getFormattingPreferences,
  resetFormattingPreferences,
} from '@/lib/formatting'
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
    resetFormattingPreferences()
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

describe('DevSettingsPage display formatting', () => {
  beforeEach(() => {
    resetFormattingPreferences()
    mocks.user.role = 'ADMIN'
    mocks.serviceCharge.mockResolvedValue({ amounts: [1000] })
    mocks.discountAuthorization.mockResolvedValue({ configured: false })
    mocks.credit.mockResolvedValue({ enabled: true, mode: 'LIST', allowed_customer_ids: [] })
    mocks.tables.mockResolvedValue([])
  })
  afterEach(() => resetFormattingPreferences())

  const save = () => screen.getByTestId('formatting-save')

  it('starts clean: no unsaved marker and a disabled Save action', () => {
    page()
    expect(screen.queryByTestId('formatting-dirty')).not.toBeInTheDocument()
    expect(save()).toBeDisabled()
    expect(screen.getByTestId('formatting-reset-draft')).toBeDisabled()
  })

  it('previews the draft without changing the saved global preferences', () => {
    page()
    fireEvent.change(screen.getByLabelText('عدد الخانات العشرية'), { target: { value: '0' } })

    // The preview follows the draft…
    expect(screen.getByTestId('preview-standard')).toHaveTextContent('1,250 ج.م')
    // …while the saved configuration (read by the whole app) is untouched.
    expect(getFormattingPreferences().money.decimalPlaces).toBe(2)
    expect(screen.getByTestId('formatting-dirty')).toBeInTheDocument()
    expect(save()).toBeEnabled()
  })

  it('commits the draft to the global formatters only on Save', () => {
    page()
    fireEvent.change(screen.getByLabelText('عدد الخانات العشرية'), { target: { value: '0' } })
    fireEvent.click(screen.getByLabelText('فاصل الآلاف'))

    expect(getFormattingPreferences().money.decimalPlaces).toBe(2)

    fireEvent.click(save())

    expect(getFormattingPreferences().money.decimalPlaces).toBe(0)
    expect(getFormattingPreferences().money.useThousandsSeparator).toBe(false)
    // A committed save leaves nothing unsaved.
    expect(screen.queryByTestId('formatting-dirty')).not.toBeInTheDocument()
    expect(save()).toBeDisabled()
  })

  it('discards unsaved edits back to the last saved configuration', () => {
    page()
    fireEvent.change(screen.getByLabelText('عدد الخانات العشرية'), { target: { value: '0' } })
    fireEvent.click(save())
    fireEvent.change(screen.getByLabelText('عدد الخانات العشرية'), { target: { value: '1' } })

    fireEvent.click(screen.getByTestId('formatting-reset-draft'))

    expect((screen.getByLabelText('عدد الخانات العشرية') as HTMLSelectElement).value).toBe('0')
    expect(getFormattingPreferences().money.decimalPlaces).toBe(0)
  })

  it('loads the Station defaults into the draft for preview, then saves them', () => {
    page()
    fireEvent.change(screen.getByLabelText('عدد الخانات العشرية'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('صيغة التاريخ'), { target: { value: 'YYYY-MM-DD' } })

    fireEvent.click(screen.getByTestId('formatting-load-defaults'))

    // Defaults land in the draft, NOT the store.
    expect((screen.getByLabelText('عدد الخانات العشرية') as HTMLSelectElement).value).toBe('2')
    expect(getFormattingPreferences().money.decimalPlaces).toBe(2)

    fireEvent.click(save())
    expect(getFormattingPreferences()).toEqual(DEFAULT_FORMATTING)
  })

  it('demonstrates the compact threshold boundary, not just the number', () => {
    page()
    // Threshold 1,000: 999 stays full while 1,000 crosses into compact.
    expect(screen.getByTestId('preview-below')).toHaveTextContent('999.00 ج.م')
    expect(screen.getByTestId('preview-at')).toHaveTextContent('1 ألف ج.م')

    fireEvent.change(screen.getByLabelText('حد الاختصار'), { target: { value: '10000' } })

    // Raising the threshold to 10,000 moves the boundary: the value that was
    // compact at 1,000 is now rendered in full, and the rows around the new
    // threshold are the ones that flip.
    expect(screen.getByTestId('preview-below')).toHaveTextContent('9,999.00 ج.م')
    expect(screen.getByTestId('preview-at')).toHaveTextContent('10,000.00 ج.م')

    // The large amount only compacts once it clears the higher threshold.
    expect(screen.getByTestId('preview-auto')).toHaveTextContent('1.25 مليون ج.م')
  })

  it('demonstrates currency visibility, position and the date/time combination', () => {
    page()
    expect(screen.getByTestId('preview-standard')).toHaveTextContent('1,250.00 ج.م')

    fireEvent.click(screen.getByLabelText('إظهار العملة'))
    expect(screen.getByTestId('preview-standard')).toHaveTextContent('1,250.00')
    expect(screen.getByTestId('preview-standard')).not.toHaveTextContent('ج.م')

    fireEvent.click(screen.getByLabelText('إظهار العملة'))
    fireEvent.change(screen.getByLabelText('موضع العملة'), { target: { value: 'before' } })
    expect(screen.getByTestId('preview-standard')).toHaveTextContent('ج.م 1,250.00')

    fireEvent.change(screen.getByLabelText('صيغة التاريخ'), { target: { value: 'DD MMM YYYY' } })
    fireEvent.change(screen.getByLabelText('صيغة الوقت'), { target: { value: '12h' } })
    // A long localized date and a 12-hour time are both visible in the preview.
    expect(screen.getByTestId('preview-date')).toHaveTextContent('25 سبتمبر 2026')
    expect(screen.getByTestId('preview-time')).toHaveTextContent('2:35')
  })
})
