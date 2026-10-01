/**
 * The employee create/edit form (MANAGER+).
 *
 * # CREATING is role-first
 *
 * The very first thing the form asks is the LOGIN ROLE, because that is the
 * decision that shapes everything after it:
 *
 *  - **CASHIER (STAFF)** — the person signs in, so they also get an employee
 *    TYPE and a password. This is the only case where the type selector appears.
 *  - **MANAGER / ADMIN** — also a login, but every login in Station is a
 *    `CASHIER` employee, so the type is implied and the field is NOT RENDERED.
 *    Not disabled, not empty, not a placeholder: absent.
 *  - **WASH_WORKER** — no login account at all, ever. The type is implied by the
 *    role and no password field exists, so a credential cannot be created for
 *    them by accident. The database CHECK enforces the same rule.
 *
 * Because the type field only exists for a CASHIER, the form can never ask about
 * employee type before it has established the role.
 *
 * # Role assignment stays authorization-aware
 *
 * The role list is the session's own authority: a MANAGER may hand out MANAGER
 * and STAFF but never ADMIN, and only an ADMIN sees ADMIN offered at all. This
 * mirrors the backend's privilege-escalation guard exactly, and it is a
 * convenience rather than the boundary — the service re-checks it regardless of
 * what this form renders.
 *
 * # EDITING is deliberately much more restricted
 *
 * The edit dialog offers four HR fields — name, phone, salary and notes — plus
 * ONE credential field for an ADMIN. Role, employee type, account role and
 * employment status are NOT editable here at all: they are absent from the form
 * rather than disabled, because a disabled control still advertises that the
 * value is negotiable. The role and type are shown as read-only context so the
 * manager can see what the record actually carries, and changing either is a
 * separate, explicit workflow (the backend refuses it with
 * `employee.type_is_immutable`).
 *
 * # The password field SETS, never REVEALS
 *
 * The credential field is a "new password" field: it is empty when the dialog
 * opens, masked by default, and an EMPTY value means "leave the password alone".
 * Station never has the current password — only an Argon2id hash — and the field
 * is therefore not a viewer. An ADMIN typing here is choosing the colleague's
 * next password, not reading the one they have; the label and hint say exactly
 * that. The value goes to `change_password`, which authorizes, validates, hashes
 * and persists on the Rust side, and returns nothing at all.
 *
 * Money is entered through the shared amount parsing, which yields integer
 * piasters exactly like every other amount in Station. No float ever reaches the
 * wire.
 */
import { useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  Field,
  Input,
  PasswordInput,
  Select,
  Textarea,
  useToast,
} from '@/components/ui'
import { atLeast, useSession } from '@/features/auth/useSession'
import { useErrText } from '@/lib/err'
import { parseMajor } from '@/lib/utils'
import { authApi } from '@/services/authApi'
import { employeesApi } from '@/services/employeesApi'
import type { EmployeeInput, EmployeeRow, EmployeeType, LoginRole } from '@/services/employeesApi'
import { roleLabel, roleOf } from './employee-role'

export type EmployeeDialogMode = { kind: 'create' } | { kind: 'edit'; employee: EmployeeRow } | null

/**
 * The client-side minimum password length, stated ONCE and used by both the
 * create and the change path so the two can never disagree about what this form
 * accepts. The backend's `auth::validate_password` is the real rule and is at
 * least as strict; this is immediate feedback, not a second policy.
 */
const MIN_PASSWORD_LENGTH = 6

/**
 * The role the form is collecting.
 *
 * It is the PRESENTATION role: the three auth roles plus `WASH_WORKER`, which is
 * the role a person with no login can hold. Keeping `WASH_WORKER` in the same
 * list is what lets one selector express both "this person signs in" and "this
 * person does not".
 */
type FormRole = LoginRole | 'WASH_WORKER'

/** The role value that means "a person who signs in as a plain cashier". */
const CASHIER_ROLE: FormRole = 'STAFF'

/** The role value that means "a wash worker, who has no login account". */
const NO_LOGIN_ROLE: FormRole = 'WASH_WORKER'

/**
 * The field-level errors the form refuses to save with, and nothing else.
 *
 * Kept as a PURE function of the fields it inspects, so the save button and the
 * tests can reason about the rules without the component around them. The login
 * is validated up front so a missing password is a field error, not a rejected
 * request the user can only learn about from a toast.
 *
 * The SHARED auth rule, mirrored here for immediate feedback; the service
 * enforces the real one either way. A new password is optional on edit: an EMPTY
 * field means "leave the credential alone", so it is never validated — and a
 * password is only ever required when a login is being CREATED.
 */
function validateEmployeeForm(
  fields: Readonly<{
    name: string
    password: string
    newPassword: string
    needsPassword: boolean
    canChangePassword: boolean
    t: TFunction
  }>,
): Record<string, string> {
  const errors: Record<string, string> = {}
  if (fields.name.trim() === '') errors.name = fields.t('employees.form.nameRequired')
  if (fields.needsPassword && fields.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = fields.t('errors.user.password_too_short')
  }
  if (
    fields.canChangePassword &&
    fields.newPassword !== '' &&
    fields.newPassword.length < MIN_PASSWORD_LENGTH
  ) {
    errors.newPassword = fields.t('errors.user.password_too_short')
  }
  return errors
}

/**
 * The salary field, read as integer piasters through the SHARED `parseMajor`.
 *
 * Entered in major units, so every amount in Station parses identically and no
 * float is ever constructed. An EMPTY field is a deliberate zero; a MALFORMED
 * one is `null` — a validation error, never a silent zero.
 */
function parseSalaryField(salary: string): number | null {
  return salary.trim() === '' ? 0 : parseMajor(salary)
}

/**
 * The employee payload, assembled from the form exactly as it collects it.
 *
 * The employee TYPE is implied by the role, never chosen independently: a wash
 * worker has no login (and the database refuses one), and every login in Station
 * is a CASHIER employee. A wash worker therefore gets no credential, while a new
 * login gets its account created alongside the employee record, in the same
 * transaction on the server.
 */
function buildEmployeeInput(
  fields: Readonly<{
    name: string
    phone: string
    notes: string
    type: EmployeeType
    /** The presentation role; `WASH_WORKER` is the one value with no login. */
    role: FormRole
    isWashWorker: boolean
    isEditing: boolean
    needsPassword: boolean
    password: string
    baseSalary: number
  }>,
): EmployeeInput {
  // The type field exists only to let a CASHIER-slot person be created as a wash
  // worker instead, so the role overrides whatever the selector holds.
  const employeeType: EmployeeType = fields.isWashWorker ? 'WASH_WORKER' : fields.type
  return {
    name: fields.name.trim(),
    phone: fields.phone.trim() || null,
    employee_type: employeeType,
    base_salary: fields.baseSalary,
    notes: fields.notes.trim() || null,
    user_id: null,
    // Editing never proposes a role or a credential: this form cannot change
    // them, so it does not even claim to. `null` means "leave it alone".
    role: fields.isEditing || fields.isWashWorker ? null : (fields.role as LoginRole),
    password: fields.needsPassword ? fields.password : null,
  }
}

/**
 * Persist one employee: the details, then the money, then the credential.
 *
 * These are three deliberate backend commands in a fixed order, and none of them
 * rides along inside another:
 *  - the salary is a MONEY attribute with its own audited command;
 *  - a NEW password is a separate act through the auth command, not a field on
 *    the employee record. Leaving the field empty sends nothing at all, so an
 *    unrelated edit can never reset the credential.
 */
async function persistEmployee(
  editing: EmployeeRow,
  input: EmployeeInput,
  baseSalary: number,
  change: Readonly<{ canChangePassword: boolean; newPassword: string }>,
): Promise<void> {
  await employeesApi.update(editing.id, input)
  if (baseSalary !== (editing.base_salary ?? 0)) {
    await employeesApi.setBaseSalary(editing.id, baseSalary)
  }
  // `user_id` is guaranteed non-null by `canChangePassword`, and re-checked here
  // so the call site can never widen what an ADMIN may reach.
  if (change.canChangePassword && change.newPassword !== '' && editing.user_id !== null) {
    await authApi.changePassword(editing.user_id, change.newPassword)
  }
}

export function EmployeeDialog({
  mode,
  onClose,
  onSaved,
}: {
  readonly mode: EmployeeDialogMode
  readonly onClose: () => void
  readonly onSaved: () => void
}) {
  const { t } = useTranslation()
  const { user } = useSession()
  const errText = useErrText(t)
  const toast = useToast()

  const editing = mode?.kind === 'edit' ? mode.employee : null
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [type, setType] = useState<EmployeeType>('CASHIER')
  const [role, setRole] = useState<FormRole>(CASHIER_ROLE)
  const [password, setPassword] = useState('')
  /** The NEW password an ADMIN is choosing on edit. Empty means "do not touch it". */
  const [newPassword, setNewPassword] = useState('')
  const [salary, setSalary] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!mode) return
    // oxlint-disable-next-line react/set-state-in-effect -- form re-seed on open.
    setName(editing?.name ?? '')
    setPhone(editing?.phone ?? '')
    setType(editing?.employee_type ?? 'CASHIER')
    setRole(
      editing?.login_role ??
        (editing?.employee_type === 'WASH_WORKER' ? NO_LOGIN_ROLE : CASHIER_ROLE),
    )
    setPassword('')
    // Always starts EMPTY, which is exactly "do not change the password". Nothing
    // about opening this dialog can reset or reveal the stored credential.
    setNewPassword('')
    setSalary(editing?.base_salary ? String(editing.base_salary / 100) : '')
    setNotes(editing?.notes ?? '')
    setErrors({})
  }, [mode, editing])

  if (!mode) return null

  // Editing never offers a role: it is read-only context, and the seed above only
  // exists so the read-only line can state what the record actually carries.
  const isWashWorker = role === NO_LOGIN_ROLE
  // The employee TYPE is a question only a CASHIER can be asked, because every
  // other role implies it. See the module doc.
  const showType = !editing && role === CASHIER_ROLE
  // A new login needs a password, because their account is created with them.
  const needsPassword = !editing && !isWashWorker
  // Setting a NEW password is an ADMIN action on an account that exists: it needs
  // a login to act on (`user_id`), so a wash worker is never offered one. This is
  // presentation only — `change_password` re-checks the caller's authority on the
  // Rust side regardless of what this form renders.
  const canChangePassword = Boolean(editing?.user_id) && atLeast(user?.role, 'ADMIN')
  const assignableRoles: LoginRole[] = atLeast(user?.role, 'ADMIN')
    ? ['STAFF', 'MANAGER', 'ADMIN']
    : ['STAFF', 'MANAGER']

  async function save() {
    // The login is validated up front so a missing password is a field error, not
    // a rejected request the user can only learn about from a toast.
    const nextErrors = validateEmployeeForm({
      name,
      password,
      newPassword,
      needsPassword,
      canChangePassword,
      t,
    })
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    const baseSalary = parseSalaryField(salary)
    if (baseSalary === null) {
      // The SHARED `errors.` namespace, so the message comes from the same
      // catalogue the backend's own rejection is translated from.
      toast(t('errors.employee.invalid_salary'), 'error')
      return
    }

    setBusy(true)
    try {
      const input = buildEmployeeInput({
        name,
        phone,
        notes,
        type,
        role,
        isWashWorker,
        isEditing: Boolean(editing),
        needsPassword,
        password,
        baseSalary,
      })
      if (editing) {
        await persistEmployee(editing, input, baseSalary, { canChangePassword, newPassword })
      } else {
        await employeesApi.create(input)
      }
      toast(
        canChangePassword && newPassword !== ''
          ? t('employees.form.savedWithPassword')
          : t('employees.form.saved'),
        'success',
      )
      onSaved()
      onClose()
    } catch (cause) {
      toast(errText(cause), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? t('employees.form.editTitle') : t('employees.form.createTitle')}
    >
      <div className="flex flex-col gap-3">
        {/* ROLE FIRST, always. It is the decision that shapes the rest of the
            form, and the employee TYPE is not even asked until it is answered. */}
        {editing ? (
          /* Editing is much more restricted than creating: role and type are not
              editable at all. They are shown as READ-ONLY context — plain text, no
              control — so the manager can see what the record carries without the
              form ever advertising that the value is negotiable. Changing either is
              a separate, explicit workflow. */
          <div className="flex flex-wrap items-center gap-2 text-caption text-foreground-subtle">
            <span>{t('employees.form.role')}:</span>
            <Badge role={roleOf(editing)} size="sm" dot>
              {roleLabel(t, roleOf(editing))}
            </Badge>
            <span aria-hidden>·</span>
            <span>
              {t('employees.form.type')}: {t(`employees.type.${editing.employee_type}`)}
            </span>
          </div>
        ) : (
          <Field label={t('employees.form.role')} htmlFor="employee-role-select">
            <Select
              id="employee-role-select"
              value={role}
              onChange={(event) => setRole(event.target.value as FormRole)}
            >
              {/* The authority list is the session's own: a manager can hand out
                  STAFF and MANAGER but never ADMIN. */}
              {assignableRoles.map((value) => (
                <option key={value} value={value}>
                  {t(`roles.${value}`)}
                </option>
              ))}
              {/* WASH_WORKER is a role in its own right: no login, ever. */}
              <option value={NO_LOGIN_ROLE}>{t('roles.WASH_WORKER')}</option>
            </Select>
          </Field>
        )}

        {/* Why the type is not on screen yet: the role decides it. Only in CREATE —
            in edit there is no role to choose, and the read-only line above has
            already stated what the record carries. */}
        {!editing && role !== CASHIER_ROLE ? (
          <p className="-mt-1 text-caption text-foreground-subtle">
            {t('employees.form.roleFirstHint')}
          </p>
        ) : null}

        {/* The employee TYPE is a question only a CASHIER can be asked. For
            MANAGER/ADMIN it is implied (every login is a CASHIER employee) and for
            WASH_WORKER it is implied by the role — so in both cases the field is
            NOT rendered at all: not disabled, not empty, not a placeholder. */}
        {showType ? (
          <>
            <Field label={t('employees.form.type')} htmlFor="employee-type">
              <Select
                id="employee-type"
                value={type}
                onChange={(event) => setType(event.target.value as EmployeeType)}
              >
                <option value="CASHIER">{t('employees.type.CASHIER')}</option>
                <option value="WASH_WORKER">{t('employees.type.WASH_WORKER')}</option>
              </Select>
            </Field>
            <p className="-mt-1 text-caption text-foreground-subtle">
              {t(`employees.type.${type}Hint`)}
            </p>
          </>
        ) : null}

        <WashWorkerLoginHint editing={Boolean(editing)} isWashWorker={isWashWorker} />

        <Field label={t('employees.form.name')} htmlFor="employee-name" error={errors.name ?? null}>
          <Input
            id="employee-name"
            data-dialog-autofocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label={t('employees.form.phone')} htmlFor="employee-phone">
          <Input
            id="employee-phone"
            dir="ltr"
            inputMode="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </Field>

        {/* A password is asked for exactly once, when a login is being created.
            On EDIT the equivalent field is the optional "new password" below,
            which sets rather than reveals. */}
        {needsPassword ? (
          <Field
            label={t('employees.form.password')}
            htmlFor="employee-password"
            error={errors.password ?? null}
            hint={t('employees.form.passwordHint')}
          >
            <PasswordInput
              id="employee-password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        ) : null}

        {/* SETTING a password, never revealing one. Rendered only for an ADMIN
            editing someone who HAS a login, and OPTIONAL: empty means "leave the
            password alone", so saving unrelated fields here never touches it.
            Masked by the shared PasswordInput — the same control, and the same
            eye toggle, the create form and the login screen already use. */}
        {canChangePassword ? (
          <Field
            label={t('employees.form.newPassword')}
            htmlFor="employee-new-password"
            error={errors.newPassword ?? null}
            hint={t('employees.form.newPasswordHint')}
          >
            <PasswordInput
              id="employee-new-password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </Field>
        ) : null}

        <Field
          label={t('employees.form.baseSalary')}
          htmlFor="employee-salary"
          hint={t('employees.form.salaryHint')}
        >
          {/* Entered in major units and parsed with the SHARED `parseMajor`, so
              the value that reaches the wire is integer piasters — exactly like
              every other amount in Station. No float is ever constructed. */}
          <Input
            id="employee-salary"
            inputMode="decimal"
            value={salary}
            onChange={(event) => setSalary(event.target.value)}
          />
        </Field>

        <Field label={t('employees.form.notes')} htmlFor="employee-notes">
          <Textarea
            id="employee-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
          />
        </Field>

        {/* The action row lives inside the dialog body, exactly like the other
            forms in the app — the shared Dialog has no footer slot. */}
        <DialogActions className="mt-1">
          <Button variant="ghost" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button onClick={save} disabled={busy || name.trim() === ''} loading={busy}>
            {t('app.save')}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  )
}

/**
 * The note explaining that a wash worker has no login.
 *
 * Shown only when CREATING a wash worker: the hint explains a choice the form
 * just made, and on an existing employee the type is already settled, so
 * repeating it would be noise. A cashier never sees it, because a cashier is
 * precisely the employee type that DOES have a login.
 */
function WashWorkerLoginHint({
  editing,
  isWashWorker,
}: Readonly<{ readonly editing: boolean; readonly isWashWorker: boolean }>) {
  const { t } = useTranslation()
  if (editing || !isWashWorker) return null
  return <p className="text-caption text-foreground-subtle">{t('employees.form.noLoginHint')}</p>
}
