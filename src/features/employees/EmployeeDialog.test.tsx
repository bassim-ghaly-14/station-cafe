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
  role: { current: 'ADMIN' as 'STAFF' | 'MANAGER' | 'ADMIN' },
}))

vi.mock('@/services/employeesApi', () => ({
  employeesApi: {
    create: mocks.create,
    update: mocks.update,
    setBaseSalary: mocks.setBaseSalary,
  },
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

describe('EmployeeDialog — edit', () => {
  it('offers exactly the four editable HR fields', () => {
    renderEdit()
    expect(screen.getByLabelText('الاسم')).toBeInTheDocument()
    expect(screen.getByLabelText('التليفون')).toBeInTheDocument()
    expect(screen.getByLabelText('الراتب الأساسي الشهري')).toBeInTheDocument()
    expect(screen.getByLabelText('ملاحظات')).toBeInTheDocument()
  })

  it('offers no control for role, type, status, account or password', () => {
    const { container } = renderEdit()
    // Not disabled, not read-only inputs: ABSENT. A disabled select would still
    // advertise that the value is negotiable.
    expect(screen.queryByLabelText('الدور')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('نوع الموظف')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('كلمة المرور')).not.toBeInTheDocument()
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
