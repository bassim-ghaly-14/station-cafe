/**
 * Integration check for the expense-create single-date control: the calendar hands
 * the entity's ONE business date to the API as `YYYY-MM-DD`, and a calendar Escape
 * dismisses the calendar — not the form. The DatePicker's own behaviour is covered
 * by its component test.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { formatIsoDate, formatIsoDateLong, isoDate, parseIsoDate, todayIso } from '@/lib/date'
import { ToastProvider } from '@/components/ui'
import ExpensesPage from './ExpensesPage'

const mocks = vi.hoisted(() => ({
  expenses: vi.fn(),
  createExpense: vi.fn(),
}))

vi.mock('@/services/opsApi', () => ({
  // The dialog only maps this list into <option>s; the date payload is what matters here.
  EXPENSE_CATEGORIES: [],
  opsApi: { expenses: mocks.expenses, createExpense: mocks.createExpense },
}))

const today = todayIso()
const todayParts = parseIsoDate(today) ?? { year: 2026, month: 1, day: 1 }
const picked = isoDate(todayParts.year, todayParts.month, 10)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const dateFieldName = (iso: string) => new RegExp(`التاريخ: ${formatIsoDate(iso, 'ar-EG')}`)

// Let i18n finish initializing before anything renders, so no late re-render happens mid-test.
await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

function openCreateDialog() {
  render(
    <ToastProvider>
      <ExpensesPage />
    </ToastProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: /مصروف جديد/ }))
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
    mocks.expenses.mockReset().mockResolvedValue([])
    mocks.createExpense.mockReset().mockResolvedValue(1)
  })

  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage(DEFAULT_LOCALE)
    })
  })

  it('sends the default business date as a YYYY-MM-DD string', async () => {
    openCreateDialog()
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

  it('sends the day picked in the calendar, unchanged', async () => {
    openCreateDialog()
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
    mocks.expenses.mockReset().mockResolvedValue([])
    mocks.createExpense.mockReset().mockResolvedValue(1)
  })

  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage(DEFAULT_LOCALE)
    })
  })

  it('closes the calendar on Escape without closing the expense form', async () => {
    openCreateDialog()
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
