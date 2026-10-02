/**
 * The expense-category permission matrix, as the page presents it.
 *
 * The backend owns the real boundary — `services::ops` refuses a MANAGER's
 * delete and every cashier's write, which `expense_categories_test.rs` asserts
 * in Rust. What is under test HERE is the half React is responsible for: the
 * actions a role is SHOWN.
 *
 *   - a MANAGER may add a category and rename one, and is never shown the
 *     destructive action at all — not shown disabled, not shown;
 *   - an ADMIN may do all three, and the delete still goes through the shared
 *     confirmation before it is sent;
 *   - a cashier is offered no category management whatsoever, because the
 *     category management command surface is manager-level in the first place.
 *
 * The page is mocked at the IPC boundary only: the role comes from the session
 * hook, and the assertions are about which commands the page is willing to send.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { ToastProvider } from '@/components/ui'
import ExpensesPage from './ExpensesPage'

const CATEGORIES = [
  {
    code: 'SUPPLIES',
    name_ar: 'مشتريات',
    is_system: true,
    is_active: true,
    requires_employee: false,
  },
  { code: 'SALARY', name_ar: 'رواتب', is_system: true, is_active: true, requires_employee: false },
]

const mocks = vi.hoisted(() => ({
  role: { current: 'MANAGER' as string },
  expenses: vi.fn(async () => []),
  expensesOverview: vi.fn(async () => ({
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
  })),
  expensesMonthly: vi.fn(async () => ({
    from: '2026-01-01',
    to: '2026-03-31',
    report: { categories: [], months: [] },
  })),
  monthlySalesPeriod: vi.fn(async () => ({ months: 12 })),
  expenseCategories: vi.fn(async () => CATEGORIES),
  createExpenseCategory: vi.fn(async () => 'CAT_7'),
  renameExpenseCategory: vi.fn(async () => undefined),
  deleteExpenseCategory: vi.fn(async () => undefined),
}))

// The monthly chart window is a SETTING, read through its own settings API.
vi.mock('@/services/posApi', () => ({
  settingsApi: { monthlySalesPeriod: mocks.monthlySalesPeriod },
}))

vi.mock('@/services/opsApi', () => ({
  opsApi: {
    expenses: mocks.expenses,
    expensesOverview: mocks.expensesOverview,
    expensesMonthly: mocks.expensesMonthly,
    createExpense: vi.fn(),
    expenseCategories: mocks.expenseCategories,
    createExpenseCategory: mocks.createExpenseCategory,
    renameExpenseCategory: mocks.renameExpenseCategory,
    deleteExpenseCategory: mocks.deleteExpenseCategory,
  },
}))

vi.mock('@/features/auth/useSession', () => ({
  useOptionalSession: () => ({ user: { id: 1, name: 'سعيد', role: mocks.role.current } }),
  atLeast: (role: string | undefined, min: string) => {
    const rank = (value?: string) =>
      value === 'ADMIN' ? 3 : value === 'MANAGER' ? 2 : value === 'STAFF' ? 1 : 0
    return rank(role) >= rank(min)
  },
}))

function renderPage() {
  return render(
    <ToastProvider>
      <ExpensesPage />
    </ToastProvider>,
  )
}

async function openCategories() {
  renderPage()
  fireEvent.click(await screen.findByRole('button', { name: 'إدارة فئات المصروف' }))
  const dialog = await screen.findByRole('dialog', { name: 'إدارة فئات المصروف' })
  await waitFor(() => expect(within(dialog).getByText('مشتريات')).toBeInTheDocument())
  return dialog
}

/** The row actions of the FIRST category, which the fixture names «مشتريات». */
function rowAction(dialog: HTMLElement, testId: string) {
  return within(dialog).getAllByTestId(testId)[0]
}

beforeEach(async () => {
  localStorage.removeItem('station.expenses.dateRange')
  mocks.role.current = 'MANAGER'
  for (const fn of [
    mocks.createExpenseCategory,
    mocks.renameExpenseCategory,
    mocks.deleteExpenseCategory,
  ]) {
    fn.mockClear()
  }
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

describe('Expense categories — MANAGER', () => {
  it('may add and rename a category', async () => {
    const dialog = await openCategories()

    // Addition: the typed name is sent, and the backend owns the code.
    fireEvent.change(within(dialog).getByLabelText('اسم فئة المصروف'), {
      target: { value: 'صيانة المصعد' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'إضافة فئة مصروف' }))
    await waitFor(() => expect(mocks.createExpenseCategory).toHaveBeenCalledWith('صيانة المصعد'))

    // Rename: the row's pencil opens the edit field, and saving sends the SAME
    // code with the new name — the link every past expense holds.
    fireEvent.click(rowAction(dialog, 'expense-category-edit'))
    fireEvent.change(within(dialog).getByLabelText('تعديل فئة المصروف'), {
      target: { value: 'مشتريات المقهى' },
    })
    fireEvent.click(within(dialog).getByTestId('expense-category-save'))
    await waitFor(() => expect(mocks.renameExpenseCategory).toHaveBeenCalledTimes(1))
  })

  it('is never shown the delete action, disabled or otherwise', async () => {
    const dialog = await openCategories()

    // Rendered for an ADMIN, absent for a manager: an action the role cannot
    // perform is never offered in the first place.
    expect(within(dialog).queryAllByTestId('expense-category-delete')).toHaveLength(0)
    expect(within(dialog).queryByRole('button', { name: /حذف فئة المصروف/ })).toBeNull()

    // And the command behind it is never even reached.
    expect(mocks.deleteExpenseCategory).not.toHaveBeenCalled()
  })
})

describe('Expense categories — ADMIN', () => {
  it('is offered the delete action behind the shared confirmation', async () => {
    mocks.role.current = 'ADMIN'
    const dialog = await openCategories()

    fireEvent.click(rowAction(dialog, 'expense-category-delete'))

    // The confirmation names the category, and nothing is sent until it is
    // explicitly confirmed.
    const confirm = await screen.findByRole('dialog', { name: 'حذف فئة المصروف' })
    expect(confirm).toHaveTextContent('مشتريات')
    expect(mocks.deleteExpenseCategory).not.toHaveBeenCalled()

    fireEvent.click(within(confirm).getByRole('button', { name: 'حذف فئة المصروف' }))
    await waitFor(() => expect(mocks.deleteExpenseCategory).toHaveBeenCalledWith('SUPPLIES'))
  })

  it('keeps the category when the delete is cancelled', async () => {
    mocks.role.current = 'ADMIN'
    const dialog = await openCategories()

    fireEvent.click(rowAction(dialog, 'expense-category-delete'))
    const confirm = await screen.findByRole('dialog', { name: 'حذف فئة المصروف' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'إلغاء' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'حذف فئة المصروف' })).not.toBeInTheDocument(),
    )
    expect(mocks.deleteExpenseCategory).not.toHaveBeenCalled()
  })
})

describe('Expense categories — other roles', () => {
  it('offers a cashier no category management at all', async () => {
    mocks.role.current = 'STAFF'
    renderPage()

    expect(await screen.findByRole('button', { name: 'مصروف جديد' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'إدارة فئات المصروف' })).toBeNull()
    // Nothing was even asked for: the management read is never issued.
    expect(mocks.expenseCategories).not.toHaveBeenCalled()
  })
})
