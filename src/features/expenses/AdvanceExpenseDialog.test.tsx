/**
 * An advance is money paid to an employee, so the category that means "advance"
 * must name WHICH employee, and no other category may be asked for one. The rule
 * itself lives in the database and reaches the UI as `requires_employee` on the
 * category payload — so these tests never name a category code as a rule, they
 * only assert that the DATA decides.
 *
 * The two entry points are the Manager's expense page and the cashier's shift
 * form. They mount the SAME selector component and call the SAME `create_expense`
 * command, which is what parity means here: the same assertions run against both,
 * and the payload each sends is asserted to be the same shape.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import ExpensesPage from './ExpensesPage'
import { ShiftExpenseDialog } from '@/features/pos/ShiftExpenses'
import type { ExpenseCategory, Expense, ExpenseOverview } from '@/services/opsApi'
import '@/lib/i18n'

/**
 * The backend's category table, as data. `requires_employee` is the ONLY thing
 * that separates the two rows, which is exactly the point under test.
 */
const CATEGORIES: ExpenseCategory[] = [
  {
    code: 'SUPPLIES',
    name_ar: 'مشتريات',
    is_system: true,
    is_active: true,
    requires_employee: false,
  },
  {
    code: 'ADVANCE',
    name_ar: 'سلفة',
    is_system: true,
    is_active: true,
    requires_employee: true,
  },
]

const EMPTY_OVERVIEW: ExpenseOverview = {
  total_amount: 0,
  expenses_count: 0,
  cash_amount: 0,
  cash_count: 0,
  recurring_amount: 0,
  recurring_count: 0,
  largest_amount: 0,
  average_amount: 0,
  categories: [],
  days: [],
}

/** The roster the shared selector reads, exactly as `list_employees` returns it. */
const EMPLOYEES = {
  management_visible: true,
  employees: [
    {
      id: 7,
      user_id: 3,
      name: 'أحمد سيد',
      phone: '01000000001',
      employee_type: 'CASHIER' as const,
      status: 'ACTIVE' as const,
      login_role: 'STAFF' as const,
      base_salary: 1_000_000,
      notes: null,
      created_at: '2026-01-01 08:00:00Z',
      updated_at: '2026-01-01 08:00:00Z',
      attendance_days: null,
      worked_minutes: null,
      absence_days: null,
      leave_days: null,
      today_state: null,
      today_check_in_effective_at: null,
      today_check_out_effective_at: null,
      shifts_count: null,
      cafe_revenue: null,
    },
    {
      id: 9,
      user_id: null,
      name: 'محمود عبد',
      phone: null,
      employee_type: 'WASH_WORKER' as const,
      status: 'ACTIVE' as const,
      login_role: null,
      base_salary: 800_000,
      notes: null,
      created_at: '2026-01-01 08:00:00Z',
      updated_at: '2026-01-01 08:00:00Z',
      attendance_days: null,
      worked_minutes: null,
      absence_days: null,
      leave_days: null,
      today_state: null,
      today_check_in_effective_at: null,
      today_check_out_effective_at: null,
      shifts_count: null,
      cafe_revenue: null,
    },
  ],
}

const mocks = vi.hoisted(() => ({
  // The mocks are TYPED by what the production code sends, so a test reading
  // `calls[0][0]` sees the real payload shape instead of an empty tuple.
  createExpense: vi.fn(async (_input: Record<string, unknown>) => 42),
  expenseCategories: vi.fn(),
  employeeList: vi.fn(),
  expenses: vi.fn(async () => [] as Expense[]),
  expensesOverview: vi.fn(),
  expensesMonthly: vi.fn(),
}))

vi.mock('@/services/opsApi', () => ({
  opsApi: {
    createExpense: mocks.createExpense,
    expenseCategories: mocks.expenseCategories,
    expenses: mocks.expenses,
    expensesOverview: mocks.expensesOverview,
    expensesMonthly: mocks.expensesMonthly,
    shiftExpenses: vi.fn(async () => [] as Expense[]),
  },
}))

vi.mock('@/services/employeesApi', () => ({
  employeesApi: { list: mocks.employeeList },
}))

vi.mock('@/services/posApi', () => ({
  settingsApi: { monthlySalesPeriod: vi.fn(async () => ({ months: 12 })) },
}))

/** The employee search box, as the shared component labels it. */
function employeeField() {
  return screen.queryByRole('textbox', { name: 'ابحث بالاسم أو التليفون' })
}

function chooseCategory(code: 'SUPPLIES' | 'ADVANCE') {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: code } })
}

function typeAmount(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')
  expect(input).not.toBeNull()
  fireEvent.change(input as HTMLInputElement, { target: { value } })
}

function clickSave() {
  fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))
}

/** Opens the MANAGER's create-expense dialog, through the real page. */
async function openManagerDialog() {
  render(
    <ToastProvider>
      <ExpensesPage />
    </ToastProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: /مصروف جديد/ }))
  // The category <option>s come from the backend, so the dialog is only ready
  // once they have loaded.
  await waitFor(() => expect(screen.getByRole('option', { name: 'مشتريات' })).toBeInTheDocument())
}

/** Opens the CASHIER's shift-expense dialog. */
async function openCashierDialog() {
  const onCreated = vi.fn()
  render(
    <ToastProvider>
      <ShiftExpenseDialog open onClose={vi.fn()} onCreated={onCreated} />
    </ToastProvider>,
  )
  await waitFor(() => expect(screen.getByRole('option', { name: 'مشتريات' })).toBeInTheDocument())
  return onCreated
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.removeItem('station.expenses.dateRange')
  mocks.expenseCategories.mockResolvedValue(CATEGORIES)
  mocks.employeeList.mockResolvedValue(EMPLOYEES)
  mocks.expensesOverview.mockResolvedValue(EMPTY_OVERVIEW)
})

describe('Manager expense dialog — an employee-linked category', () => {
  it('shows no employee field for a normal category', async () => {
    await openManagerDialog()
    expect(employeeField()).not.toBeInTheDocument()
  })

  it('shows a required employee field as soon as the advance category is chosen', async () => {
    await openManagerDialog()
    chooseCategory('ADVANCE')
    await waitFor(() => expect(employeeField()).toBeInTheDocument())
    expect(screen.getByText('الموظف *')).toBeInTheDocument()
  })

  it('refuses to submit an advance with no employee chosen', async () => {
    await openManagerDialog()
    chooseCategory('ADVANCE')
    await waitFor(() => expect(employeeField()).toBeInTheDocument())
    typeAmount('200')
    clickSave()
    await waitFor(() =>
      expect(screen.getByText('يجب اختيار الموظف لهذه الفئة')).toBeInTheDocument(),
    )
    expect(mocks.createExpense).not.toHaveBeenCalled()
  })

  it('sends the chosen employee id — never a name — with the advance', async () => {
    await openManagerDialog()
    chooseCategory('ADVANCE')
    await waitFor(() => expect(employeeField()).toBeInTheDocument())
    typeAmount('200')
    fireEvent.click(await screen.findByRole('button', { name: /أحمد سيد/ }))
    clickSave()
    await waitFor(() => expect(mocks.createExpense).toHaveBeenCalledTimes(1))
    expect(mocks.createExpense.mock.calls[0][0]).toMatchObject({
      category: 'ADVANCE',
      amount: 20_000,
      employee_id: 7,
    })
  })

  it('drops the selection and hides the field when switching back to a normal category', async () => {
    await openManagerDialog()
    chooseCategory('ADVANCE')
    await waitFor(() => expect(employeeField()).toBeInTheDocument())
    typeAmount('200')
    fireEvent.click(await screen.findByRole('button', { name: /أحمد سيد/ }))

    chooseCategory('SUPPLIES')
    await waitFor(() => expect(employeeField()).not.toBeInTheDocument())

    clickSave()
    await waitFor(() => expect(mocks.createExpense).toHaveBeenCalledTimes(1))
    // The stale id is NOT carried across: a normal expense can never be linked to
    // an employee by accident.
    expect(mocks.createExpense.mock.calls[0][0]).toMatchObject({ employee_id: null })
  })

  it('brings the requirement back when the advance category is chosen again', async () => {
    await openManagerDialog()
    chooseCategory('ADVANCE')
    await waitFor(() => expect(employeeField()).toBeInTheDocument())
    chooseCategory('SUPPLIES')
    await waitFor(() => expect(employeeField()).not.toBeInTheDocument())
    chooseCategory('ADVANCE')
    await waitFor(() => expect(employeeField()).toBeInTheDocument())
  })

  it('filters the roster by the typed name', async () => {
    await openManagerDialog()
    chooseCategory('ADVANCE')
    const search = await waitFor(() => employeeField())
    fireEvent.change(search as HTMLElement, { target: { value: 'محمود' } })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /محمود عبد/ })).toBeInTheDocument(),
    )
    expect(screen.queryByRole('button', { name: /أحمد سيد/ })).not.toBeInTheDocument()
  })
})

describe('Cashier shift expense dialog — the same rule', () => {
  it('shows no employee field for a normal category', async () => {
    await openCashierDialog()
    expect(employeeField()).not.toBeInTheDocument()
  })

  it('requires an employee for the advance category, exactly like the manager form', async () => {
    await openCashierDialog()
    chooseCategory('ADVANCE')
    await waitFor(() => expect(employeeField()).toBeInTheDocument())
    typeAmount('100')
    clickSave()
    await waitFor(() =>
      expect(screen.getByText('يجب اختيار الموظف لهذه الفئة')).toBeInTheDocument(),
    )
    expect(mocks.createExpense).not.toHaveBeenCalled()
  })

  it('produces the same domain payload the manager form produces', async () => {
    await openCashierDialog()
    chooseCategory('ADVANCE')
    await waitFor(() => expect(employeeField()).toBeInTheDocument())
    typeAmount('100')
    fireEvent.click(await screen.findByRole('button', { name: /أحمد سيد/ }))
    clickSave()
    await waitFor(() => expect(mocks.createExpense).toHaveBeenCalledTimes(1))
    // Identical in shape to the manager's advance: the only difference between the
    // two paths is the existing role permission, never a second business rule.
    expect(mocks.createExpense.mock.calls[0][0]).toMatchObject({
      category: 'ADVANCE',
      amount: 10_000,
      employee_id: 7,
    })
  })

  it('carries no employee for a normal expense and refreshes the shift panel', async () => {
    const onCreated = await openCashierDialog()
    typeAmount('50')
    clickSave()
    await waitFor(() => expect(mocks.createExpense).toHaveBeenCalledTimes(1))
    expect(mocks.createExpense.mock.calls[0][0]).toMatchObject({ employee_id: null })
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
  })
})
