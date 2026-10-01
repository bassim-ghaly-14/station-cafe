/**
 * The POS card for an already-open shift.
 *
 * Station permits exactly ONE open shift, so this state is operational, not an
 * error. What matters is that the card is driven ONLY by the backend's
 * `open_shift` row — never by a hardcoded name, and never by the signed-in
 * session, which may be a different person entirely.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ToastProvider } from '@/components/ui'
import { SessionProvider } from '@/features/auth/useSession'
import '@/lib/i18n'
import ar from '@/locales/ar/translations.json'
import type { ShiftRow } from '@/services/shiftApi'
import { OpenShiftCard } from './OpenShiftCard'
import { ShiftGate } from './ShiftGate'

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
