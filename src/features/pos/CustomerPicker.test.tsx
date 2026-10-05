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
  createCustomer: vi.fn(),
  createCar: vi.fn(),
}))

vi.mock('@/services/posApi', () => ({
  api: {
    customers: mocks.customers,
    attachCustomer: mocks.attachCustomer,
    detachCustomer: mocks.detachCustomer,
    getOrder: mocks.getOrder,
    createCustomer: mocks.createCustomer,
    createCar: mocks.createCar,
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
    mocks.customers.mockImplementation(async (query: string) =>
      query === '' ? REGISTERED : REGISTERED.filter((c) => c.name.includes(query)),
    )
    mocks.attachCustomer.mockResolvedValue(undefined)
    mocks.detachCustomer.mockResolvedValue(undefined)
    mocks.getOrder.mockResolvedValue({ id: 7 })
    mocks.createCustomer.mockResolvedValue(55)
    mocks.createCar.mockResolvedValue(undefined)
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

  it('searches through the backend after a debounce, not the first 60', async () => {
    renderPicker()
    await screen.findByText('أحمد محمود')
    // Only non-empty queries hit the scoped mock; browse stays REGISTERED.
    mocks.customers.mockImplementation(async (query: string) =>
      query === '' ? REGISTERED : [REGISTERED[2]!],
    )
    mocks.customers.mockClear()

    const search = screen.getByLabelText('بحث عن عميل')
    fireEvent.change(search, { target: { value: 'سعيد' } })
    // Debounced: no server search fires synchronously while typing.
    expect(mocks.customers).not.toHaveBeenCalled()
    await waitFor(() => expect(mocks.customers).toHaveBeenCalledWith('سعيد'), { timeout: 2000 })
    expect(await screen.findByText('سعيد علي')).toBeInTheDocument()
    expect(screen.queryByText('أحمد محمود')).not.toBeInTheDocument()
    expect(screen.getByText('نتائج البحث')).toBeInTheDocument()
  })

  it('passes phone and plate terms to the backend unchanged', async () => {
    renderPicker()
    await screen.findByText('أحمد محمود')
    mocks.customers.mockClear()
    const search = screen.getByLabelText('بحث عن عميل')

    fireEvent.change(search, { target: { value: '0111555' } })
    await waitFor(() => expect(mocks.customers).toHaveBeenCalledWith('0111555'), { timeout: 2000 })
  })

  it('drops stale responses so rapid typing keeps the newest answer', async () => {
    let resolveFirst!: (rows: CustomerWithCars[]) => void
    mocks.customers.mockImplementation(
      (query: string) =>
        new Promise<CustomerWithCars[]>((resolve) => {
          if (query === '') resolve(REGISTERED)
          else if (query === 'أ') resolveFirst = resolve
          else resolve([REGISTERED[2]!])
        }),
    )
    renderPicker()
    await screen.findByText('أحمد محمود')
    const search = screen.getByLabelText('بحث عن عميل')

    fireEvent.change(search, { target: { value: 'أ' } })
    await waitFor(() => expect(mocks.customers).toHaveBeenCalledWith('أ'), { timeout: 2000 })
    // Type the refinement before the first search resolves.
    fireEvent.change(search, { target: { value: 'سعيد' } })
    await waitFor(() => expect(mocks.customers).toHaveBeenCalledWith('سعيد'), { timeout: 2000 })
    // The stale first answer arrives late and must be ignored.
    resolveFirst([REGISTERED[0]!])
    await waitFor(() => expect(screen.getByText('سعيد علي')).toBeInTheDocument(), { timeout: 2000 })
    expect(screen.queryByText('أحمد محمود')).not.toBeInTheDocument()
  })

  it('clearing the search returns to the browse list', async () => {
    renderPicker()
    await screen.findByText('أحمد محمود')
    const search = screen.getByLabelText('بحث عن عميل')

    fireEvent.change(search, { target: { value: 'سعيد' } })
    await waitFor(() => expect(mocks.customers).toHaveBeenCalledWith('سعيد'), { timeout: 2000 })
    await screen.findByText('سعيد علي')

    fireEvent.change(search, { target: { value: '' } })
    await waitFor(() => expect(screen.getByText('العملاء المسجلون')).toBeInTheDocument())
    expect(screen.getByText('أحمد محمود')).toBeInTheDocument()
  })

  it('shows no matches when the backend finds nothing', async () => {
    mocks.customers.mockImplementation(async (query: string) =>
      query === '' ? REGISTERED : [],
    )
    renderPicker()
    await screen.findByText('أحمد محمود')

    fireEvent.change(screen.getByLabelText('بحث عن عميل'), { target: { value: 'لا يوجد' } })
    expect(await screen.findByText('لا يوجد عملاء مطابقون', undefined, { timeout: 2000 })).toBeInTheDocument()
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

  it('refreshes the browse list after a new customer is created, then attaches it', async () => {
    renderPicker()
    await screen.findByText('أحمد محمود')
    mocks.customers.mockClear()

    fireEvent.click(screen.getByText('عميل جديد'))
    fireEvent.change(await screen.findByLabelText('اسم العميل'), {
      target: { value: 'خالد نبيل' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    await waitFor(() =>
      expect(mocks.createCustomer).toHaveBeenCalledWith({ name: 'خالد نبيل', phone: null }),
    )
    await waitFor(() =>
      expect(mocks.attachCustomer).toHaveBeenCalledWith({
        order_id: 7,
        customer_id: 55,
        car_plate: null,
      }),
    )
    // The browse list is refreshed so the new customer is selectable at once.
    await waitFor(() => expect(mocks.customers).toHaveBeenCalledWith(''))
  })
})
