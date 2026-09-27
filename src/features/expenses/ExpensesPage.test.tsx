/**
 * The expenses workspace, end to end through its real component tree.
 *
 * Two things are under test:
 *
 *  1. the create dialog's single business-date control (the original contract:
 *     the calendar hands the entity's ONE business date to the API as
 *     `YYYY-MM-DD`, and a calendar Escape dismisses the calendar — not the form);
 *  2. the ANALYTICS the page derives from the backend payload — that the KPI band
 *     renders the aggregates it was given, that the category ranking renders the
 *     resolved Arabic labels, and that an empty period shows a real empty state
 *     instead of a chart drawn around nothing.
 *
 * The page is mocked at the IPC boundary only. There is no arithmetic, no date
 * math and no aggregation in this file that the application does not also do in
 * production — every figure below is copied from the mocked backend payload.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { formatIsoDate, formatIsoDateLong, isoDate, parseIsoDate, todayIso } from '@/lib/date'
import { formatMinorMoney } from '@/lib/money'
import { ToastProvider } from '@/components/ui'
import ExpensesPage from './ExpensesPage'
import type { ExpenseOverview } from '@/services/opsApi'

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

/** A period with real, non-trivial data in every section. */
const POPULATED_OVERVIEW: ExpenseOverview = {
  total_amount: 30_000,
  expenses_count: 4,
  cash_amount: 12_000,
  cash_count: 2,
  recurring_amount: 15_000,
  recurring_count: 1,
  largest_amount: 10_000,
  average_amount: 7_500,
  categories: [
    { category: 'SALARY', category_name: 'رواتب', count: 1, amount: 20_000, share: 67 },
    { category: 'SUPPLIES', category_name: 'مشتريات', count: 3, amount: 10_000, share: 33 },
  ],
  days: [
    { day_date: '2026-03-01', count: 2, amount: 25_000 },
    { day_date: '2026-03-05', count: 1, amount: 5_000 },
  ],
}

const mocks = vi.hoisted(() => ({
  expenses: vi.fn(),
  expensesOverview: vi.fn(),
  createExpense: vi.fn(),
  expensesMonthly: vi.fn(),
  monthlySalesPeriod: vi.fn(),
  expenseCategories: vi.fn(async () => [
    { code: 'SUPPLIES', name_ar: 'مشتريات', is_system: true, is_active: true },
  ]),
}))

// The monthly chart window is a SETTING, read through the same settings API the
// Dev Settings page writes to — never the page's own date filter.
vi.mock('@/services/posApi', () => ({
  settingsApi: {
    monthlySalesPeriod: mocks.monthlySalesPeriod,
  },
}))

vi.mock('@/services/opsApi', () => ({
  // Categories are DATA from the backend category table, so the mock serves
  // the same shape the command returns rather than a hardcoded enum.
  opsApi: {
    expenses: mocks.expenses,
    expensesOverview: mocks.expensesOverview,
    expensesMonthly: mocks.expensesMonthly,
    createExpense: mocks.createExpense,
    expenseCategories: mocks.expenseCategories,
  },
}))

/** The monthly report the backend would return for the configured window. */
const MONTHLY_WINDOW = {
  from: '2026-01-01',
  to: '2026-03-31',
  report: {
    categories: [
      { code: 'SALARY', name_ar: 'رواتب', total: 30_000 },
      { code: 'SUPPLIES', name_ar: 'مشتريات', total: 10_000 },
    ],
    months: [
      { month: '2026-01', category: 'SALARY', category_name: 'رواتب', count: 1, amount: 10_000 },
      {
        month: '2026-02',
        category: 'SALARY',
        category_name: 'رواتب',
        count: 1,
        amount: 20_000,
      },
      {
        month: '2026-03',
        category: 'SUPPLIES',
        category_name: 'مشتريات',
        count: 1,
        amount: 10_000,
      },
    ],
  },
}

const today = todayIso()
const todayParts = parseIsoDate(today) ?? { year: 2026, month: 1, day: 1 }
const picked = isoDate(todayParts.year, todayParts.month, 10)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const dateFieldName = (iso: string) => new RegExp(`التاريخ: ${formatIsoDate(iso, 'ar-EG')}`)

// Let i18n finish initializing before anything renders, so no late re-render happens mid-test.
await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

function renderPage() {
  return render(
    <ToastProvider>
      <ExpensesPage />
    </ToastProvider>,
  )
}

/** Resets the persisted period so a previous test's choice cannot leak in. */
function clearStoredRange() {
  localStorage.removeItem('station.expenses.dateRange')
}

function openCreateDialog() {
  renderPage()
  fireEvent.click(screen.getByRole('button', { name: /مصروف جديد/ }))
  // The category <option>s come from the backend, so the dialog is only
  // submittable once they have loaded — wait for the loaded option to exist.
  return waitFor(() => expect(screen.getByRole('option', { name: 'مشتريات' })).toBeInTheDocument())
}

async function save() {
  // The amount field is the dialog's only decimal input (its Field <label> is a
  // sibling without `htmlFor`, so it is not part of the accessible name anywhere).
  const amount = document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')
  expect(amount).not.toBeNull()
  fireEvent.change(amount as HTMLInputElement, { target: { value: '12.50' } })

  fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))
  await waitFor(() => expect(mocks.createExpense).toHaveBeenCalledTimes(1))
}

function expenseDateFromCall() {
  const input = mocks.createExpense.mock.calls[0][0] as { expense_date: unknown }
  return input.expense_date
}

describe('CreateExpenseDialog single date', () => {
  beforeEach(() => {
    clearStoredRange()
    mocks.expenses.mockReset().mockResolvedValue([])
    mocks.expensesOverview.mockReset().mockResolvedValue(EMPTY_OVERVIEW)
    mocks.createExpense.mockReset().mockResolvedValue(1)
    // The monthly chart reads its own window; default it so the create-dialog
    // tests are not coupled to the chart's data.
    mocks.expensesMonthly.mockReset().mockResolvedValue(MONTHLY_WINDOW)
    mocks.monthlySalesPeriod.mockReset().mockResolvedValue({ months: 12 })
  })

  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage(DEFAULT_LOCALE)
    })
  })

  it('sends the default business date as a YYYY-MM-DD string', async () => {
    await openCreateDialog()
    expect(screen.getByRole('button', { name: dateFieldName(today) })).toBeInTheDocument()

    await save()

    expect(mocks.createExpense).toHaveBeenCalledWith({
      category: 'SUPPLIES',
      amount: 1250,
      description: null,
      expense_date: today,
      is_recurring: false,
      recurrence: null,
    })
    const sent = expenseDateFromCall()
    expect(typeof sent).toBe('string')
    expect(sent as string).toMatch(ISO_DATE)
  })

  it('renders مصروف دوري as the same shared Switch, not a styled checkbox', async () => {
    await openCreateDialog()
    const control = screen.getByRole('switch', { name: 'مصروف دوري' })

    // The shared Switch: a real switch button, standardized state tone.
    expect(control.tagName).toBe('BUTTON')
    expect(control).toHaveAttribute('aria-checked', 'false')
    expect(control.className).toContain('bg-switch-off-track')
    // The old implementation was a checkbox; it must not come back.
    expect(screen.queryByRole('checkbox', { name: 'مصروف دوري' })).not.toBeInTheDocument()
  })

  it('still drives the recurring flag and reveals the recurrence field', async () => {
    await openCreateDialog()
    // The recurrence field is gated on the toggle, so it is absent to start with.
    expect(screen.queryByText('الدورية')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: 'مصروف دوري' }))
    expect(screen.getByRole('switch', { name: 'مصروف دوري' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    // The dependent field is revealed exactly as before the refactor.
    expect(screen.getByText('الدورية')).toBeInTheDocument()

    await save()
    expect(mocks.createExpense).toHaveBeenCalledWith(
      expect.objectContaining({ is_recurring: true, recurrence: 'MONTHLY' }),
    )
  })

  it('sends the day picked in the calendar, unchanged', async () => {
    await openCreateDialog()
    fireEvent.click(screen.getByRole('button', { name: dateFieldName(today) }))

    const calendar = screen.getByRole('dialog', { name: 'التاريخ' })
    fireEvent.click(
      within(calendar).getByRole('button', {
        name: new RegExp(formatIsoDateLong(picked, 'ar-EG')),
      }),
    )

    // Picking closes the calendar and the trigger now shows the chosen day.
    expect(screen.queryByRole('dialog', { name: 'التاريخ' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: dateFieldName(picked) })).toBeInTheDocument()

    await save()

    expect(expenseDateFromCall()).toBe(picked)
  })
})

describe('CreateExpenseDialog calendar keyboard behaviour', () => {
  beforeEach(() => {
    clearStoredRange()
    mocks.expenses.mockReset().mockResolvedValue([])
    mocks.expensesOverview.mockReset().mockResolvedValue(EMPTY_OVERVIEW)
    mocks.createExpense.mockReset().mockResolvedValue(1)
    // The monthly chart reads its own window; default it so the create-dialog
    // tests are not coupled to the chart's data.
    mocks.expensesMonthly.mockReset().mockResolvedValue(MONTHLY_WINDOW)
    mocks.monthlySalesPeriod.mockReset().mockResolvedValue({ months: 12 })
  })

  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage(DEFAULT_LOCALE)
    })
  })

  it('closes the calendar on Escape without closing the expense form', async () => {
    await openCreateDialog()
    fireEvent.click(screen.getByRole('button', { name: dateFieldName(today) }))
    expect(screen.getByRole('dialog', { name: 'التاريخ' })).toBeInTheDocument()

    // Dispatch from the focused day cell, exactly like a key press inside the popover.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'التاريخ' })).not.toBeInTheDocument()
    // The form itself must survive: saving is still possible after abandoning the calendar.
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeInTheDocument()
    await save()
    expect(expenseDateFromCall()).toBe(today)
  })
})

describe('Expenses analytics', () => {
  beforeEach(() => {
    clearStoredRange()
    mocks.createExpense.mockReset().mockResolvedValue(1)
    mocks.expensesMonthly.mockReset().mockResolvedValue(MONTHLY_WINDOW)
    mocks.monthlySalesPeriod.mockReset().mockResolvedValue({ months: 12 })
    mocks.expenses.mockReset().mockResolvedValue([
      {
        id: 1,
        category: 'SUPPLIES',
        category_name: 'مشتريات',
        amount: 10_000,
        description: 'سكر',
        expense_date: '2026-03-01',
        is_recurring: false,
        recurrence: null,
        business_day_id: 1,
        shift_id: null,
        paid_from_cash: true,
        user_name: 'manager',
        user_role: 'MANAGER',
        created_at: '2026-03-01 10:00:00Z',
      },
    ])
    mocks.expensesOverview.mockReset().mockResolvedValue(POPULATED_OVERVIEW)
  })

  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage(DEFAULT_LOCALE)
    })
  })

  it('renders the backend aggregates, never a client-side re-sum', async () => {
    renderPage()

    // The headline is the payload's own total and the count beside it is the
    // payload's own count. Nothing here is added up from the single listed row.
    await screen.findByText('توزيع المصروفات على الفئات')
    expect(screen.getByText('إجمالي المصروفات')).toBeInTheDocument()
    expect(screen.getByText('عدد المصروفات')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    // The listed row is worth 100.00, but the headline reports the whole period.
    expect(screen.getByText(formatMinorMoney(30_000, { variant: 'auto' }))).toBeInTheDocument()
  })

  it('renders the category ranking with the labels the backend resolved', async () => {
    renderPage()

    expect(
      await screen.findByRole('heading', { name: 'توزيع المصروفات على الفئات' }),
    ).toBeInTheDocument()
    // Scoped to the ranking card: the monthly chart below names the same
    // categories in its own legend, so an unscoped query would be counting two
    // different components and would only pass when one of them had loaded.
    const ranking = screen
      .getByRole('heading', { name: 'توزيع المصروفات على الفئات' })
      .closest('section, div')
    expect(ranking).not.toBeNull()
    // `رواتب` only exists in the ranking, and its share is the server's figure.
    expect(within(ranking as HTMLElement).getByText('رواتب')).toBeInTheDocument()
    expect(within(ranking as HTMLElement).getByText('67%')).toBeInTheDocument()
    // `مشتريات` is both a ranking row and a listed record, so it appears twice.
    expect(screen.getAllByText('مشتريات').length).toBeGreaterThanOrEqual(2)
    expect(within(ranking as HTMLElement).getByText('33%')).toBeInTheDocument()
    // The bar carries its own accessible label, so colour is never the only signal.
    expect(screen.getByRole('img', { name: 'رواتب: 67%' })).toBeInTheDocument()
  })

  it('states that the cash and recurring slices are independent', async () => {
    renderPage()
    // The two tiles are not a decomposition of the headline, and the page says
    // so rather than letting the reader assume they add up.
    await screen.findByText('رواتب')
    expect(screen.getByText(/قراءتان مستقلتان/)).toBeInTheDocument()
  })

  it('shows a real empty state instead of a chart drawn around nothing', async () => {
    mocks.expensesOverview.mockResolvedValue(EMPTY_OVERVIEW)
    mocks.expenses.mockResolvedValue([])

    renderPage()

    expect(await screen.findByText('لا توجد مصروفات في هذه الفترة')).toBeInTheDocument()
    // The analytics sections must be ABSENT, not rendered empty.
    expect(
      screen.queryByRole('heading', { name: 'توزيع المصروفات على الفئات' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'المصروفات عبر الأيام' })).not.toBeInTheDocument()
  })

  it('reports a query failure with a working retry, not a blank page', async () => {
    // The service error is a translation key, exactly as a Tauri refusal is.
    mocks.expensesOverview.mockRejectedValueOnce(new Error('internal_error'))

    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent(/حدث خطأ غير متوقع/)
    // Retrying issues the same request again, and the page recovers when it does.
    mocks.expensesOverview.mockResolvedValue(POPULATED_OVERVIEW)
    fireEvent.click(screen.getByRole('button', { name: /إعادة المحاولة/ }))
    expect(await screen.findByText('رواتب')).toBeInTheDocument()
  })

  it('sends the SAME period to the analytics and the list', async () => {
    renderPage()
    await screen.findByText('رواتب')

    const [overviewFrom, overviewTo] = mocks.expensesOverview.mock.calls[0]
    const [listFrom, listTo] = mocks.expenses.mock.calls[0]
    expect(overviewFrom).toBe(listFrom)
    expect(overviewTo).toBe(listTo)
  })
})

describe('ExpensesPage monthly comparison', () => {
  beforeEach(() => {
    clearStoredRange()
    mocks.createExpense.mockReset().mockResolvedValue(1)
    mocks.expenses.mockReset().mockResolvedValue([])
    mocks.expensesOverview.mockReset().mockResolvedValue(POPULATED_OVERVIEW)
    mocks.expensesMonthly.mockReset().mockResolvedValue(MONTHLY_WINDOW)
    mocks.monthlySalesPeriod.mockReset().mockResolvedValue({ months: 12 })
  })

  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage(DEFAULT_LOCALE)
    })
  })

  // The monthly comparison MOVED to Reports → Charts, beside the sales one. This
  // page must not keep a second instance mounted: one chart, one location, one
  // read — and the expense categories stay this page's own ranking.
  it('no longer renders the monthly comparison, which lives in Reports', async () => {
    renderPage()
    await waitFor(() => expect(mocks.expensesOverview).toHaveBeenCalled())

    expect(mocks.expensesMonthly).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('heading', { name: 'المصروفات الشهرية حسب النوع' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('monthly-chart-expenses-monthly-by-category'),
    ).not.toBeInTheDocument()
  })
})
