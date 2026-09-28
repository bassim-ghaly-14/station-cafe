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

    // Both data actions live here and nowhere else on the page.
    expect(within(zone).getByRole('button', { name: 'تحميل البيانات الرسمية' })).toBeInTheDocument()
    expect(within(zone).getByRole('button', { name: 'مسح قاعدة البيانات' })).toBeInTheDocument()
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
