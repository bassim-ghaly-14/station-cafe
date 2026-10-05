/**
 * The managerial close flow: review → explicit confirmation → committed close.
 *
 * Behaviour-focused: the confirmation is mandatory, the pending state cannot
 * submit twice, a success refreshes the caller, and a backend rejection is
 * surfaced with the project's standard error UX instead of dismissing.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import '@/lib/i18n'
import ar from '@/locales/ar/translations.json'
import type { ShiftClosingPreview, ShiftRow } from '@/services/shiftApi'
import { ManagedCloseShiftDialog } from './ManagedCloseShiftDialog'

const mocks = vi.hoisted(() => ({
  previewManagedShiftClose: vi.fn(),
  closeManagedShift: vi.fn(),
  expensesOfShift: vi.fn(async () => []),
  printShift: vi.fn(async () => ({ duplicate_suppressed: false, job_id: 1 })),
}))

vi.mock('@/services/shiftApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/shiftApi')>()
  return {
    ...actual,
    shiftApi: {
      ...actual.shiftApi,
      previewManagedShiftClose: mocks.previewManagedShiftClose,
      closeManagedShift: mocks.closeManagedShift,
    },
  }
})

vi.mock('@/services/opsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/opsApi')>()
  return {
    ...actual,
    opsApi: { ...actual.opsApi, expensesOfShift: mocks.expensesOfShift },
  }
})

vi.mock('@/services/posApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/posApi')>()
  return { ...actual, api: { ...actual.api, printShift: mocks.printShift } }
})

const SHIFT: ShiftRow = {
  id: 7,
  business_day_id: 1,
  user_id: 2,
  user_name: 'أحمد سيد',
  user_role: 'STAFF',
  status: 'ACTIVE',
  opened_at: '2026-09-24 16:00:00Z',
  opening_cash: 1000,
  closed_at: null,
  cash_sales: 2000,
  card_sales: 0,
  credit_sales: 0,
  service_charges: 0,
  discounts: 0,
  invoices_count: 1,
  expected_cash: 3000,
  actual_cash: null,
  cash_difference: null,
  cafe_invoices: 1,
  wash_invoices: 0,
  hybrid_invoices: 0,
  subtotal: 2000,
  total_sales: 2000,
  cafe_sales: 2000,
  wash_sales: 0,
  expenses: 0,
  cash_expenses: 0,
}

const PREVIEW: ShiftClosingPreview = {
  shift: SHIFT,
  closing_at: '2026-09-25 01:30:00Z',
  cash_sales: 2000,
  card_sales: 0,
  credit_sales: 0,
  invoices_count: 1,
  expected_cash: 3000,
  cash_expenses: 0,
  expenses: 0,
  tables: { opens: 0, closed_empty: 0 },
  report: {
    shift: SHIFT,
    areas: { cafe_invoices: 1, wash_invoices: 0, hybrid_invoices: 0 },
    invoices_count: 1,
    cafe_sales: 2000,
    wash_sales: 0,
    subtotal: 2000,
    discounts: 0,
    service_charges: 0,
    total_sales: 2000,
    cash_sales: 2000,
    card_sales: 0,
    credit_sales: 0,
    expenses: 0,
    cash_expenses: 0,
    expense_breakdown: [],
    tables: { opens: 0, closed_empty: 0 },
    cash: {
      opening_cash: 1000,
      cash_inflows: 2000,
      cash_outflows: 0,
      expected_cash: 3000,
      actual_cash: 3000,
      difference: 0,
      shortage: 0,
      surplus: 0,
      status: 'BALANCED',
    },
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.previewManagedShiftClose.mockResolvedValue(PREVIEW)
  mocks.closeManagedShift.mockResolvedValue({
    shift: { ...SHIFT, status: 'CLOSED' },
    expected_cash: 3000,
    difference: 0,
    report: PREVIEW.report,
  })
  mocks.expensesOfShift.mockResolvedValue([])
})

function renderDialog() {
  const onClose = vi.fn()
  const onClosed = vi.fn(async () => {})
  render(
    <ToastProvider>
      <ManagedCloseShiftDialog shift={SHIFT} onClose={onClose} onClosed={onClosed} />
    </ToastProvider>,
  )
  return { onClose, onClosed }
}

/** Wait for the authoritative preview, type a counted drawer, press review-confirm. */
async function reviewAndConfirm() {
  const input = await screen.findByPlaceholderText('0.00')
  fireEvent.change(input, { target: { value: '30' } })
  fireEvent.click(screen.getByRole('button', { name: ar.shift.confirmClose }))
}

describe('ManagedCloseShiftDialog', () => {
  it('requires an explicit confirmation naming the cashier before anything is sent', async () => {
    renderDialog()
    await reviewAndConfirm()

    // The confirmation states the action, the cashier and the shift…
    const dialog = await screen.findByRole('dialog', {
      name: ar.shift.managerCloseConfirmTitle,
    })
    expect(dialog).toHaveTextContent(ar.shift.managerCloseConfirmBody)
    expect(dialog).toHaveTextContent(`وردية رقم ${SHIFT.id}`)
    expect(dialog).toHaveTextContent('أحمد سيد')
    // …and while it is open, nothing has been submitted.
    expect(mocks.closeManagedShift).not.toHaveBeenCalled()
  })

  it('closes only after the confirmation and then refreshes the caller', async () => {
    const { onClose, onClosed } = renderDialog()
    await reviewAndConfirm()

    fireEvent.click(await screen.findByRole('button', { name: ar.shift.managerCloseConfirmAction }))

    await waitFor(() => expect(mocks.closeManagedShift).toHaveBeenCalledTimes(1))
    // The counted drawer in MINOR units, against the reviewed shift id — the
    // same payload shape the cashier's own close sends.
    expect(mocks.closeManagedShift).toHaveBeenCalledWith(SHIFT.id, 3000)
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1))
    expect(onClose).toHaveBeenCalled()
    // The closing document prints through the SAME path the cashier flow uses.
    await waitFor(() => expect(mocks.printShift).toHaveBeenCalledWith(SHIFT.id))
  })

  it('cannot be submitted twice while the close is pending', async () => {
    renderDialog()
    let release!: (value: unknown) => void
    mocks.closeManagedShift.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    await reviewAndConfirm()
    const confirm = await screen.findByRole('button', {
      name: ar.shift.managerCloseConfirmAction,
    })

    fireEvent.click(confirm)
    await waitFor(() => expect(mocks.closeManagedShift).toHaveBeenCalledTimes(1))
    fireEvent.click(confirm)

    expect(mocks.closeManagedShift).toHaveBeenCalledTimes(1)
    // Let the pending close resolve INSIDE act, so its trailing state updates
    // are flushed the way the browser would flush them.
    await act(async () => {
      release({
        shift: { ...SHIFT, status: 'CLOSED' },
        expected_cash: 3000,
        difference: 0,
        report: PREVIEW.report,
      })
    })
  })

  it('surfaces a backend rejection with the standard error UX and stays open', async () => {
    mocks.closeManagedShift.mockRejectedValue(new Error('shift.not_closable'))
    const { onClose, onClosed } = renderDialog()
    await reviewAndConfirm()
    fireEvent.click(await screen.findByRole('button', { name: ar.shift.managerCloseConfirmAction }))

    // The stable machine key is translated through the normal error map…
    expect(await screen.findByRole('alert')).toHaveTextContent(ar.errors['shift.not_closable'])
    // …and a rejected close neither refreshes nor dismisses anything.
    expect(onClosed).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(mocks.printShift).not.toHaveBeenCalled()
  })
})
