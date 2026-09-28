/**
 * The drawer's own LIFECYCLE, which the page tests cannot pin down because they
 * always open it after the first read has already settled.
 *
 * What is asserted here is the order of the four situations the body can be in
 * — failure, first load, a record plus an in-flight re-read, and a record —
 * because that order is the whole contract of the panel: a failed read must
 * never be masked by a spinner, and a re-read must never blank a record the
 * manager is already reading.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import type { CustomerDetails } from '@/services/customersApi'
import { CustomerDetailsDrawer } from './CustomerDetailsDrawer'

const mocks = vi.hoisted(() => ({ details: vi.fn() }))

vi.mock('@/services/customersApi', () => ({
  customersApi: { details: mocks.details },
}))

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

const PERIOD = { from: '', to: '' }
/** The progress bar is an `<output>`, so it is announced by name, not text. */
const LOADING = i18n.t('app.loading')

const RECORD: CustomerDetails = {
  customer: { id: 1, name: 'أحمد سيد', phone: '01001234567', notes: 'عميل دائم' },
  created_at: '2026-08-01 09:00:00Z',
  cars: [],
  stats: {
    invoices_count: 2,
    total: 9_000,
    paid: 9_000,
    discounts: 0,
    service_charges: 0,
    average_order: 4_500,
    cafe_orders: 2,
    cafe_total: 9_000,
    wash_orders: 0,
    wash_total: 0,
    takeaway_orders: 0,
    table_orders: 2,
    first_at: '2026-09-01 10:00:00Z',
    last_at: '2026-09-10 12:00:00Z',
    credit_outstanding: 0,
    credit_original: 0,
    credit_paid: 0,
    credit_status: 'NONE',
  },
  activity: [],
}

function drawer(period = PERIOD) {
  return render(
    <CustomerDetailsDrawer
      customerId={1}
      customerName="أحمد سيد"
      period={period}
      onClose={() => {}}
    />,
  )
}

describe('CustomerDetailsDrawer lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.details.mockResolvedValue(RECORD)
  })

  it('reserves the record geometry while the first read is in flight', async () => {
    let release: (() => void) | undefined
    mocks.details.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(RECORD)
        }),
    )

    drawer()
    expect(await screen.findByRole('dialog', { name: 'أحمد سيد' })).toBeInTheDocument()
    // The record has not arrived, so none of its sections may be claimed.
    expect(screen.queryByText('ملخص الأداء')).not.toBeInTheDocument()

    await act(async () => {
      release?.()
    })

    expect(await screen.findByText('ملخص الأداء')).toBeInTheDocument()
  })

  it('keeps the loaded record readable and states the staleness of a re-read', async () => {
    const view = drawer()
    await screen.findByText('ملخص الأداء')

    // A pending re-read (the manager changed the period) must not blank the
    // record that is already on screen.
    let release: (() => void) | undefined
    mocks.details.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(RECORD)
        }),
    )

    view.rerender(
      <CustomerDetailsDrawer
        customerId={1}
        customerName="أحمد سيد"
        period={{ from: '2026-09-01', to: '2026-09-30' }}
        onClose={() => {}}
      />,
    )

    await waitFor(() => expect(mocks.details).toHaveBeenCalledTimes(2))
    expect(screen.getByText('ملخص الأداء')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: LOADING })).toBeInTheDocument()

    await act(async () => {
      release?.()
    })

    await waitFor(() =>
      expect(screen.queryByRole('status', { name: LOADING })).not.toBeInTheDocument(),
    )
    expect(screen.getByText('ملخص الأداء')).toBeInTheDocument()
  })

  it('reports a failure and re-reads on retry, never masking it with a spinner', async () => {
    mocks.details.mockRejectedValueOnce({ message: 'db.error' })
    drawer()
    const panel = await screen.findByRole('dialog', { name: 'أحمد سيد' })

    expect(within(panel).getByRole('alert')).toBeInTheDocument()
    expect(within(panel).queryByRole('status', { name: LOADING })).not.toBeInTheDocument()
    expect(within(panel).queryByText('ملخص الأداء')).not.toBeInTheDocument()

    fireEvent.click(within(panel).getByRole('button', { name: /إعادة المحاولة/ }))

    expect(await within(panel).findByText('ملخص الأداء')).toBeInTheDocument()
    expect(mocks.details).toHaveBeenCalledTimes(2)
  })

  it('drops the record when the drawer is closed, so it cannot show a stale customer', async () => {
    const view = drawer()
    await screen.findByText('ملخص الأداء')

    view.rerender(
      <CustomerDetailsDrawer
        customerId={null}
        customerName="أحمد سيد"
        period={PERIOD}
        onClose={() => {}}
      />,
    )

    expect(screen.queryByText('ملخص الأداء')).not.toBeInTheDocument()
  })
})
