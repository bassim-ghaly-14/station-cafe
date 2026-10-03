import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import {
  DEFAULT_FORMATTING,
  getFormattingPreferences,
  reloadFormattingPreferences,
  resetFormattingPreferences,
} from '@/lib/formatting'
import DevSettingsPage from './DevSettingsPage'

const mocks = vi.hoisted(() => ({
  user: { role: 'ADMIN' as 'ADMIN' | 'STAFF' },
  loadOfficial: vi.fn(),
  loadDemo: vi.fn(),
  clear: vi.fn(),
  setReseedToken: vi.fn(),
  clearSessionToken: vi.fn(),
  clearLocalSession: vi.fn(),
  serviceCharge: vi.fn(),
  discountOptions: vi.fn(),
  setDiscountOptions: vi.fn(),
  discountAuthorization: vi.fn(),
  setDiscountPin: vi.fn(),
  setServiceCharge: vi.fn(),
  setCredit: vi.fn(),
  credit: vi.fn(),
  tables: vi.fn(),
  setTableCount: vi.fn(),
  monthlySalesPeriod: vi.fn(),
  setMonthlySalesPeriod: vi.fn(),
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
    loadDemo: mocks.loadDemo,
    clear: mocks.clear,
    setReseedToken: mocks.setReseedToken,
    takeReseedToken: () => null,
    clearReseedToken: vi.fn(),
  },
}))
vi.mock('@/services/posApi', () => ({
  api: { tables: mocks.tables, setTableCount: mocks.setTableCount },
  MONTHLY_SALES_PERIOD_MONTHS: [6, 12, 18, 24],
  settingsApi: {
    serviceCharge: mocks.serviceCharge,
    discountOptions: mocks.discountOptions,
    setDiscountOptions: mocks.setDiscountOptions,
    discountAuthorization: mocks.discountAuthorization,
    setDiscountPin: mocks.setDiscountPin,
    setServiceCharge: mocks.setServiceCharge,
    setCredit: mocks.setCredit,
    credit: mocks.credit,
    monthlySalesPeriod: mocks.monthlySalesPeriod,
    setMonthlySalesPeriod: mocks.setMonthlySalesPeriod,
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
    mocks.loadDemo.mockReset().mockResolvedValue(undefined)
    mocks.clear.mockReset().mockResolvedValue('one-time-grant')
    mocks.setReseedToken.mockReset()
    mocks.clearSessionToken.mockReset()
    mocks.clearLocalSession.mockReset()
    mocks.serviceCharge.mockReset().mockResolvedValue({ amounts: [1000, 3000, 5000] })
    mocks.discountOptions.mockReset().mockResolvedValue({ amounts: [2000, 5000] })
    mocks.setDiscountOptions.mockReset().mockResolvedValue(undefined)
    mocks.discountAuthorization.mockReset().mockResolvedValue({ configured: false })
    mocks.setDiscountPin.mockReset().mockResolvedValue(undefined)
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
    mocks.monthlySalesPeriod.mockReset().mockResolvedValue({ months: 12 })
    mocks.setMonthlySalesPeriod.mockReset().mockResolvedValue(undefined)
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
    // Scoped to the tables card: every settings group owns its own save.
    fireEvent.click(within(screen.getByTestId('dev-tables')).getByRole('button', { name: 'حفظ' }))
    await waitFor(() => expect(mocks.setTableCount).toHaveBeenCalledWith(13))
  })

  it('configures fixed service charge amounts and quick-pick discounts only', async () => {
    page()
    await waitFor(() => expect(screen.getByLabelText('رسوم الخدمة 1')).toHaveValue(10))
    fireEvent.change(screen.getByLabelText('رسوم الخدمة 1'), { target: { value: '15' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الإعدادات' }))
    await waitFor(() =>
      expect(mocks.setServiceCharge).toHaveBeenCalledWith({ amounts: [1500, 3000, 5000] }),
    )
    // The shared discount PIN is a GLOBAL setting on this page, and it is a
    // 4-digit PIN — not a password field on any individual staff member.
    expect(screen.getByRole('heading', { name: 'رمز تفويض الخصم' })).toBeInTheDocument()
    expect(screen.queryByLabelText('كلمة مرور تفويض الخصم')).not.toBeInTheDocument()
  })

  it('configures the ONE shared 4-digit discount PIN, cafe-wide', async () => {
    page()
    await waitFor(() => expect(mocks.discountAuthorization).toHaveBeenCalled())

    // Status is a boolean only — the PIN is never read back.
    expect(screen.getByText('غير مُعدّ')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'تعيين الرمز' }))

    const field = within(screen.getByRole('dialog')).getByLabelText('رمز تفويض الخصم')
    expect(field).toHaveAttribute('inputmode', 'numeric')
    expect(field).toHaveAttribute('maxlength', '4')

    // Fewer than four digits cannot be saved.
    fireEvent.change(field, { target: { value: '009' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'حفظ' }))
    expect(mocks.setDiscountPin).not.toHaveBeenCalled()

    // A leading-zero PIN is sent exactly as typed, as a string.
    fireEvent.change(field, { target: { value: '0097' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'حفظ' }))

    await waitFor(() => expect(mocks.setDiscountPin).toHaveBeenCalledWith('0097'))
    await waitFor(() => expect(screen.getByText('مُعدّ')).toBeInTheDocument())
  })

  it('clears the PIN complaint as soon as the entry is corrected, and discards the draft on close', async () => {
    page()
    await waitFor(() => expect(mocks.discountAuthorization).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'تعيين الرمز' }))
    const field = within(screen.getByRole('dialog')).getByLabelText('رمز تفويض الخصم')

    // A backend refusal is shown under the field…
    mocks.setDiscountPin.mockRejectedValueOnce({ message: 'db.error' })
    fireEvent.change(field, { target: { value: '0097' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'حفظ' }))
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toBeInTheDocument()

    // …and a new keystroke clears it, so a corrected field is not still
    // covered by a complaint about the old entry.
    fireEvent.change(field, { target: { value: '0098' } })
    expect(within(screen.getByRole('dialog')).queryByRole('alert')).not.toBeInTheDocument()

    // Cancelling throws the draft away rather than keeping it for next time.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'إلغاء' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'تعيين الرمز' }))
    expect(within(screen.getByRole('dialog')).getByLabelText('رمز تفويض الخصم')).toHaveValue('')
  })

  it('keeps the developer data actions inside a labelled Danger Zone', async () => {
    page()
    await waitFor(() => expect(mocks.discountAuthorization).toHaveBeenCalled())

    const zone = screen.getByTestId('dev-danger-zone')
    // The zone is a real landmark, not just a styled <div>.
    expect(zone.tagName).toBe('SECTION')
    expect(zone).toHaveAttribute('aria-labelledby', 'dev-danger-zone')
    expect(within(zone).getByRole('heading', { name: 'منطقة الخطر' })).toBeInTheDocument()

    // All three data actions live here and nowhere else on the page.
    expect(within(zone).getByRole('button', { name: 'تحميل البيانات الرسمية' })).toBeInTheDocument()
    expect(within(zone).getByRole('button', { name: 'تحميل بيانات تجريبية' })).toBeInTheDocument()
    expect(within(zone).getByRole('button', { name: 'مسح قاعدة البيانات' })).toBeInTheDocument()
  })

  /**
   * The official and demo loaders must be impossible to confuse: different
   * commands, different labels, and the demo one gated behind its own
   * confirmation.
   */
  it('keeps "Load Demo Data" clearly separate from "Load Official Data"', async () => {
    page()
    await waitFor(() => expect(mocks.discountAuthorization).toHaveBeenCalled())

    const zone = screen.getByTestId('dev-danger-zone')
    const demoButton = within(zone).getByRole('button', { name: 'تحميل بيانات تجريبية' })
    const officialButton = within(zone).getByRole('button', { name: 'تحميل البيانات الرسمية' })

    // Distinct, unambiguous labels — one is never a substring of the other.
    expect(demoButton).not.toBe(officialButton)
    expect(demoButton.textContent).not.toBe(officialButton.textContent)

    // Clicking the DEMO button must never call the OFFICIAL loader.
    fireEvent.click(demoButton)
    expect(mocks.loadOfficial).not.toHaveBeenCalled()
    expect(mocks.loadDemo).not.toHaveBeenCalled()

    // …and clicking the OFFICIAL one must never call the demo loader.
    fireEvent.click(officialButton)
    await waitFor(() => expect(mocks.loadOfficial).toHaveBeenCalledTimes(1))
    expect(mocks.loadDemo).not.toHaveBeenCalled()
  })

  it('requires an explicit confirmation before loading demo data', async () => {
    page()
    const zone = screen.getByTestId('dev-danger-zone')

    // First click opens the confirmation and changes nothing.
    fireEvent.click(within(zone).getByRole('button', { name: 'تحميل بيانات تجريبية' }))
    expect(mocks.loadDemo).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog', { name: 'تأكيد تحميل البيانات التجريبية' })
    // The warning must state that real data is destroyed and unrecoverable.
    expect(within(dialog).getByText(/سيتم حذفها نهائيًا/)).toBeInTheDocument()
    expect(within(dialog).getByText(/لا يمكن التراجع عنه/)).toBeInTheDocument()
    // …and that the session ends, so the way back in must be shown.
    expect(within(dialog).getByText('admin / 1234 — مدير النظام')).toBeInTheDocument()

    // Cancelling must not load anything.
    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mocks.loadDemo).not.toHaveBeenCalled()

    // Confirming performs the load and drops the destroyed session.
    fireEvent.click(within(zone).getByRole('button', { name: 'تحميل بيانات تجريبية' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'تأكيد التحميل' }),
    )
    await waitFor(() => expect(mocks.loadDemo).toHaveBeenCalledTimes(1))
    expect(mocks.clearLocalSession).toHaveBeenCalled()
  })

  it('surfaces a demo load failure in Arabic instead of reporting success', async () => {
    mocks.loadDemo.mockRejectedValueOnce({ message: 'db.error' })
    page()

    const zone = screen.getByTestId('dev-danger-zone')
    fireEvent.click(within(zone).getByRole('button', { name: 'تحميل بيانات تجريبية' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'تأكيد التحميل' }),
    )

    expect(await screen.findByText('تعذر حفظ البيانات — حاول مرة أخرى')).toBeInTheDocument()
    // A failed load must NOT drop the session, exactly like a failed clear.
    expect(mocks.clearLocalSession).not.toHaveBeenCalled()
  })

  it('loads the official data through the developer API exactly once per click', async () => {
    page()
    const zone = screen.getByTestId('dev-danger-zone')
    fireEvent.click(within(zone).getByRole('button', { name: 'تحميل البيانات الرسمية' }))

    await waitFor(() => expect(mocks.loadOfficial).toHaveBeenCalledTimes(1))
  })

  it('surfaces a Clear Database failure in Arabic instead of reporting success', async () => {
    mocks.clear.mockRejectedValueOnce({ message: 'db.error' })
    page()

    const zone = screen.getByTestId('dev-danger-zone')
    fireEvent.click(within(zone).getByRole('button', { name: 'مسح قاعدة البيانات' }))

    const dialog = screen.getByRole('dialog', { name: 'تأكيد مسح قاعدة البيانات بالكامل' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد المسح' }))

    // A failed reset must NOT look like a success, and must not drop the
    // one-time reseed grant as though the database had been cleared.
    await waitFor(() => expect(mocks.clearSessionToken).not.toHaveBeenCalled())
    expect(mocks.setReseedToken).not.toHaveBeenCalled()
    expect(await screen.findByText('تعذر حفظ البيانات — حاول مرة أخرى')).toBeInTheDocument()
  })

  it('describes the real scope of the reset and requires confirmation', async () => {
    page()
    const zone = screen.getByTestId('dev-danger-zone')

    // Nothing destructive happens on the first click.
    fireEvent.click(within(zone).getByRole('button', { name: 'مسح قاعدة البيانات' }))
    expect(mocks.clear).not.toHaveBeenCalled()

    const dialog = screen.getByRole('dialog', { name: 'تأكيد مسح قاعدة البيانات بالكامل' })
    // The warning must state what SURVIVES, matching the backend behaviour that
    // preserves the schema, the migrations and the developer account.
    expect(within(dialog).getByText(/حساب المطور ADMIN فقط/)).toBeInTheDocument()
    expect(within(dialog).getByText(/بنية قاعدة البيانات وترحيلها/)).toBeInTheDocument()
    expect(within(dialog).getByText(/لا يمكن التراجع عنه/)).toBeInTheDocument()

    // Cancelling must not clear anything.
    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it('runs the confirmed reset and refreshes the page state afterwards', async () => {
    page()
    await waitFor(() => expect(screen.getByLabelText('عدد الطاولات')).toHaveTextContent('12'))

    const zone = screen.getByTestId('dev-danger-zone')
    fireEvent.click(within(zone).getByRole('button', { name: 'مسح قاعدة البيانات' }))
    const dialog = screen.getByRole('dialog', { name: 'تأكيد مسح قاعدة البيانات بالكامل' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد المسح' }))

    await waitFor(() => expect(mocks.clear).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mocks.clearSessionToken).toHaveBeenCalled())

    // The reset empties app_settings and cafe_tables, so the page must not keep
    // showing the pre-reset table count.
    await waitFor(() => expect(screen.getByLabelText('عدد الطاولات')).toHaveTextContent('0'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('blocks duplicate execution while a data action is in flight', async () => {
    let resolveClear: (value: string) => void = () => {}
    mocks.clear.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveClear = resolve
      }),
    )
    page()

    const zone = screen.getByTestId('dev-danger-zone')
    const clearButton = within(zone).getByRole('button', { name: 'مسح قاعدة البيانات' })
    fireEvent.click(clearButton)

    const dialog = screen.getByRole('dialog', { name: 'تأكيد مسح قاعدة البيانات بالكامل' })
    const confirm = within(dialog).getByRole('button', { name: 'تأكيد المسح' })
    fireEvent.click(confirm)

    // While the reset runs, the confirm button is busy and the sibling action is
    // disabled, so a second destructive click cannot be queued behind it.
    await waitFor(() => expect(confirm).toBeDisabled())
    expect(within(zone).getByRole('button', { name: 'تحميل البيانات الرسمية' })).toBeDisabled()
    expect(mocks.clear).toHaveBeenCalledTimes(1)

    resolveClear('one-time-grant')
    await waitFor(() => expect(mocks.clear).toHaveBeenCalledTimes(1))
  })
})

describe('DevSettingsPage display formatting', () => {
  beforeEach(() => {
    resetFormattingPreferences()
    mocks.user.role = 'ADMIN'
    mocks.serviceCharge.mockResolvedValue({ amounts: [1000] })
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

  it('shows the configured monthly sales window, defaulting to twelve months', async () => {
    page()

    const select = await screen.findByLabelText('عدد الشهور')
    expect(select).toHaveValue('12')
    // The supported set is offered as a closed choice, so a nonsensical window
    // can never be typed in the first place.
    expect(Array.from((select as HTMLSelectElement).options).map((option) => option.value)).toEqual(
      ['6', '12', '18', '24'],
    )
  })

  it('persists a chosen monthly window through the settings API', async () => {
    mocks.monthlySalesPeriod.mockResolvedValue({ months: 24 })
    page()

    const select = await screen.findByLabelText('عدد الشهور')
    // A stored value is read back, not reset to a hard-coded default.
    expect(select).toHaveValue('24')

    fireEvent.change(select, { target: { value: '6' } })
    // Nothing is stored until it is saved, like every other setting here.
    expect(mocks.setMonthlySalesPeriod).not.toHaveBeenCalled()
    // Scoped to this card: the page has one save button per settings group.
    fireEvent.click(
      within(screen.getByTestId('dev-monthly-period')).getByRole('button', { name: 'حفظ' }),
    )

    await waitFor(() => expect(mocks.setMonthlySalesPeriod).toHaveBeenCalledWith({ months: 6 }))
  })

  it('falls back to twelve months when the setting cannot be read', async () => {
    mocks.monthlySalesPeriod.mockRejectedValue({ message: 'db.error' })
    page()

    expect(await screen.findByLabelText('عدد الشهور')).toHaveValue('12')
  })

  it('restores the last saved window when the backend refuses the new one', async () => {
    mocks.setMonthlySalesPeriod.mockRejectedValue({
      message: 'settings.invalid_monthly_sales_period',
    })
    page()

    const select = await screen.findByLabelText('عدد الشهور')
    fireEvent.change(select, { target: { value: '18' } })
    fireEvent.click(
      within(screen.getByTestId('dev-monthly-period')).getByRole('button', { name: 'حفظ' }),
    )

    // The control snaps back to the last value the backend accepted, and the
    // failure is reported instead of being swallowed.
    await waitFor(() => expect(screen.getByLabelText('عدد الشهور')).toHaveValue('12'))
    expect(
      screen.getByText('عدد شهور الرسم البياني يجب أن يكون 6 أو 12 أو 18 أو 24'),
    ).toBeInTheDocument()
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
    // The previewed instant is rendered in Station business time (Cairo), so
    // the same stamp reads 5:35 م here and on a printed receipt.
    expect(screen.getByTestId('preview-time')).toHaveTextContent('5:35')
  })

  /* Every boolean on this page must be the ONE shared Switch, so a manager
     meets the same control in Settings, the catalog dialogs and Expenses.
     These assert the rendered semantics (role, accessible name, ON/OFF, and
     the standardized tone classes) rather than any internal structure. */
  const SETTINGS_SWITCHES = [
    'تفعيل الدفع الآجل',
    'فاصل الآلاف',
    'إظهار العملة',
    'القيم المختصرة',
    'إظهار الثواني',
  ] as const

  it.each(SETTINGS_SWITCHES)('renders %s through the shared Switch as a real switch', (label) => {
    page()
    const control = screen.getByRole('switch', { name: label })

    // A real switch button, not a styled checkbox or a div.
    expect(control.tagName).toBe('BUTTON')
    expect(control).toHaveAttribute('aria-checked')
    expect(control.className).toContain('focus-visible:outline-focus')
  })

  it.each(SETTINGS_SWITCHES)('paints %s with the standardized state tone', (label) => {
    page()
    const control = screen.getByRole('switch', { name: label })

    // Whichever way it starts, the track is one half of the standardized
    // green/neutral pair — never the old brown accent, never NEW magenta.
    expect(control.className).toMatch(/bg-switch-(on|off)-track/)
    expect(control.className).not.toMatch(/bg-accent|bg-new|bg-surface-muted/)
  })

  it.each(SETTINGS_SWITCHES)('keeps %s keyboard-operable and reversible', (label) => {
    page()
    const control = screen.getByRole('switch', { name: label })
    const before = control.getAttribute('aria-checked')

    // A native button answers Enter/Space with a click, which is the whole
    // keyboard contract; state must flip and be announced.
    fireEvent.click(control)
    expect(control).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true')

    fireEvent.click(control)
    expect(control).toHaveAttribute('aria-checked', before as string)
  })
})

describe('DevSettingsPage chart bar colours', () => {
  beforeEach(() => {
    resetFormattingPreferences()
    mocks.user.role = 'ADMIN'
    mocks.serviceCharge.mockResolvedValue({ amounts: [1000] })
    mocks.credit.mockResolvedValue({ enabled: true, mode: 'LIST', allowed_customer_ids: [] })
    mocks.tables.mockResolvedValue([])
  })
  afterEach(() => resetFormattingPreferences())

  /** The text field of the PRIMARY role — the one a developer types into. */
  function primaryField() {
    return document.getElementById('chart-color-primary') as HTMLInputElement
  }

  it('offers one control per centralized role, labelled in Arabic', () => {
    page()

    expect(screen.getByTestId('dev-chart-colors')).toBeInTheDocument()
    for (const label of [
      'اللون الأساسي',
      'اللون الثانوي',
      'اللون الثالث',
      'اللون الرابع',
      'لون المبيعات',
      'لون المصروفات',
      // The multi-expense day is configured here like every other role — there
      // is no second place a chart colour can be changed from.
      'لون اليوم متعدد المصروفات',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument()
    }
  })

  it('repaints the multi-expense day through the same centralized write', () => {
    page()
    const field = document.getElementById('chart-color-expensesMultiple') as HTMLInputElement
    expect(field.value).toBe('var(--primary)')

    fireEvent.change(field, { target: { value: '#123456' } })
    fireEvent.click(screen.getByTestId('chart-colors-save'))

    // One write onto the one custom property, and every bar painted with it
    // follows — the same mechanism, the same card, the same save.
    expect(document.documentElement.style.getPropertyValue('--chart-bar-expenses-multiple')).toBe(
      '#123456',
    )
    expect(getFormattingPreferences().charts.expensesMultiple).toBe('#123456')
  })

  it('edits an unsaved draft and publishes only on save', () => {
    page()

    fireEvent.change(primaryField(), { target: { value: '#123456' } })

    // The document still paints the theme's own value: experimenting never
    // repaints the charts behind the operator's back.
    expect(document.documentElement.style.getPropertyValue('--chart-bar-primary')).toBe('')
    expect(screen.getByTestId('chart-colors-dirty')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('chart-colors-save'))

    // The one write every chart in the application reads.
    expect(document.documentElement.style.getPropertyValue('--chart-bar-primary')).toBe('#123456')
    expect(getFormattingPreferences().charts.primary).toBe('#123456')
    expect(screen.queryByTestId('chart-colors-dirty')).not.toBeInTheDocument()
  })

  it('refuses a value a browser could not paint and keeps the previous colours', () => {
    page()

    fireEvent.change(primaryField(), { target: { value: 'definitely-not-a-color' } })
    fireEvent.click(screen.getByTestId('chart-colors-save'))

    expect(screen.getByText(/قيمة اللون غير صحيحة/, { exact: false })).toBeInTheDocument()
    expect(document.documentElement.style.getPropertyValue('--chart-bar-primary')).toBe('')
  })

  it('restores the theme colours on demand', () => {
    page()

    fireEvent.change(primaryField(), { target: { value: '#123456' } })
    fireEvent.click(screen.getByTestId('chart-colors-save'))
    fireEvent.click(screen.getByTestId('chart-colors-load-defaults'))

    // The override is REMOVED, so the role follows light/dark mode again.
    expect(document.documentElement.style.getPropertyValue('--chart-bar-primary')).toBe('')
    expect(getFormattingPreferences().charts.primary).toBe('var(--primary)')
  })

  describe('amount list validation', () => {
    // These lists drive the quick-pick buttons, so a blank, a non-number, a
    // non-positive amount or a duplicate would all put a broken button on the
    // POS. The page refuses the whole save rather than writing a bad list.
    const saveSettings = () =>
      fireEvent.click(screen.getByRole('button', { name: 'حفظ الإعدادات' }))

    it('refuses a blank service charge and writes nothing', async () => {
      page()
      await waitFor(() => expect(screen.getByLabelText('رسوم الخدمة 1')).toHaveValue(10))
      fireEvent.change(screen.getByLabelText('رسوم الخدمة 1'), { target: { value: '' } })
      saveSettings()
      await waitFor(() => expect(mocks.setServiceCharge).not.toHaveBeenCalled())
      expect(mocks.setDiscountOptions).not.toHaveBeenCalled()
    })

    it('refuses a duplicate amount, which would render two identical quick picks', async () => {
      page()
      await waitFor(() => expect(screen.getByLabelText('رسوم الخدمة 1')).toHaveValue(10))
      // Add a second entry and type the same amount as the first: two identical
      // quick picks would be a dead button on the POS.
      fireEvent.click(screen.getByRole('button', { name: 'إضافة مبلغ خدمة' }))
      await waitFor(() => expect(screen.getByLabelText('رسوم الخدمة 2')).toBeInTheDocument())
      fireEvent.change(screen.getByLabelText('رسوم الخدمة 2'), { target: { value: '10' } })
      saveSettings()
      await waitFor(() => expect(mocks.setServiceCharge).not.toHaveBeenCalled())
    })

    it('refuses a non-positive amount', async () => {
      page()
      await waitFor(() => expect(screen.getByLabelText('رسوم الخدمة 1')).toHaveValue(10))
      fireEvent.change(screen.getByLabelText('رسوم الخدمة 1'), { target: { value: '0' } })
      saveSettings()
      await waitFor(() => expect(mocks.setServiceCharge).not.toHaveBeenCalled())
    })

    it('refuses a blank discount option independently of the service list', async () => {
      page()
      await waitFor(() => expect(screen.getByLabelText('رسوم الخدمة 1')).toHaveValue(10))
      fireEvent.change(screen.getByLabelText('مبالغ الخصم السريعة 1'), { target: { value: '' } })
      saveSettings()
      // The service list was fine, but the save is all-or-nothing: a bad
      // discount list must not be persisted alongside a good service list.
      await waitFor(() => expect(mocks.setDiscountOptions).not.toHaveBeenCalled())
      expect(mocks.setServiceCharge).not.toHaveBeenCalled()
    })

    it('still saves a valid list after a rejected attempt', async () => {
      page()
      await waitFor(() => expect(screen.getByLabelText('رسوم الخدمة 1')).toHaveValue(10))
      fireEvent.change(screen.getByLabelText('رسوم الخدمة 1'), { target: { value: '' } })
      saveSettings()
      await waitFor(() => expect(mocks.setServiceCharge).not.toHaveBeenCalled())

      fireEvent.change(screen.getByLabelText('رسوم الخدمة 1'), { target: { value: '12' } })
      saveSettings()
      await waitFor(() => expect(mocks.setServiceCharge).toHaveBeenCalledWith({ amounts: [1200] }))
    })
  })
})

/**
 * The amount rows `DevAmountList` renders for Service Charge and for Discount.
 *
 * THE RULE: a whole amount. The field is the one that already exists — the same
 * `<input>` the page has always shown, with the same reorder and remove buttons
 * beside it. No second field, no second set of controls, and the increment /
 * decrement behaviour comes from the input's own `step={1}` arrows.
 *
 * THE REGRESSION THIS ALSO PINS: the row used to be keyed by the amount it
 * displayed, so the one keystroke that changed the value also changed the key.
 * React unmounted that row and mounted a fresh `<input>`, destroying the field
 * the manager was typing into after exactly one character. The index is now the
 * row's identity, so `100` goes in in one go.
 */
describe('DevAmountList whole-amount amounts', () => {
  const SERVICE = 'رسوم الخدمة'
  const DISCOUNT = 'مبالغ الخصم السريعة'

  beforeEach(() => {
    resetFormattingPreferences()
    mocks.user.role = 'ADMIN'
    // Every setting the page loads at mount, so the lists actually arrive: a
    // mock left over from another suite would reject the whole Promise.all.
    mocks.serviceCharge.mockReset().mockResolvedValue({ amounts: [1000, 3000, 5000] })
    mocks.discountOptions.mockReset().mockResolvedValue({ amounts: [2000, 5000] })
    mocks.discountAuthorization.mockReset().mockResolvedValue({ configured: false })
    mocks.setDiscountOptions.mockReset().mockResolvedValue(undefined)
    mocks.setServiceCharge.mockReset().mockResolvedValue(undefined)
    mocks.credit
      .mockReset()
      .mockResolvedValue({ enabled: true, mode: 'LIST', allowed_customer_ids: [] })
    mocks.tables.mockReset().mockResolvedValue([])
    mocks.monthlySalesPeriod.mockReset().mockResolvedValue({ months: 12 })
  })

  /** The nth amount field of a list, addressed the way a screen reader reads it. */
  const field = (label: string, index: number) =>
    screen.getByLabelText(`${label} ${index}`) as HTMLInputElement

  /**
   * The input's own stepper arrows. jsdom implements `stepUp`/`stepDown` with
   * the element's real `step`, and dispatches no `change` for them, so the event
   * is fired here to reach React — the same sequence a real click produces.
   */
  function spin(input: HTMLInputElement, delta: 1 | -1, times = 1) {
    for (let i = 0; i < times; i += 1) {
      if (delta === 1) input.stepUp()
      else input.stepDown()
      fireEvent.change(input)
    }
  }

  describe.each([
    // [name, field label prefix, the first amount the backend hands back]
    ['Service Charge', SERVICE, 10],
    ['Discount', DISCOUNT, 20],
  ])('%s amounts', (_name, label, loaded) => {
    it('accepts the whole amounts a manager actually types', async () => {
      page()
      await waitFor(() => expect(field(label, 1)).toHaveValue(loaded))

      for (const amount of [10, 100, 500]) {
        fireEvent.change(field(label, 1), { target: { value: '' } })
        fireEvent.change(field(label, 1), { target: { value: String(amount) } })
        expect(field(label, 1)).toHaveValue(amount)
      }
    })

    it('refuses a decimal instead of rounding it', async () => {
      page()
      await waitFor(() => expect(field(label, 1)).toHaveValue(loaded))

      // 10.5 must not become 11 and 100.25 must not become 100: a rounded value
      // is a different amount from the one that was typed. The field keeps
      // whatever whole amount it was already showing.
      fireEvent.change(field(label, 1), { target: { value: '10.5' } })
      expect(field(label, 1)).toHaveValue(loaded)

      fireEvent.change(field(label, 1), { target: { value: '100.25' } })
      expect(field(label, 1)).toHaveValue(loaded)
    })

    it('refuses the numeric formats that are not integer input here', async () => {
      page()
      await waitFor(() => expect(field(label, 1)).toHaveValue(loaded))

      // `type="number"` holds all of these happily, which is exactly why the
      // value has to be checked rather than trusted. A lone "+", a lone "-", a
      // comma and hex are absent on purpose: the field sanitises those to "",
      // which is indistinguishable from a deliberate clear, so they are stopped
      // as keys in the test below instead.
      for (const rejected of ['1e2', '1E2', '-10']) {
        fireEvent.change(field(label, 1), { target: { value: rejected } })
        expect(field(label, 1).value).not.toBe(rejected)
        expect(field(label, 1)).toHaveValue(loaded)
      }
    })

    it('stops a sign, a decimal point and an exponent as keystrokes', async () => {
      page()
      await waitFor(() => expect(field(label, 1)).toHaveValue(loaded))
      const input = field(label, 1)
      input.focus()

      // A number field SANITISES a lone "+" or "-" to "", byte-for-byte what a
      // deliberate clear reports, so the value rule above cannot catch it
      // without making the field impossible to empty. The key is stopped while
      // it is still identifiable; `fireEvent` returns false once prevented.
      for (const key of ['.', ',', 'e', 'E', '+', '-', 'a']) {
        expect(fireEvent.keyDown(input, { key })).toBe(false)
      }

      expect(input).toHaveValue(loaded)
      // The guard stops the KEY, not the field: digits and the editing keys
      // still work, so the amount stays typable and clearable.
      expect(fireEvent.keyDown(input, { key: '5' })).toBe(true)
      expect(fireEvent.keyDown(input, { key: 'Backspace' })).toBe(true)
    })

    it('increments a whole amount by exactly one', async () => {
      page()
      await waitFor(() => expect(field(label, 1)).toHaveValue(loaded))

      fireEvent.change(field(label, 1), { target: { value: '10' } })
      spin(field(label, 1), 1)
      // Never 10.1, and never the string "101" from `"10" + 1`.
      expect(field(label, 1)).toHaveValue(11)
      expect(field(label, 1).value).toBe('11')
    })

    it('decrements a whole amount by exactly one', async () => {
      page()
      await waitFor(() => expect(field(label, 1)).toHaveValue(loaded))

      fireEvent.change(field(label, 1), { target: { value: '10' } })
      spin(field(label, 1), -1)
      expect(field(label, 1)).toHaveValue(9)
      expect(field(label, 1).value).toBe('9')
    })

    it('steps up and back down by one whole step each time', async () => {
      page()
      await waitFor(() => expect(field(label, 1)).toHaveValue(loaded))

      fireEvent.change(field(label, 1), { target: { value: '10' } })
      const input = field(label, 1)

      spin(input, 1, 2)
      expect(input).toHaveValue(12)

      spin(input, -1)
      expect(input).toHaveValue(11)

      spin(input, -1)
      expect(input).toHaveValue(10)
      expect(input.value).toBe('10')
    })

    it('keeps the SAME DOM node and the focus across continuous typing', async () => {
      page()
      const originalNode = await screen.findByLabelText(`${label} 1`)
      const input = originalNode as HTMLInputElement
      input.focus()

      // Start from empty, the way a manager does before typing a fresh amount.
      fireEvent.change(input, { target: { value: '' } })

      for (const char of '100') {
        fireEvent.change(input, { target: { value: `${input.value}${char}` } })
        // THE assertion that matters: still the same element, still focused.
        expect(screen.getByLabelText(`${label} 1`)).toBe(originalNode)
        expect(document.activeElement).toBe(originalNode)
      }

      expect(originalNode).toHaveValue(100)
    })
  })

  it('adds a new amount row that is whole-amount only too', async () => {
    page()
    await waitFor(() => expect(field(SERVICE, 1)).toHaveValue(10))

    fireEvent.click(screen.getByRole('button', { name: 'إضافة مبلغ خدمة' }))
    const added = await screen.findByLabelText(`${SERVICE} 4`)
    expect(added).toHaveValue(null)

    fireEvent.change(added, { target: { value: '250' } })
    expect(field(SERVICE, 4)).toHaveValue(250)

    fireEvent.change(field(SERVICE, 4), { target: { value: '250.75' } })
    expect(field(SERVICE, 4)).toHaveValue(250)
  })

  it('saves a typed whole amount, never a fraction', async () => {
    page()
    await waitFor(() => expect(field(SERVICE, 1)).toHaveValue(10))

    fireEvent.change(field(SERVICE, 1), { target: { value: '10' } })
    // The fraction typed straight after is refused, so 10 is what is saved.
    fireEvent.change(field(SERVICE, 1), { target: { value: '10.5' } })
    expect(field(SERVICE, 1)).toHaveValue(10)

    fireEvent.click(screen.getByRole('button', { name: 'حفظ الإعدادات' }))
    await waitFor(() =>
      expect(mocks.setServiceCharge).toHaveBeenCalledWith({ amounts: [1000, 3000, 5000] }),
    )
  })

  it('leaves the existing row controls exactly where they were', async () => {
    page()
    await waitFor(() => expect(field(SERVICE, 1)).toHaveValue(10))

    const row = field(SERVICE, 1).closest('div') as HTMLElement
    // One input, the two reorder buttons and the remove button — no second
    // field and no duplicate +/- pair introduced by the whole-amount rule.
    expect(row.querySelectorAll('input')).toHaveLength(1)
    expect(within(row).getByLabelText('تحريك المبلغ للأعلى')).toBeInTheDocument()
    expect(within(row).getByLabelText('تحريك المبلغ للأسفل')).toBeInTheDocument()
    expect(within(row).getByLabelText('حذف مبلغ الخدمة')).toBeInTheDocument()

    // The discount list is not reorderable, and that is unchanged.
    const discountRow = field(DISCOUNT, 1).closest('div') as HTMLElement
    expect(discountRow.querySelectorAll('input')).toHaveLength(1)
    expect(within(discountRow).queryByLabelText('تحريك المبلغ للأعلى')).not.toBeInTheDocument()
    expect(within(discountRow).getByLabelText('حذف مبلغ الخصم')).toBeInTheDocument()
  })

  it('leaves the table count presentation exactly as it was', async () => {
    page()
    // Still the read-only <output> with its own +/- buttons: the whole-amount
    // rule is about the amount rows, not about this control.
    const tableCount = await screen.findByLabelText('عدد الطاولات')
    expect(tableCount.tagName).toBe('OUTPUT')
    expect(tableCount).toHaveTextContent('0')
    expect(screen.getByLabelText('زيادة')).toBeInTheDocument()
    expect(screen.getByLabelText('إنقاص')).toBeInTheDocument()
  })

  it('places Application Updates last, after the Danger Zone', async () => {
    page()
    // Compared through the semantic test ids the sections already carry, so the
    // assertion cannot pass or fail on a class name or a DOM depth.
    const danger = screen.getByTestId('dev-danger-zone')
    const updates = await screen.findByTestId('dev-application-updates')

    // Document order: updates come after the Danger Zone.
    expect(danger.compareDocumentPosition(updates) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Same structural level: a direct child of the page container, exactly as
    // LocalAccessCard is. Not nested inside another card or section.
    expect(updates.parentElement).toBe(danger.parentElement)
    expect(updates.parentElement).toBe(screen.getByTestId('dev-local-access').parentElement)

    // The pages' own sections are untouched by the addition.
    expect(screen.getByTestId('dev-danger-zone')).toBeInTheDocument()
    expect(screen.getByTestId('dev-local-access')).toBeInTheDocument()
  })

  /**
   * The worked-duration mode is a DISPLAY preference with its own card and its
   * own Save, because the employees surface reads it and the money/date form
   * never do. These tests assert the contract the requirement names: two modes,
   * an explicit save, and persistence through the existing settings store.
   */
  describe('the work-hours display setting', () => {
    it('offers exactly two modes, with the saved one selected', async () => {
      page()
      const card = await screen.findByTestId('dev-work-duration')

      const modes = within(card).getAllByRole('radio')
      expect(modes).toHaveLength(2)
      expect(within(card).getByLabelText('دقائق')).toBeInTheDocument()
      expect(within(card).getByLabelText('ساعات')).toBeInTheDocument()
      // The default is hours, which is what the app displayed before the setting
      // existed, so an existing installation does not change presentation.
      expect(within(card).getByLabelText('ساعات')).toBeChecked()
      expect(within(card).getByLabelText('دقائق')).not.toBeChecked()
    })

    it('saves nothing until the change is saved', async () => {
      page()
      const card = await screen.findByTestId('dev-work-duration')

      fireEvent.click(within(card).getByLabelText('دقائق'))

      // Choosing is not saving: the store still holds the previous mode.
      expect(getFormattingPreferences().workDuration.display).toBe('hours')
      // …and the Save button is the thing that commits it.
      expect(within(card).getByRole('button', { name: 'حفظ' })).toBeEnabled()

      fireEvent.click(within(card).getByRole('button', { name: 'حفظ' }))

      await waitFor(() => expect(getFormattingPreferences().workDuration.display).toBe('minutes'))
    })

    it('does not offer a save when nothing changed', async () => {
      page()
      const card = await screen.findByTestId('dev-work-duration')

      expect(within(card).getByRole('button', { name: 'حفظ' })).toBeDisabled()
    })

    it('persists through the shared store, not a new mechanism', async () => {
      page()
      const card = await screen.findByTestId('dev-work-duration')
      fireEvent.click(within(card).getByLabelText('دقائق'))
      fireEvent.click(within(card).getByRole('button', { name: 'حفظ' }))

      await waitFor(() => expect(getFormattingPreferences().workDuration.display).toBe('minutes'))

      // A restart re-reads the same key the money and date settings use, and the
      // mode comes back with them.
      expect(reloadFormattingPreferences().workDuration.display).toBe('minutes')
      // The default lives in the one shared default object, so the two settings
      // cannot drift apart.
      expect(DEFAULT_FORMATTING.workDuration.display).toBe('hours')
    })
  })
})
