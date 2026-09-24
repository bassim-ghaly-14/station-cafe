import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import '@/lib/i18n'
import CatalogPage from './CatalogPage'
import type { Product } from '@/services/posApi'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listCategories: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  setActive: vi.fn(),
}))

vi.mock('@/services/catalogApi', () => ({
  catalogApi: {
    list: mocks.list,
    listCategories: mocks.listCategories,
    create: mocks.create,
    update: mocks.update,
    setActive: mocks.setActive,
    rename: vi.fn(),
    setPrice: vi.fn(),
  },
}))

vi.mock('@/features/auth/useSession', () => ({
  useSession: () => ({ user: { id: 1, role: 'MANAGER' } }),
}))

function product(over: Partial<Product> = {}): Product {
  return {
    id: 1,
    name: 'Test Item',
    item_type: 'PRODUCT',
    department: 'CAFE',
    category_id: 1,
    category_name: 'عام',
    price_minor: 1000,
    is_active: true,
    track_inventory: false,
    stock_quantity: 0,
    is_seed: false,
    ...over,
  }
}

function page() {
  return render(
    <ToastProvider>
      <CatalogPage />
    </ToastProvider>,
  )
}

describe('CatalogPage category and stock UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.list.mockResolvedValue([product()])
    mocks.listCategories.mockResolvedValue([{ id: 1, name: 'عام' }])
    mocks.create.mockResolvedValue(2)
  })

  it('renders category and non-stock state on a card', async () => {
    page()
    await screen.findByText('Test Item')
    expect(screen.getByText('عام')).toBeInTheDocument()
    expect(screen.getByText('غير مخزّن')).toBeInTheDocument()
  })

  it('renders current stock for a stock-managed card', async () => {
    mocks.list.mockResolvedValue([product({ track_inventory: true, stock_quantity: 5 })])
    page()
    await screen.findByText('Test Item')
    expect(screen.getByText(/المخزون الحالي/)).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
  })

  it('requires a category and only reveals stock quantity when tracking is on', async () => {
    page()
    await screen.findByText('Test Item')
    fireEvent.click(screen.getByRole('button', { name: 'صنف جديد' }))

    const dialog = screen.getByRole('dialog', { name: 'صنف جديد' })
    const textboxes = within(dialog).getAllByRole('textbox')
    fireEvent.change(textboxes[0], { target: { value: 'New Item' } })
    fireEvent.change(textboxes[1], { target: { value: '10' } })

    expect(screen.queryByText('الرصيد الافتتاحي عند تفعيل تتبع المخزون')).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }))
    expect(await screen.findByText('التصنيف مطلوب')).toBeInTheDocument()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('submits the selected category and opening stock quantity', async () => {
    page()
    await screen.findByText('Test Item')
    fireEvent.click(screen.getByRole('button', { name: 'صنف جديد' }))

    const dialog = screen.getByRole('dialog', { name: 'صنف جديد' })
    const textboxes = within(dialog).getAllByRole('textbox')
    fireEvent.change(textboxes[0], { target: { value: 'New Item' } })
    fireEvent.change(textboxes[1], { target: { value: '10' } })

    await screen.findByRole('option', { name: 'عام' })
    const comboboxes = within(dialog).getAllByRole('combobox')
    fireEvent.change(comboboxes[2], { target: { value: '1' } })

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'تتبع المخزون لهذا الصنف' }))
    const stockInput = within(dialog).getAllByRole('textbox')[2]
    fireEvent.change(stockInput, { target: { value: '3' } })

    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }))
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          category_id: 1,
          track_inventory: true,
          stock_quantity: 3,
        }),
      ),
    )
  })
})
