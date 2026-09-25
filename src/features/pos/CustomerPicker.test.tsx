/**
 * The customer picker must be usable WITHOUT searching, must filter fast as the
 * user types, and must treat "بدون عميل" as a first-class choice.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '@/components/ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/lib/i18n'
import { CustomerPicker } from './CustomerPicker'
import type { CustomerWithCars } from '@/services/posApi'

const mocks = vi.hoisted(() => ({
  customers: vi.fn(),
  attachCustomer: vi.fn(),
  detachCustomer: vi.fn(),
  getOrder: vi.fn(),
}))

vi.mock('@/services/posApi', () => ({
  api: {
    customers: mocks.customers,
    attachCustomer: mocks.attachCustomer,
    detachCustomer: mocks.detachCustomer,
    getOrder: mocks.getOrder,
  },
}))

function customer(over: Partial<CustomerWithCars>): CustomerWithCars {
  return { id: 1, name: 'عميل', phone: null, notes: null, cars: [], ...over }
}

const REGISTERED: CustomerWithCars[] = [
  customer({ id: 1, name: 'أحمد محمود', phone: '01001234567' }),
  customer({
    id: 2,
    name: 'منى إبراهيم',
    phone: '01115556666',
    cars: [{ id: 9, customer_id: 2, plate_no: 'أ ب ج 1234', car_model: 'تويوتا', notes: null }],
  }),
  customer({ id: 3, name: 'سعيد علي', phone: '01222223333' }),
]

function renderPicker() {
  return render(
    <ToastProvider>
      <CustomerPicker orderId={7} onClose={vi.fn()} onAttached={vi.fn()} />
    </ToastProvider>,
  )
}

describe('CustomerPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.customers.mockResolvedValue(REGISTERED)
    mocks.attachCustomer.mockResolvedValue(undefined)
    mocks.detachCustomer.mockResolvedValue(undefined)
    mocks.getOrder.mockResolvedValue({ id: 7 })
  })

  it('shows the registered customers immediately, without a search', async () => {
    // The list is requested with an empty query: browsing is the default.
    expect(REGISTERED).toHaveLength(3)
    renderPicker()

    expect(await screen.findByText('أحمد محمود')).toBeInTheDocument()
    expect(screen.getByText('منى إبراهيم')).toBeInTheDocument()
    expect(screen.getByText('سعيد علي')).toBeInTheDocument()
    expect(mocks.customers).toHaveBeenCalledWith('')
    expect(screen.getByText('العملاء المسجلون')).toBeInTheDocument()
  })

  it('exposes the phone and the plate without overloading the card', async () => {
    renderPicker()

    expect(await screen.findByText('01001234567')).toBeInTheDocument()
    expect(screen.getByText('أ ب ج 1234')).toBeInTheDocument()
  })

  it('filters by name, phone and plate while typing, with no submit button', async () => {
    renderPicker()

    const search = await screen.findByLabelText('بحث عن عميل')
    fireEvent.change(search, { target: { value: 'سعيد' } })
    expect(screen.getByText('سعيد علي')).toBeInTheDocument()
    expect(screen.queryByText('أحمد محمود')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: '0111555' } })
    expect(screen.getByText('منى إبراهيم')).toBeInTheDocument()

    fireEvent.change(search, { target: { value: '1234' } })
    expect(screen.getByText('منى إبراهيم')).toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'لا يوجد' } })
    expect(screen.getByText('لا يوجد عملاء مطابقون')).toBeInTheDocument()
  })

  it('offers "بدون عميل" as an explicit, labeled choice', async () => {
    renderPicker()

    const choice = await screen.findByText('بدون عميل')

    fireEvent.click(choice)

    await waitFor(() => expect(mocks.detachCustomer).toHaveBeenCalledWith(7))
    expect(mocks.attachCustomer).not.toHaveBeenCalled()
  })

  it('attaches a chosen customer to the order', async () => {
    renderPicker()

    fireEvent.click(await screen.findByText('أحمد محمود'))

    await waitFor(() =>
      expect(mocks.attachCustomer).toHaveBeenCalledWith({
        order_id: 7,
        customer_id: 1,
        car_plate: null,
      }),
    )
  })
})
