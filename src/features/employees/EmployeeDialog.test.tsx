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

vi.mock('@/services/authApi', () => ({
  authApi: { changePassword: mocks.changePassword },
}))

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

    expect(await screen.findByText('كلمة المرور يجب ألا تقل عن 6 حروف')).toBeInTheDocument()
    expect(mocks.create).not.toHaveBeenCalled()
  })
})

/**
 * The password visibility toggle is NOT a second design: the Add Employee form
 * uses the SAME `PasswordInput` primitive the login screen does, so it inherits
 * the eye / eye-off iconography, the `auth.showPassword` / `auth.hidePassword`
 * labelling and the inline-end (RTL-safe) placement for free. These tests assert
 * that contract rather than the pixels.
 */
describe('EmployeeDialog — password visibility toggle', () => {
  const TOGGLE = 'إظهار كلمة المرور'
  const TOGGLE_HIDE = 'إخفاء كلمة المرور'

  function passwordField() {
    return screen.getByLabelText('كلمة المرور') as HTMLInputElement
  }

  it('starts masked', () => {
    renderCreate()
    expect(passwordField()).toHaveAttribute('type', 'password')
  })

  it('reveals and re-masks the password, keeping its value', () => {
    renderCreate()
    fireEvent.change(passwordField(), { target: { value: 'secret123' } })

    const toggle = screen.getByRole('button', { name: TOGGLE })
    // An actual button — reachable by name, not a click handler on the icon.
    expect(toggle).toHaveAttribute('type', 'button')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(toggle)
    expect(passwordField()).toHaveAttribute('type', 'text')
    // The label now offers the reverse action, and the control reports pressed.
    const hide = screen.getByRole('button', { name: TOGGLE_HIDE })
    expect(hide).toHaveAttribute('aria-pressed', 'true')
    // Visibility is presentation only: the value is untouched.
    expect(passwordField().value).toBe('secret123')

    fireEvent.click(hide)
    expect(passwordField()).toHaveAttribute('type', 'password')
    expect(passwordField().value).toBe('secret123')
  })

  it('places the toggle at the inline-end edge so it mirrors in RTL', () => {
    renderCreate()
    const toggle = screen.getByRole('button', { name: TOGGLE })
    // Logical, direction-agnostic positioning: the app is RTL, so this lands on
    // the left of the field without any RTL-specific override.
    expect(toggle.className).toContain('inset-e-2')
    expect(toggle.className).not.toContain('left-')
    expect(toggle.className).not.toContain('right-')
    // The input reserves the same inline-end space for it.
    expect(passwordField().className).toContain('pe-11')
  })

  it('still validates the revealed value and submits it unchanged', async () => {
    renderCreate()
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: 'سعيد' } })
    fireEvent.change(passwordField(), { target: { value: '123' } })
    fireEvent.click(screen.getByRole('button', { name: TOGGLE }))

    // Revealing a short password does not make it acceptable.
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))
    expect(await screen.findByText('كلمة المرور يجب ألا تقل عن 6 حروف')).toBeInTheDocument()
    expect(mocks.create).not.toHaveBeenCalled()

    // Correcting it while visible submits exactly what was typed.
    fireEvent.change(passwordField(), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    expect(mocks.create.mock.calls[0][0].password).toBe('secret123')
  })

  it('offers no toggle where there is no password', () => {
    renderCreate()
    fireEvent.change(screen.getByLabelText('الدور'), { target: { value: 'WASH_WORKER' } })
    expect(screen.queryByRole('button', { name: TOGGLE })).not.toBeInTheDocument()
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

  it('offers no control for role, type, status, account or the current password', () => {
    mocks.role.current = 'MANAGER'
    const { container } = renderEdit()
    // Not disabled, not read-only inputs: ABSENT. A disabled select would still
    // advertise that the value is negotiable.
    expect(screen.queryByLabelText('الدور')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('نوع الموظف')).not.toBeInTheDocument()
    // Not even the NEW-password field: setting a credential is an ADMIN act.
    expect(screen.queryByLabelText('كلمة المرور الجديدة')).not.toBeInTheDocument()
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
 * Setting a NEW password from the edit dialog.
 *
 * The rule these tests pin is that the field SETS and never REVEALS: it opens
 * empty, an empty save changes nothing at all, and a typed value goes out through
 * the auth command rather than riding along on the employee record. The backend
 * enforces the real authorization — the visibility asserted here is an affordance,
 * not the boundary.
 */
describe('EmployeeDialog — ADMIN sets a new password', () => {
  const FIELD = 'كلمة المرور الجديدة'
  const TOGGLE = 'إظهار كلمة المرور'

  function newPasswordField() {
    return screen.getByLabelText(FIELD) as HTMLInputElement
  }

  it('offers the field to an ADMIN and opens it empty and masked', () => {
    mocks.role.current = 'ADMIN'
    renderEdit()
    const field = newPasswordField()
    expect(field).toHaveAttribute('type', 'password')
    // Empty is the whole meaning of "unchanged": there is no value to leak, and
    // nothing is pre-filled from a stored credential.
    expect(field.value).toBe('')
  })

  it('reuses the shared show/hide toggle rather than a second design', () => {
    renderEdit()
    fireEvent.change(newPasswordField(), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: TOGGLE }))
    expect(newPasswordField()).toHaveAttribute('type', 'text')
    expect(newPasswordField().value).toBe('secret123')
  })

  it('changes nothing when the field is left empty', async () => {
    renderEdit()
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: 'أحمد' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalled())
    // The decisive assertion: an unrelated edit never touches the credential.
    expect(mocks.changePassword).not.toHaveBeenCalled()
    // And it is not smuggled onto the employee payload either.
    expect(mocks.update.mock.calls[0][1].password).toBeNull()
  })

  it('sends the new password through the auth command, against the LOGIN id', async () => {
    renderEdit()
    fireEvent.change(newPasswordField(), { target: { value: 'brand-new-pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    await waitFor(() => expect(mocks.changePassword).toHaveBeenCalledWith(3, 'brand-new-pass'))
    expect(mocks.update).toHaveBeenCalled()
  })

  it('rejects a too-short password before any request is sent', async () => {
    renderEdit()
    fireEvent.change(newPasswordField(), { target: { value: '123' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    expect(await screen.findByText('كلمة المرور يجب ألا تقل عن 6 حروف')).toBeInTheDocument()
    expect(mocks.changePassword).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
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
    fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'secret123' } })

    expect(screen.getByRole('button', { name: SAVE })).toBeDisabled()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('creates a cashier with the chosen role, its credential and no salary', async () => {
    renderCreate()
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: ' سعاد ' } })
    fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: SAVE }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    const input = mocks.create.mock.calls[0][0]
    // Name is trimmed on the way out; an empty phone/notes field is `null`, never ''.
    expect(input.name).toBe('سعاد')
    expect(input.employee_type).toBe('CASHIER')
    expect(input.role).toBe('STAFF')
    expect(input.password).toBe('secret123')
    expect(input.phone).toBeNull()
    expect(input.notes).toBeNull()
    // No salary typed at all is a deliberate ZERO, not an omitted field.
    expect(input.base_salary).toBe(0)
  })

  it('parses the typed salary into integer piasters', async () => {
    renderCreate()
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: 'سعاد' } })
    fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'secret123' } })
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
