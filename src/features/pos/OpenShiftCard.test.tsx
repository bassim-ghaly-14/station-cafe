/**
 * The POS card for an already-open shift.
 *
 * Station permits exactly ONE open shift, so this state is operational, not an
 * error. What matters is that the card is driven ONLY by the backend's
 * `open_shift` row — never by a hardcoded name, and never by the signed-in
 * session, which may be a different person entirely.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import { SessionProvider } from '@/features/auth/useSession'
import '@/lib/i18n'
import ar from '@/locales/ar/translations.json'
import type { ShiftClosingPreview, ShiftRow } from '@/services/shiftApi'
import { OpenShiftCard } from './OpenShiftCard'
import { ShiftGate } from './ShiftGate'

/**
 * The session the transport answers `me` with — the same arrangement
 * `PosPage.test` uses. `null` (no token) is the default, so the pre-existing
 * tests below keep seeing an anonymous session.
 */
const session = vi.hoisted(() => ({ user: null as Record<string, unknown> | null }))

vi.mock('@/services/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/ipc')>()),
  call: vi.fn(async (cmd: string) => {
    if (cmd === 'me') {
      if (!session.user) throw new Error('no session')
      return session.user
    }
    throw new Error(`unexpected command: ${cmd}`)
  }),
}))

/** The reads the managerial dialog performs, stubbed at the service layer. */
const managedMocks = vi.hoisted(() => ({
  previewManagedShiftClose: vi.fn(),
  closeManagedShift: vi.fn(),
  expensesOfShift: vi.fn(async () => []),
}))

vi.mock('@/services/shiftApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/shiftApi')>()
  return {
    ...actual,
    shiftApi: {
      ...actual.shiftApi,
      previewManagedShiftClose: managedMocks.previewManagedShiftClose,
      closeManagedShift: managedMocks.closeManagedShift,
    },
  }
})

vi.mock('@/services/opsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/opsApi')>()
  return {
    ...actual,
    opsApi: { ...actual.opsApi, expensesOfShift: managedMocks.expensesOfShift },
  }
})

/** A backend-shaped preview, so the review dialog renders real figures. */
const OPEN_SHIFT: ShiftRow = {
  id: 4,
  business_day_id: 1,
  user_id: 2,
  user_name: 'أحمد سيد',
  user_role: 'STAFF',
  status: 'ACTIVE',
  opened_at: '2026-09-25 08:00:00Z',
  opening_cash: 0,
  closed_at: null,
  cash_sales: 2000,
  card_sales: 0,
  credit_sales: 0,
  service_charges: 0,
  discounts: 0,
  invoices_count: 1,
  expected_cash: 2000,
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
  shift: OPEN_SHIFT,
  closing_at: '2026-09-25 14:00:00Z',
  cash_sales: 2000,
  card_sales: 0,
  credit_sales: 0,
  invoices_count: 1,
  expected_cash: 2000,
  cash_expenses: 0,
  expenses: 0,
  tables: { opens: 0, closed_empty: 0 },
  report: {
    shift: OPEN_SHIFT,
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
      opening_cash: 0,
      cash_inflows: 2000,
      cash_outflows: 0,
      expected_cash: 2000,
      actual_cash: 2000,
      difference: 0,
      shortage: 0,
      surplus: 0,
      status: 'BALANCED',
    },
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  // An anonymous session unless a test below explicitly signs someone in, so
  // the pre-existing card tests keep exercising the no-session behaviour.
  session.user = null
  localStorage.clear()
  managedMocks.previewManagedShiftClose.mockResolvedValue(PREVIEW)
})

function shift(over: Partial<ShiftRow> = {}): ShiftRow {
  return {
    id: 4,
    business_day_id: 1,
    user_id: 2,
    user_name: 'أحمد سيد',
    user_role: 'STAFF',
    status: 'ACTIVE',
    opened_at: '2026-09-25 08:00:00Z',
    opening_cash: 0,
    closed_at: null,
    cash_sales: 0,
    card_sales: 0,
    credit_sales: 0,
    service_charges: 0,
    discounts: 0,
    invoices_count: 0,
    expected_cash: 0,
    actual_cash: null,
    cash_difference: null,
    cafe_invoices: 0,
    wash_invoices: 0,
    hybrid_invoices: 0,
    subtotal: 0,
    total_sales: 0,
    cafe_sales: 0,
    wash_sales: 0,
    expenses: 0,
    cash_expenses: 0,
    ...over,
  }
}

function renderGate(open_shift: ShiftRow | null, my_shift: ShiftRow | null = null) {
  return render(
    <ToastProvider>
      <SessionProvider>
        <ShiftGate
          state={{
            day: {
              id: 1,
              day_date: '2026-09-25',
              status: 'OPEN',
              opened_at: '2026-09-25 08:00:00Z',
            },
            my_shift,
            open_shift,
          }}
          onReady={() => {}}
        />
      </SessionProvider>
    </ToastProvider>,
  )
}

describe('POS open-shift card', () => {
  it('is absent when no shift is open', () => {
    renderGate(null)

    expect(screen.queryByText(ar.shift.alreadyOpenTitle)).not.toBeInTheDocument()
    // With nothing open, the gate offers the open-shift action instead.
    expect(screen.getByRole('button', { name: ar.shift.openShift })).toBeInTheDocument()
  })

  it('is displayed when a shift is open that the caller does not own', () => {
    renderGate(shift(), null)

    expect(screen.getByText(ar.shift.alreadyOpenTitle)).toBeInTheDocument()
  })

  it('shows the dynamic cashier name of the employee who opened the shift', () => {
    renderGate(shift({ user_name: 'سلمى عبد الله' }), null)

    expect(screen.getAllByText('سلمى عبد الله').length).toBeGreaterThan(0)
    // The name is read from the shift, so a different shift shows a different
    // cashier rather than anything baked into the component.
    expect(screen.queryByText('أحمد سيد')).not.toBeInTheDocument()
  })

  it('communicates that no other shift can be opened', () => {
    renderGate(shift(), null)

    expect(screen.getByText(ar.shift.alreadyOpenHint)).toBeInTheDocument()
    expect(screen.getByText(ar.shift.alreadyOpenBlocked)).toBeInTheDocument()
    // The action the backend would refuse must not be offered at all.
    expect(screen.queryByRole('button', { name: ar.shift.openShift })).not.toBeInTheDocument()
  })

  it('uses translated copy rather than hardcoded strings', () => {
    renderGate(shift(), null)

    expect(ar.shift.alreadyOpenTitle).toBeTruthy()
    expect(ar.shift.alreadyOpenHint).toBeTruthy()
    expect(ar.shift.alreadyOpenBlocked).toBeTruthy()
    expect(ar.shift.cashier).toBeTruthy()
  })

  it('is an operational status card of the closing-card family, not an alert', () => {
    const { container } = render(
      <SessionProvider>
        <OpenShiftCard shift={shift()} />
      </SessionProvider>,
    )

    // Same structural identity as the shift/day closing cards...
    expect(container.querySelector('[data-closing="shift"]')).toBeInTheDocument()
    // ...and it announces itself as a section, not as an error/alert region.
    expect(screen.getByRole('heading', { name: ar.shift.alreadyOpenTitle })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not offer the open-shift form to the owner of the open shift', () => {
    // The owner's own open shift is the selling workspace, not the gate, so the
    // card must never double up with the shift panel.
    const owned = shift()
    renderGate(owned, owned)

    expect(screen.queryByText(ar.shift.alreadyOpenTitle)).not.toBeInTheDocument()
  })
})

describe('POS open-shift card — managerial recovery', () => {
  /** Sign a role in: the token makes `SessionProvider` resolve `me`. */
  function signIn(role: 'ADMIN' | 'MANAGER' | 'STAFF') {
    localStorage.setItem('station.session.token', 'test-token')
    session.user = {
      id: 1,
      name: 'manager',
      phone: null,
      role,
      status: 'ACTIVE',
      created_at: '',
      updated_at: '',
    }
  }

  it('offers the managerial close to a MANAGER and opens the review dialog', async () => {
    signIn('MANAGER')
    renderGate(shift(), null)

    const action = await screen.findByTestId('manager-close-shift')
    expect(action).toHaveTextContent(ar.shift.managerCloseAction)

    fireEvent.click(action)
    // The review is the SAME close document the cashier sees, driven by the
    // MANAGER-only preview command…
    expect(await screen.findByRole('dialog', { name: ar.shift.closeTitle })).toBeInTheDocument()
    expect(managedMocks.previewManagedShiftClose).toHaveBeenCalledWith(4)
    // …and opening the dialog has committed nothing.
    expect(managedMocks.closeManagedShift).not.toHaveBeenCalled()
  })

  it('offers it to an ADMIN as well', async () => {
    signIn('ADMIN')
    renderGate(shift(), null)

    expect(await screen.findByTestId('manager-close-shift')).toBeInTheDocument()
  })

  it('never shows the managerial action to a STAFF session', async () => {
    signIn('STAFF')
    renderGate(shift(), null)

    // The blocked state the backend enforces for everyone else is still what
    // a cashier sees — no manager affordance, no dialog.
    expect(await screen.findByText(ar.shift.alreadyOpenBlocked)).toBeInTheDocument()
    expect(screen.queryByTestId('manager-close-shift')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
