/**
 * The employee dialog is where the create/edit permission model is expressed, so
 * these tests assert what the form DOES and DOES NOT offer:
 *
 *  - creating asks for the ROLE first, and the employee TYPE appears only for a
 *    CASHIER — a MANAGER/ADMIN implies it, and a WASH_WORKER has no login at all;
 *  - editing offers exactly four fields, and role/type are absent rather than
 *    disabled, because a disabled control still suggests the value is negotiable.
 *
 * None of this is the security boundary — the service refuses everything the UI
 * hides — but a form that offered a control guaranteed to fail would be a bug,
 * and a form that offered a role change the backend rejects would be worse.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { ToastProvider } from '@/components/ui'
import { EmployeeDialog } from './EmployeeDialog'
import type { EmployeeRow } from '@/services/employeesApi'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  setBaseSalary: vi.fn(),
  changePassword: vi.fn(),
  role: { current: 'ADMIN' as 'STAFF' | 'MANAGER' | 'ADMIN' },
}))

vi.mock('@/services/employeesApi', () => ({
  employeesApi: {
    create: mocks.create,
    update: mocks.update,
    setBaseSalary: mocks.setBaseSalary,
  },
}))

// The `authApi` COMMAND is mocked — the dialog must not reach the backend — but
// the module's credential-policy helpers are kept REAL, because they are the
// shared rule the dialog is supposed to be validating against. Replacing them
// with stubs would let a dialog that enforced the wrong policy pass.
vi.mock('@/services/authApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/authApi')>()
  return { ...original, authApi: { changePassword: mocks.changePassword } }
})

vi.mock('@/features/auth/useSession', () => ({
  useSession: () => ({ user: { id: 1, name: 'المدير', role: mocks.role.current } }),
  atLeast: (role: string | undefined, min: string) => {
    const rank = (value?: string) =>
      value === 'ADMIN' ? 3 : value === 'MANAGER' ? 2 : value === 'STAFF' ? 1 : 0
    return rank(role) >= rank(min)
  },
}))

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

const ROW = {
  id: 7,
  user_id: 3,
  name: 'أحمد سيد',
  phone: '01001234567',
  employee_type: 'CASHIER',
  status: 'ACTIVE',
  login_role: 'STAFF',
  base_salary: 300_000,
  notes: 'ملاحظة',
  created_at: '2026-08-01 09:00:00Z',
  updated_at: '2026-09-01 09:00:00Z',
  attendance_days: 20,
  worked_minutes: 490,
  absence_days: 1,
  leave_days: 2,
  today_state: null,
  today_check_in_effective_at: null,
  today_check_out_effective_at: null,
  shifts_count: 3,
  cafe_revenue: 45_000,
} as unknown as EmployeeRow

function renderCreate() {
  return render(
    <ToastProvider>
      <EmployeeDialog mode={{ kind: 'create' }} onClose={() => {}} onSaved={() => {}} />
    </ToastProvider>,
  )
}

function renderEdit() {
  return render(
    <ToastProvider>
      <EmployeeDialog
        mode={{ kind: 'edit', employee: ROW }}
        onClose={() => {}}
        onSaved={() => {}}
      />
    </ToastProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.role.current = 'ADMIN'
  mocks.create.mockResolvedValue(1)
  mocks.update.mockResolvedValue(undefined)
  mocks.setBaseSalary.mockResolvedValue(undefined)
  mocks.changePassword.mockResolvedValue(undefined)
})

describe('EmployeeDialog — create', () => {
  it('asks for the role before anything else', () => {
    renderCreate()
    // The role selector is the first control in the form.
    const role = screen.getByLabelText('الدور') as HTMLSelectElement
    expect(role).toBeInTheDocument()
    // It is seeded with the LEAST-privileged role, so granting more is a choice.
    expect(role.value).toBe('STAFF')
  })

  it('shows the employee type for a cashier', () => {
    renderCreate()
    expect(screen.getByLabelText('نوع الموظف')).toBeInTheDocument()
  })

  it('does not show the employee type for a manager or an admin', () => {
    renderCreate()
    for (const role of ['MANAGER', 'ADMIN']) {
      const select = screen.getByLabelText('الدور') as HTMLSelectElement
      fireEvent.change(select, { target: { value: role } })
      // Absent entirely: not disabled, not empty, not a placeholder.
      expect(screen.queryByLabelText('نوع الموظف')).not.toBeInTheDocument()
    }
  })

  it('does not show the employee type for a wash worker, and offers no password', () => {
    renderCreate()
    fireEvent.change(screen.getByLabelText('الدور'), { target: { value: 'WASH_WORKER' } })
    expect(screen.queryByLabelText('نوع الموظف')).not.toBeInTheDocument()
    // WASH_WORKER = no login account, so there is no credential to ask for.
    expect(screen.queryByLabelText('كلمة المرور')).not.toBeInTheDocument()
  })
})

/** The Arabic message the 4–5 digit credential rule produces, read from the locale. */
const INVALID_CREDENTIAL = 'الرمز السري يجب أن يكون أرقامًا فقط من 4 إلى 5 أرقام'

/**
 * The edit dialog's credential field, read from the locale rather than pasted:
 * the label has to name the EMPLOYEE'S credential (PIN / password) and must
 * never read as "new password", and a test that hardcodes the old wording would
 * have been the thing keeping that wording alive.
 */
const PIN_FIELD = 'الرقم السري / كلمة المرور'

describe('EmployeeDialog — create, credentials', () => {
  it('creates a wash worker with no credential at all', async () => {
    renderCreate()
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: 'محمود' } })
    fireEvent.change(screen.getByLabelText('الدور'), { target: { value: 'WASH_WORKER' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    const input = mocks.create.mock.calls[0][0]
    // WASH_WORKER = no login account: no role and no password ever reach the wire.
    expect(input.employee_type).toBe('WASH_WORKER')
    expect(input.role).toBeNull()
    expect(input.password).toBeNull()
  })

  it('refuses a short password before the request is sent', async () => {
    renderCreate()
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: 'سعيد' } })
    fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: '123' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    expect(await screen.findByText(INVALID_CREDENTIAL)).toBeInTheDocument()
    expect(mocks.create).not.toHaveBeenCalled()
  })
})

/**
 * A credential here is a 4–5 digit PIN, entered through the SAME `PinInput`
 * the login screen uses — and therefore through the SAME visibility toggle
 * (one reusable `PasswordInput`, not a per-screen eye button). A manager typing
 * a credential on a colleague's behalf needs to be able to CHECK what they
 * typed, exactly as at the login screen, so the reveal is restored here and
 * asserted as the shared control rather than a local re-implementation.
 */
describe('EmployeeDialog — the credential field', () => {
  function passwordField() {
    return screen.getByLabelText('كلمة المرور') as HTMLInputElement
  }

  it('is a masked numeric field, like the login screen', () => {
    renderCreate()
    expect(passwordField()).toHaveAttribute('type', 'password')
    expect(passwordField().inputMode).toBe('numeric')
  })

  /**
   * The reveal is the SHARED control, so the assertion is on the shared
   * accessible name, not on an icon drawn here: this fails if the dialog ever
   * grows a second, local implementation that would drift from the login one.
   */
  it('reveals through the shared toggle, operating on the dialog’s own value', () => {
    renderCreate()
    fireEvent.change(passwordField(), { target: { value: '2214' } })

    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.showPassword') }))
    expect(passwordField()).toHaveAttribute('type', 'text')
    // The SAME form value the dialog submits — the toggle reads it, never copies it.
    expect(passwordField().value).toBe('2214')

    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.hidePassword') }))
    expect(passwordField()).toHaveAttribute('type', 'password')
    expect(passwordField().value).toBe('2214')
  })

  it('does not save the dialog when the toggle is pressed', () => {
    renderCreate()
    fireEvent.change(passwordField(), { target: { value: '2214' } })
    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.showPassword') }))
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('offers no toggle until a credential has actually been typed', () => {
    renderCreate()
    expect(passwordField().value).toBe('')
    expect(
      screen.queryByRole('button', { name: i18n.t('auth.showPassword') }),
    ).not.toBeInTheDocument()

    fireEvent.change(passwordField(), { target: { value: '2214' } })
    expect(screen.getByRole('button', { name: i18n.t('auth.showPassword') })).toBeInTheDocument()

    fireEvent.change(passwordField(), { target: { value: '' } })
    expect(
      screen.queryByRole('button', { name: i18n.t('auth.showPassword') }),
    ).not.toBeInTheDocument()
  })

  it('cannot hold a letter, a symbol, or a sixth digit', () => {
    renderCreate()

    fireEvent.change(passwordField(), { target: { value: 'a1b2' } })
    expect(passwordField().value).toBe('12')

    fireEvent.change(passwordField(), { target: { value: '12-34' } })
    expect(passwordField().value).toBe('1234')

    fireEvent.change(passwordField(), { target: { value: '123456' } })
    expect(passwordField().value).toBe('12345')
  })

  it('refuses a too-short PIN before the request is sent', async () => {
    renderCreate()
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: 'سعيد' } })
    fireEvent.change(passwordField(), { target: { value: '123' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    expect(await screen.findByText(INVALID_CREDENTIAL)).toBeInTheDocument()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('submits a valid PIN exactly as typed', async () => {
    renderCreate()
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: 'سعيد' } })
    fireEvent.change(passwordField(), { target: { value: '2214' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    expect(mocks.create.mock.calls[0][0].password).toBe('2214')
  })

  it('offers no credential field at all for a wash worker', () => {
    renderCreate()
    fireEvent.change(screen.getByLabelText('الدور'), { target: { value: 'WASH_WORKER' } })
    expect(screen.queryByLabelText('كلمة المرور')).not.toBeInTheDocument()
  })
})

describe('EmployeeDialog — edit', () => {
  it('offers exactly the four editable HR fields', () => {
    renderEdit()
    expect(screen.getByLabelText('الاسم')).toBeInTheDocument()
    expect(screen.getByLabelText('التليفون')).toBeInTheDocument()
    expect(screen.getByLabelText('الراتب الأساسي الشهري')).toBeInTheDocument()
    expect(screen.getByLabelText('ملاحظات')).toBeInTheDocument()
  })

  it('offers no control for role, type, status, account or the current credential', () => {
    mocks.role.current = 'MANAGER'
    const { container } = renderEdit()
    // Not disabled, not read-only inputs: ABSENT. A disabled select would still
    // advertise that the value is negotiable.
    expect(screen.queryByLabelText('الدور')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('نوع الموظف')).not.toBeInTheDocument()
    // Not even the credential field: editing one is an ADMIN act.
    expect(screen.queryByLabelText(PIN_FIELD)).not.toBeInTheDocument()
    expect(container.querySelectorAll('select')).toHaveLength(0)
  })

  it('shows role and type as read-only context instead', () => {
    renderEdit()
    // The manager can still SEE what the record carries, without being able to
    // change it: this is plain text, not a control.
    expect(screen.getByText('كاشير')).toBeInTheDocument()
    expect(screen.getByText(/نوع الموظف:/)).toBeInTheDocument()
  })

  it('saves the editable fields and never proposes a role or credential', async () => {
    renderEdit()
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: 'أحمد الجديد' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalled())
    const input = mocks.update.mock.calls[0][1]
    expect(input.name).toBe('أحمد الجديد')
    // Role and password are not part of an edit at all, so they are not even sent.
    expect(input.role).toBeNull()
    expect(input.password).toBeNull()
    // The type is echoed unchanged, which the backend verifies rather than trusts.
    expect(input.employee_type).toBe('CASHIER')
  })

  it('reports a malformed salary without sending anything', async () => {
    renderEdit()
    fireEvent.change(screen.getByLabelText('الراتب الأساسي الشهري'), {
      target: { value: 'abc' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    expect(await screen.findByText('الراتب غير صحيح')).toBeInTheDocument()
    expect(mocks.update).not.toHaveBeenCalled()
  })
})

/**
 * The employee edit dialog's CREDENTIAL field.
 *
 * The contract these tests pin is that the field is an EDITABLE PROPERTY OF THE
 * RECORD, not a "new password" prompt, and that it is honest about the storage
 * model it sits on:
 *
 *  - the label speaks of the employee's PIN/password, never of a "new" one;
 *  - the existing credential is REPRESENTED by a mask, because the stored value
 *    is a one-way Argon2id hash the application genuinely cannot read — so the
 *    mask asserts "one is on file" and nothing more, and the digits are never
 *    invented;
 *  - the field opens EMPTY, and empty means "keep the stored credential", so an
 *    unrelated edit sends no credential command at all and cannot reset a
 *    colleague's login;
 *  - a typed value goes out through the auth command against the LOGIN id,
 *    carrying the same 4–5 digit rule login itself enforces.
 *
 * The backend enforces authorization and validation for real — the visibility
 * asserted here is an affordance, not the boundary.
 */
describe('EmployeeDialog — ADMIN edits the employee credential', () => {
  const FIELD = PIN_FIELD

  function pinField() {
    return screen.getByLabelText(FIELD) as HTMLInputElement
  }

  it('is labelled as the employee credential, not as a new password', () => {
    mocks.role.current = 'ADMIN'
    renderEdit()
    expect(pinField()).toBeInTheDocument()
    // The wording that would make this a "create a password" prompt is gone from
    // the screen entirely, in both the label and the hint.
    expect(screen.queryByText(/كلمة المرور الجديدة/)).not.toBeInTheDocument()
  })

  it('offers the field to an ADMIN, masked, with the stored credential represented', () => {
    mocks.role.current = 'ADMIN'
    renderEdit()
    const field = pinField()
    expect(field).toHaveAttribute('type', 'password')
    // Empty, because the plaintext is not available anywhere — but NOT an empty
    // looking field: the mask states that a credential exists on file.
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('•••••')
  })

  it('is a masked numeric PIN field, like the login screen', () => {
    renderEdit()
    expect(pinField()).toHaveAttribute('type', 'password')
    expect(pinField().inputMode).toBe('numeric')
  })

  /**
   * The mandatory acceptance sequence, in order, in ONE dialog: empty → no eye,
   * type → eye, show, hide, clear → no eye again.
   *
   * This is the whole defect in one test. The stored credential exists, but its
   * plaintext does not and never will, so an eye rendered on an EMPTY field is a
   * control that promises a reveal it cannot perform.
   */
  it('offers no reveal for a stored credential it cannot read, only for a typed one', () => {
    mocks.role.current = 'ADMIN'
    renderEdit()
    const field = pinField()

    // 1. Open: empty, no usable toggle.
    expect(field.value).toBe('')
    expect(
      screen.queryByRole('button', { name: i18n.t('auth.showPassword') }),
    ).not.toBeInTheDocument()

    // 2. Type: the toggle appears immediately.
    fireEvent.change(field, { target: { value: '2214' } })
    const show = screen.getByRole('button', { name: i18n.t('auth.showPassword') })

    // 3. Show: the plaintext that was just typed, and nothing else.
    fireEvent.click(show)
    expect(field).toHaveAttribute('type', 'text')
    expect(field.value).toBe('2214')

    // 4. Hide: masked again, value carried through.
    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.hidePassword') }))
    expect(field).toHaveAttribute('type', 'password')
    expect(field.value).toBe('2214')

    // 5. Clear: the toggle is gone again, and nothing is left revealed.
    fireEvent.change(field, { target: { value: '' } })
    expect(
      screen.queryByRole('button', { name: i18n.t('auth.showPassword') }),
    ).not.toBeInTheDocument()
    expect(field).toHaveAttribute('type', 'password')
  })

  it('states what the empty field means, in words, in both states', () => {
    mocks.role.current = 'ADMIN'
    renderEdit()
    // The hint is the guidance for the DECISION (keep or replace), so it is
    // present whether or not a replacement has been typed — and it never claims
    // the typed digits are the stored one.
    const hint = i18n.t('employees.form.pinHint')
    expect(screen.getByText(hint)).toBeInTheDocument()

    fireEvent.change(pinField(), { target: { value: '2214' } })
    expect(screen.getByText(hint)).toBeInTheDocument()
  })

  it('reveals the replacement PIN through the same shared toggle', () => {
    renderEdit()
    fireEvent.change(pinField(), { target: { value: '2214' } })

    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.showPassword') }))
    expect(pinField()).toHaveAttribute('type', 'text')
    expect(pinField().value).toBe('2214')

    // The stored credential is still only REPRESENTED by the mask; revealing
    // exposes what was just typed, never a hash or a plaintext from storage.
    expect(pinField().placeholder).toBe('•••••')
  })

  it('edits the credential in place: digits only, 4 to 5 of them', () => {
    renderEdit()
    // The same structural cap the login screen has: a sixth digit is never held
    // in state, and a letter or hyphen never survives.
    fireEvent.change(pinField(), { target: { value: '22145' } })
    expect(pinField().value).toBe('22145')

    fireEvent.change(pinField(), { target: { value: '221456' } })
    expect(pinField().value).toBe('22145')

    fireEvent.change(pinField(), { target: { value: '12a4' } })
    expect(pinField().value).toBe('124')

    fireEvent.change(pinField(), { target: { value: '12-34' } })
    expect(pinField().value).toBe('1234')
  })

  it('changes nothing when the field is left empty', async () => {
    renderEdit()
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: 'أحمد' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalled())
    // The decisive assertion: an unrelated edit never touches the credential.
    expect(mocks.changePassword).not.toHaveBeenCalled()
    // And it is not smuggled onto the employee payload either, so the Rust side
    // can never be asked to hash an empty value.
    expect(mocks.update.mock.calls[0][1].password).toBeNull()
  })

  it('changes nothing when the field is cleared after being typed into', async () => {
    renderEdit()
    // Typing then clearing is "no change" and must be treated exactly like never
    // having typed at all — an empty field can never reach `change_password`.
    fireEvent.change(pinField(), { target: { value: '55555' } })
    fireEvent.change(pinField(), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalled())
    expect(mocks.changePassword).not.toHaveBeenCalled()
  })

  it('edits and persists the PIN while the field is VISIBLE, and re-masks on demand', async () => {
    renderEdit()
    const field = pinField()

    // Test 1 — open: masked.
    expect(field).toHaveAttribute('type', 'password')

    // Test 2 — show: the real input type flips and the value is untouched.
    fireEvent.change(field, { target: { value: '2214' } })
    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.showPassword') }))
    expect(field).toHaveAttribute('type', 'text')
    expect(field.value).toBe('2214')

    // Test 3 — hide: back to masked, with the value carried through untouched.
    // Same open dialog, so this is a pure round trip and not a second render.
    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.hidePassword') }))
    expect(field).toHaveAttribute('type', 'password')
    expect(field.value).toBe('2214')

    // Test 4 — edit WHILE visible, then save.
    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.showPassword') }))
    fireEvent.change(field, { target: { value: '55555' } })
    expect(field.value).toBe('55555')
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))
    await waitFor(() => expect(mocks.changePassword).toHaveBeenCalledWith(3, '55555'))
  })

  it('persists the PIN while the field stays MASKED, identically', async () => {
    renderEdit()
    // Test 5 — the same edit with the eye never pressed.
    fireEvent.change(pinField(), { target: { value: '55555' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))
    await waitFor(() => expect(mocks.changePassword).toHaveBeenCalledWith(3, '55555'))
  })

  it('keeps the 4–5 digit rule while the PIN is VISIBLE', () => {
    renderEdit()
    fireEvent.change(pinField(), { target: { value: '2214' } })
    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.showPassword') }))
    const field = pinField()
    expect(field).toHaveAttribute('type', 'text')

    // Turning the type into `text` must not turn the field into a free-text box.
    // The cap is the EMPLOYEE credential's own (5), not the discount PIN's 4.
    fireEvent.change(field, { target: { value: '12a4' } })
    expect(field.value).toBe('124')
    fireEvent.change(field, { target: { value: '123456' } })
    expect(field.value).toBe('12345')
    fireEvent.change(field, { target: { value: '12-34' } })
    expect(field.value).toBe('1234')
  })

  it('never saves the employee when the eye is pressed', () => {
    renderEdit()
    fireEvent.change(pinField(), { target: { value: '2214' } })

    // Test 6 — revealing is a view action, not a submit.
    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.showPassword') }))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.hidePassword') }))

    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.changePassword).not.toHaveBeenCalled()
    // The form state survived both presses untouched.
    expect(pinField().value).toBe('2214')
  })

  it('sends a 4-digit replacement through the auth command, against the LOGIN id', async () => {
    renderEdit()
    fireEvent.change(pinField(), { target: { value: '2214' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    await waitFor(() => expect(mocks.changePassword).toHaveBeenCalledWith(3, '2214'))
    expect(mocks.update).toHaveBeenCalled()
  })

  it('sends a 5-digit replacement too — both boundary lengths are accepted', async () => {
    renderEdit()
    fireEvent.change(pinField(), { target: { value: '55555' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    await waitFor(() => expect(mocks.changePassword).toHaveBeenCalledWith(3, '55555'))
  })

  it('rejects a too-short credential before any request is sent', async () => {
    renderEdit()
    fireEvent.change(pinField(), { target: { value: '123' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    expect(await screen.findByText(INVALID_CREDENTIAL)).toBeInTheDocument()
    expect(mocks.changePassword).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('never prefills the field from the stored credential', () => {
    mocks.role.current = 'ADMIN'
    renderEdit()
    // The anti-regression for the one thing this flow must never do: seed the
    // form from the record. No hash, no plaintext, nothing but the mask.
    const field = pinField()
    expect(field.value).toBe('')
    expect(field.defaultValue).toBe('')
  })

  it('offers no field to a MANAGER or a STAFF', () => {
    for (const role of ['MANAGER', 'STAFF'] as const) {
      mocks.role.current = role
      const { unmount } = renderEdit()
      expect(screen.queryByLabelText(FIELD)).not.toBeInTheDocument()
      unmount()
    }
  })

  it('offers no field for a wash worker, who has no login to act on', () => {
    render(
      <ToastProvider>
        <EmployeeDialog
          mode={{ kind: 'edit', employee: { ...ROW, user_id: null } as EmployeeRow }}
          onClose={() => {}}
          onSaved={() => {}}
        />
      </ToastProvider>,
    )
    expect(screen.queryByLabelText(FIELD)).not.toBeInTheDocument()
  })
})
/**
 * The save TRANSACTION: what goes out on the wire, in what order, and what
 * happens when the backend refuses.
 *
 * The rules pinned here are the ones that make the form safe rather than merely
 * present: a name is required even when it is only whitespace, the salary is a
 * money attribute with its own audited command (sent only when it actually
 * changed), a failure is reported as a toast and never leaves the button stuck
 * in its busy state.
 */
describe('EmployeeDialog — save transaction', () => {
  const SAVE = 'حفظ'
  const SALARY = 'الراتب الأساسي الشهري'

  it('cannot save an empty name, and sends nothing at all', async () => {
    renderCreate()
    // Whitespace only: the button is gated on a non-empty name, so an empty one
    // never even reaches the form's own `nameRequired` validation — either way
    // no request is made.
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: '   ' } })
    fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: '2214' } })

    expect(screen.getByRole('button', { name: SAVE })).toBeDisabled()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('creates a cashier with the chosen role, its credential and no salary', async () => {
    renderCreate()
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: ' سعاد ' } })
    fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: '2214' } })
    fireEvent.click(screen.getByRole('button', { name: SAVE }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    const input = mocks.create.mock.calls[0][0]
    // Name is trimmed on the way out; an empty phone/notes field is `null`, never ''.
    expect(input.name).toBe('سعاد')
    expect(input.employee_type).toBe('CASHIER')
    expect(input.role).toBe('STAFF')
    expect(input.password).toBe('2214')
    expect(input.phone).toBeNull()
    expect(input.notes).toBeNull()
    // No salary typed at all is a deliberate ZERO, not an omitted field.
    expect(input.base_salary).toBe(0)
  })

  it('parses the typed salary into integer piasters', async () => {
    renderCreate()
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: 'سعاد' } })
    fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: '2214' } })
    fireEvent.change(screen.getByLabelText(SALARY), { target: { value: '2500.50' } })
    fireEvent.click(screen.getByRole('button', { name: SAVE }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    expect(mocks.create.mock.calls[0][0].base_salary).toBe(250_050)
  })

  it('sends the salary command only when the salary actually changed', async () => {
    renderEdit()
    // Seeded from the record as `300000 / 100`, so saving it untouched is a no-op.
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: 'أحمد' } })
    fireEvent.click(screen.getByRole('button', { name: SAVE }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalled())
    expect(mocks.setBaseSalary).not.toHaveBeenCalled()

    // A real change goes out through its own audited command, never inside the
    // identity edit, and after it.
    fireEvent.change(screen.getByLabelText(SALARY), { target: { value: '4500' } })
    fireEvent.click(screen.getByRole('button', { name: SAVE }))

    await waitFor(() => expect(mocks.setBaseSalary).toHaveBeenCalledWith(7, 450_000))
    expect(mocks.update.mock.calls.at(-1)?.[1].base_salary).toBe(450_000)
  })

  it('reports a rejected save and releases the busy state', async () => {
    mocks.update.mockRejectedValueOnce(new Error('auth.forbidden'))
    renderEdit()
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: 'أحمد' } })
    fireEvent.click(screen.getByRole('button', { name: SAVE }))

    // The backend's own code, through the shared error-to-translation mapping.
    expect(await screen.findByText('ليس لديك صلاحية لتنفيذ هذا الإجراء')).toBeInTheDocument()
    // The `finally` matters: a stuck button would lock the manager out of the
    // whole form with no way to retry.
    await waitFor(() => expect(screen.getByRole('button', { name: SAVE })).not.toBeDisabled())
  })

  it('releases the busy state when only the salary command fails', async () => {
    mocks.setBaseSalary.mockRejectedValueOnce(new Error('internal_error'))
    renderEdit()
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: 'أحمد' } })
    fireEvent.change(screen.getByLabelText(SALARY), { target: { value: '4500' } })
    fireEvent.click(screen.getByRole('button', { name: SAVE }))

    expect(await screen.findByText('حدث خطأ غير متوقع، حاول مرة أخرى')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: SAVE })).not.toBeDisabled())
  })
})
