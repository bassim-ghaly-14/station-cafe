import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import '@/lib/i18n'
import { CreateProductDialog, EditProductDialog } from './CatalogProductDialogs'
import type { Product } from '@/services/posApi'

// ---------------------------------------------------------------------------
// Mocks — quantity AND minimum travel atomically INSIDE the catalog
// create/update payload (no second `setStockMinimum` round-trip, so no
// partial-failure window between product creation and threshold persistence).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  role: 'MANAGER' as const,
}))

vi.mock('@/services/catalogApi', () => ({
  catalogApi: {
    list: vi.fn(),
    listCategories: vi.fn(),
    createCategory: vi.fn(),
    updateCategory: vi.fn(),
    removeCategory: vi.fn(),
    create: mocks.create,
    update: mocks.update,
    rename: vi.fn(),
    setPrice: vi.fn(),
    setActive: vi.fn(),
    remove: vi.fn(),
  },
}))

vi.mock('@/features/auth/useSession', () => ({
  useSession: () => ({ user: { id: 1, role: mocks.role } }),
}))

function category(id = 1) {
  return { id, name: 'عام' }
}

function product(over: Partial<Product> = {}): Product {
  return {
    id: 1,
    name: 'حليب',
    item_type: 'PRODUCT',
    department: 'CAFE',
    category_id: 1,
    category_name: 'مشروبات',
    price_minor: 1000,
    is_active: true,
    track_inventory: true,
    stock_quantity: 20,
    min_quantity: 5,
    is_seed: false,
    is_new: false,
    has_recipe: false,
    ...over,
  }
}

function fillRequiredNameAndCategory(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByLabelText('الاسم'), {
    target: { value: 'حليب' },
  })
  fireEvent.change(within(dialog).getByLabelText('السعر'), {
    target: { value: '10' },
  })
  fireEvent.change(within(dialog).getByLabelText('التصنيف'), {
    target: { value: '1' },
  })
}

async function saveDialog() {
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /حفظ/ })).toBeEnabled()
  })
  fireEvent.click(screen.getByRole('button', { name: /حفظ/ }))
}

describe('CreateProductDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.create.mockResolvedValue(1)
  })

  it('exposes current quantity and minimum stock as two independent fields once tracked', () => {
    render(
      <ToastProvider>
        <CreateProductDialog categories={[category()]} onClose={vi.fn()} onCreated={vi.fn()} />
      </ToastProvider>,
    )

    // The numeric fields only render once the item is tracked.
    const dialog = screen.getByRole('dialog', { name: 'صنف جديد' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'تتبع المخزون لهذا الصنف' }))

    expect(within(dialog).getByLabelText('الكمية الحالية')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('الحد الأدنى للمخزون')).toBeInTheDocument()
  })

  it('persists quantity and minimum stock independently on create', async () => {
    render(
      <ToastProvider>
        <CreateProductDialog categories={[category()]} onClose={vi.fn()} onCreated={vi.fn()} />
      </ToastProvider>,
    )

    const dialog = screen.getByRole('dialog', { name: 'صنف جديد' })
    fillRequiredNameAndCategory(dialog)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'تتبع المخزون لهذا الصنف' }))
    fireEvent.change(within(dialog).getByLabelText('الكمية الحالية'), {
      target: { value: '20' },
    })
    fireEvent.change(within(dialog).getByLabelText('الحد الأدنى للمخزون'), {
      target: { value: '5' },
    })
    await saveDialog()

    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'حليب',
        item_type: 'PRODUCT',
        department: 'CAFE',
        category_id: 1,
        price_minor: 1000,
        track_inventory: true,
        stock_quantity: 20,
        min_quantity: 5,
        is_new: true,
      }),
    )
    // Atomic: minimum travels INSIDE the create payload — no second call.
  })

  it('keeps numeric fields hidden while tracking is not enabled', () => {
    render(
      <ToastProvider>
        <CreateProductDialog categories={[category()]} onClose={vi.fn()} onCreated={vi.fn()} />
      </ToastProvider>,
    )

    // Tracking is OFF by default: both numeric fields stay hidden.
    const dialog = screen.getByRole('dialog', { name: 'صنف جديد' })
    expect(within(dialog).queryByLabelText('الحد الأدنى للمخزون')).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('الكمية الحالية')).not.toBeInTheDocument()
  })
})

describe('EditProductDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.update.mockResolvedValue(undefined)
  })

  it('loads both persisted values independently', () => {
    render(
      <ToastProvider>
        <EditProductDialog
          product={product()}
          categories={[category()]}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      </ToastProvider>,
    )

    const dialog = screen.getByRole('dialog', { name: 'تعديل' })
    expect(within(dialog).getByLabelText('الكمية الحالية')).toHaveValue('20')
    expect(within(dialog).getByLabelText('الحد الأدنى للمخزون')).toHaveValue('5')
  })

  it('only updates quantity when quantity changes, leaving minimum stock untouched', async () => {
    render(
      <ToastProvider>
        <EditProductDialog
          product={product()}
          categories={[category()]}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      </ToastProvider>,
    )

    const dialog = screen.getByRole('dialog', { name: 'تعديل' })
    fireEvent.change(within(dialog).getByLabelText('الكمية الحالية'), {
      target: { value: '30' },
    })
    await saveDialog()

    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        stock_quantity: 30,
        min_quantity: 5,
      }),
    )
    // Atomic: minimum travels INSIDE the update payload — no second call,
    // and quantity is preserved alongside it.
  })

  it('only updates minimum stock when minimum stock changes, leaving quantity untouched', async () => {
    render(
      <ToastProvider>
        <EditProductDialog
          product={product()}
          categories={[category()]}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      </ToastProvider>,
    )

    // Go back to the original quantity so the next edit starts from a known state.
    const dialog = screen.getByRole('dialog', { name: 'تعديل' })
    fireEvent.change(within(dialog).getByLabelText('الكمية الحالية'), {
      target: { value: '20' },
    })
    fireEvent.change(within(dialog).getByLabelText('الحد الأدنى للمخزون'), {
      target: { value: '7' },
    })
    await saveDialog()

    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ stock_quantity: 20, min_quantity: 7 }),
    )
  })

  it('updates quantity and minimum stock independently when both change', async () => {
    render(
      <ToastProvider>
        <EditProductDialog
          product={product()}
          categories={[category()]}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      </ToastProvider>,
    )

    const dialog = screen.getByRole('dialog', { name: 'تعديل' })
    fireEvent.change(within(dialog).getByLabelText('الكمية الحالية'), {
      target: { value: '40' },
    })
    fireEvent.change(within(dialog).getByLabelText('الحد الأدنى للمخزون'), {
      target: { value: '8' },
    })
    await saveDialog()

    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        stock_quantity: 40,
        min_quantity: 8,
      }),
    )
  })

  it('rejects an invalid current quantity before saving', () => {
    render(
      <ToastProvider>
        <CreateProductDialog categories={[category()]} onClose={vi.fn()} onCreated={vi.fn()} />
      </ToastProvider>,
    )

    // The numeric fields only render once tracked.
    const dialog = screen.getByRole('dialog', { name: 'صنف جديد' })
    fillRequiredNameAndCategory(dialog)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'تتبع المخزون لهذا الصنف' }))

    fireEvent.change(within(dialog).getByLabelText('الكمية الحالية'), {
      target: { value: '-5' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }))

    expect(within(dialog).getByText('أدخل كمية مخزون صحيحة')).toBeInTheDocument()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('rejects an invalid minimum stock before saving', () => {
    render(
      <ToastProvider>
        <CreateProductDialog categories={[category()]} onClose={vi.fn()} onCreated={vi.fn()} />
      </ToastProvider>,
    )

    // The numeric fields only render once tracked.
    const dialog = screen.getByRole('dialog', { name: 'صنف جديد' })
    fillRequiredNameAndCategory(dialog)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'تتبع المخزون لهذا الصنف' }))

    fireEvent.change(within(dialog).getByLabelText('الكمية الحالية'), {
      target: { value: '20' },
    })
    fireEvent.change(within(dialog).getByLabelText('الحد الأدنى للمخزون'), {
      target: { value: '-3' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }))

    expect(within(dialog).getByText('الحد الأدنى غير صحيح')).toBeInTheDocument()
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
