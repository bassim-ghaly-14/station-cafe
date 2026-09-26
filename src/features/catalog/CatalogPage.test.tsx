import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import '@/lib/i18n'
import CatalogPage from './CatalogPage'
import type { Product } from '@/services/posApi'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listCategories: vi.fn(),
  createCategory: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  setActive: vi.fn(),
}))

vi.mock('@/services/catalogApi', () => ({
  catalogApi: {
    list: mocks.list,
    listCategories: mocks.listCategories,
    createCategory: mocks.createCategory,
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
    is_new: false,
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
    mocks.createCategory.mockReset().mockResolvedValue(2)
    mocks.create.mockResolvedValue(2)
  })

  it('renders category and non-stock state on a card', async () => {
    page()
    await screen.findByText('Test Item')
    // Scoped to the card: the category NAME also appears in the navigation
    // strip, which is the point of the new category filter.
    const card = screen.getByTestId('catalog-card')
    expect(within(card).getByTestId('catalog-category-badge')).toHaveTextContent('عام')
    expect(within(card).getByText('غير مخزّن')).toBeInTheDocument()
  })

  it('renders current stock for a stock-managed card', async () => {
    mocks.list.mockResolvedValue([product({ track_inventory: true, stock_quantity: 5 })])
    page()
    await screen.findByText('Test Item')
    expect(screen.getByText(/المخزون الحالي/)).toHaveTextContent('المخزون الحالي: 5')
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

  it('creates a category and refreshes it for product forms', async () => {
    mocks.createCategory.mockResolvedValue(2)
    mocks.listCategories.mockResolvedValueOnce([{ id: 1, name: 'عام' }]).mockResolvedValue([
      { id: 1, name: 'عام' },
      { id: 2, name: 'مشروبات' },
    ])
    page()
    await screen.findByText('Test Item')
    fireEvent.click(screen.getByRole('button', { name: 'إضافة تصنيف جديد' }))
    const dialog = screen.getByRole('dialog', { name: 'إضافة تصنيف جديد' })
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'مشروبات' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }))
    await waitFor(() => expect(mocks.createCategory).toHaveBeenCalledWith('مشروبات'))
    fireEvent.click(screen.getByRole('button', { name: 'صنف جديد' }))
    expect(await screen.findByRole('option', { name: 'مشروبات' })).toBeInTheDocument()
  })

  it('rejects empty and duplicate categories before invoking the backend', async () => {
    page()
    await screen.findByText('Test Item')
    fireEvent.click(screen.getByRole('button', { name: 'إضافة تصنيف جديد' }))
    const dialog = screen.getByRole('dialog', { name: 'إضافة تصنيف جديد' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }))
    expect(await within(dialog).findByText('اسم التصنيف مطلوب')).toBeInTheDocument()
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'عام' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }))
    expect(await within(dialog).findByText('التصنيف موجود بالفعل')).toBeInTheDocument()
    expect(mocks.createCategory).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }))
    expect(screen.queryByRole('dialog', { name: 'إضافة تصنيف جديد' })).not.toBeInTheDocument()
  })

  /* ========================================================================== */
  /* Badges and hierarchy                                                      */
  /* ========================================================================== */

  describe('CatalogPage badges', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      mocks.listCategories.mockReset().mockResolvedValue([{ id: 1, name: 'عام' }])
      mocks.create.mockReset().mockResolvedValue(2)
      mocks.update.mockReset().mockResolvedValue(undefined)
      mocks.setActive.mockReset().mockResolvedValue(undefined)
    })

    it('uses the success identity for an available item', async () => {
      mocks.list.mockResolvedValue([product()])
      page()
      const badge = await screen.findByTestId('catalog-status-badge')
      expect(badge).toHaveTextContent('متاح')
      expect(badge.className).toContain('bg-badge-success-bg')
    })

    it('uses a RED danger identity — never neutral gray — for a disabled item', async () => {
      mocks.list.mockResolvedValue([product({ is_active: false })])
      page()
      const badge = await screen.findByTestId('catalog-status-badge')
      expect(badge).toHaveTextContent('موقوف')
      expect(badge.className).toContain('bg-badge-danger-bg')
      expect(badge.className).not.toContain('badge-neutral')
    })

    it('keeps new distinct from availability in every combination', async () => {
      mocks.list.mockResolvedValue([
        product({ id: 1, name: 'A', is_new: true, is_active: true }),
        product({ id: 2, name: 'B', is_new: true, is_active: false }),
        product({ id: 3, name: 'C', is_new: false, is_active: true }),
      ])
      page()
      await screen.findByText('A')

      const cards = screen.getAllByTestId('catalog-card')
      expect(cards[0].querySelectorAll('[data-testid="catalog-new-badge"]')).toHaveLength(1)
      // New + disabled is a valid, distinct state: badged as new, red as disabled.
      expect(cards[1].querySelectorAll('[data-testid="catalog-new-badge"]')).toHaveLength(1)
      expect(within(cards[1]).getByTestId('catalog-status-badge').className).toContain(
        'bg-badge-danger-bg',
      )
      expect(cards[2].querySelectorAll('[data-testid="catalog-new-badge"]')).toHaveLength(0)
    })

    it('gives each category a distinct tone from the centralized palette', async () => {
      mocks.list.mockResolvedValue([
        product({ id: 1, name: 'drinks item', category_id: 1, category_name: 'drinks' }),
        product({ id: 2, name: 'food item', category_id: 2, category_name: 'food' }),
      ])
      page()
      await screen.findByText('drinks item')

      const tones = screen
        .getAllByTestId('catalog-category-badge')
        .map((node) => Number(node.getAttribute('data-category-tone')))
      expect(new Set(tones).size).toBe(tones.length)
      for (const tone of tones) {
        expect(tone).toBeGreaterThanOrEqual(1)
        expect(tone).toBeLessThanOrEqual(6)
      }
    })

    it('renders the price as a hero element in the same position on every card', async () => {
      mocks.list.mockResolvedValue([
        product({ id: 1, name: 'first', price_minor: 5_000 }),
        product({ id: 2, name: 'second', price_minor: 1_250 }),
      ])
      page()
      await screen.findByText('first')

      const prices = screen.getAllByTestId('catalog-card-price')
      expect(prices).toHaveLength(2)
      // Theme tokens, not raw colors, and rendered at hero scale.
      expect(prices[0].textContent).toMatch(/50/)

      expect(prices[1].textContent).toMatch(/12\.5/)
      for (const price of prices) {
        expect(price.querySelector('span')?.className).toContain('text-3xl')
        expect(price.querySelector('span')?.className).toContain('text-foreground-strong')
      }
    })
  })

  describe('CatalogPage category navigation', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      mocks.create.mockReset().mockResolvedValue(2)
      mocks.update.mockReset().mockResolvedValue(undefined)
      mocks.setActive.mockReset().mockResolvedValue(undefined)
      mocks.listCategories.mockReset().mockResolvedValue([
        { id: 1, name: 'مشروبات' },
        { id: 2, name: 'أطعمة' },
      ])
    })

    function twoCategories() {
      mocks.list.mockResolvedValue([
        product({ id: 1, name: 'قهوة', category_id: 1, category_name: 'مشروبات' }),
        product({ id: 2, name: 'كرواسون', category_id: 2, category_name: 'أطعمة' }),
      ])
    }

    it('lists the real categories from the data plus an all option', async () => {
      twoCategories()
      page()
      const nav = await screen.findByTestId('catalog-category-nav')
      expect(within(nav).getByRole('button', { name: /كل التصنيفات/ })).toBeInTheDocument()
      expect(within(nav).getByRole('button', { name: /مشروبات/ })).toBeInTheDocument()
      expect(within(nav).getByRole('button', { name: /أطعمة/ })).toBeInTheDocument()
    })

    it('filters the grid to the selected category and back to all', async () => {
      twoCategories()
      page()
      const nav = await screen.findByTestId('catalog-category-nav')

      fireEvent.click(within(nav).getByRole('button', { name: /مشروبات/ }))
      expect(screen.getByText('قهوة')).toBeInTheDocument()
      expect(screen.queryByText('كرواسون')).not.toBeInTheDocument()

      fireEvent.click(within(nav).getByRole('button', { name: /كل التصنيفات/ }))
      expect(screen.getByText('قهوة')).toBeInTheDocument()
      expect(screen.getByText('كرواسون')).toBeInTheDocument()
    })

    it('combines the category filter with search', async () => {
      mocks.list.mockResolvedValue([
        product({ id: 1, name: 'قهوة تركي', category_id: 1, category_name: 'مشروبات' }),
        product({ id: 2, name: 'قهوة فرنسي', category_id: 1, category_name: 'مشروبات' }),
        product({ id: 3, name: 'كرواسون', category_id: 2, category_name: 'أطعمة' }),
      ])
      page()
      const nav = await screen.findByTestId('catalog-category-nav')
      fireEvent.click(within(nav).getByRole('button', { name: /مشروبات/ }))
      fireEvent.change(screen.getByLabelText('ابحث باسم الصنف…'), { target: { value: 'تركي' } })

      expect(screen.getByText('قهوة تركي')).toBeInTheDocument()
      expect(screen.queryByText('قهوة فرنسي')).not.toBeInTheDocument()
      expect(screen.queryByText('كرواسون')).not.toBeInTheDocument()
    })

    it('resets search and category together with one clear action', async () => {
      twoCategories()
      page()
      const nav = await screen.findByTestId('catalog-category-nav')
      fireEvent.click(within(nav).getByRole('button', { name: /مشروبات/ }))
      fireEvent.change(screen.getByLabelText('ابحث باسم الصنف…'), { target: { value: 'قهوة' } })
      expect(screen.queryByText('كرواسون')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'مسح عوامل التصفية' }))
      expect(screen.getByLabelText('ابحث باسم الصنف…')).toHaveValue('')
      expect(screen.getByText('كرواسون')).toBeInTheDocument()
    })

    it('marks the active chip for assistive tech, not by color alone', async () => {
      twoCategories()
      page()
      const nav = await screen.findByTestId('catalog-category-nav')
      fireEvent.click(within(nav).getByRole('button', { name: /مشروبات/ }))

      expect(within(nav).getByRole('button', { name: /مشروبات/ })).toHaveAttribute(
        'aria-current',
        'true',
      )
      expect(within(nav).getByRole('button', { name: /كل التصنيفات/ })).not.toHaveAttribute(
        'aria-current',
      )
    })

    it('exposes categories as keyboard-reachable buttons with a focus ring', async () => {
      twoCategories()
      page()
      const nav = await screen.findByTestId('catalog-category-nav')
      const all = within(nav).getByRole('button', { name: /كل التصنيفات/ })

      all.focus()
      expect(all).toHaveFocus()
      // The focus indicator is never removed.
      expect(all.className).toContain('focus-visible:outline-focus')
    })

    it('shows a no-results state with a reset when the search matches nothing', async () => {
      twoCategories()
      page()
      fireEvent.change(await screen.findByLabelText('ابحث باسم الصنف…'), {
        target: { value: 'لا يوجد' },
      })
      expect(screen.getByText('لا توجد أصناف مطابقة')).toBeInTheDocument()
      // A reset is offered both in the filter bar and in the empty state.
      expect(screen.getAllByRole('button', { name: 'مسح عوامل التصفية' }).length).toBeGreaterThan(0)
    })
  })

  /* ========================================================================== */
  /* The "new item" field and the activation action                            */
  /* ========================================================================== */

  describe('CatalogPage new item field', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      mocks.list.mockResolvedValue([product()])
      mocks.listCategories.mockReset().mockResolvedValue([{ id: 1, name: 'عام' }])
      mocks.create.mockReset().mockResolvedValue(2)
      mocks.update.mockReset().mockResolvedValue(undefined)
      mocks.setActive.mockReset().mockResolvedValue(undefined)
    })

    const NEW_LABEL = 'صنف جديد في القائمة'

    it('offers an accessible switch in the Add dialog, defaulting to new', async () => {
      page()
      await screen.findByText('Test Item')
      fireEvent.click(screen.getByRole('button', { name: 'صنف جديد' }))
      const dialog = screen.getByRole('dialog', { name: 'صنف جديد' })

      // A real switch with an accessible Arabic name, announcing its state.
      const toggle = within(dialog).getByRole('switch', { name: NEW_LABEL })
      expect(toggle).toHaveAttribute('aria-checked', 'true')
    })

    it('persists the Add-dialog value through the API', async () => {
      page()
      await screen.findByText('Test Item')
      fireEvent.click(screen.getByRole('button', { name: 'صنف جديد' }))
      const dialog = screen.getByRole('dialog', { name: 'صنف جديد' })

      const textboxes = within(dialog).getAllByRole('textbox')
      fireEvent.change(textboxes[0], { target: { value: 'New Item' } })
      fireEvent.change(textboxes[1], { target: { value: '10' } })
      // Combobox order: department, type, category.
      fireEvent.change(within(dialog).getAllByRole('combobox')[2], { target: { value: '1' } })

      // Turn "new" OFF and confirm OFF is what reaches the backend.
      fireEvent.click(within(dialog).getByRole('switch', { name: NEW_LABEL }))
      expect(within(dialog).getByRole('switch', { name: NEW_LABEL })).toHaveAttribute(
        'aria-checked',
        'false',
      )
      fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }))

      await waitFor(() =>
        expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ is_new: false })),
      )
    })

    it('loads the persisted value into the Edit dialog and saves a change', async () => {
      mocks.list.mockResolvedValue([product({ is_new: true })])
      page()
      await screen.findByText('Test Item')
      fireEvent.click(screen.getAllByRole('button', { name: 'تعديل' })[0])
      const dialog = screen.getByRole('dialog', { name: 'تعديل' })
      const toggle = within(dialog).getByRole('switch', { name: NEW_LABEL })

      // Initial value comes from the loaded product, not from a local default.
      expect(toggle).toHaveAttribute('aria-checked', 'true')
      fireEvent.click(toggle)
      fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }))

      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith(1, expect.objectContaining({ is_new: false })),
      )
    })
  })

  describe('CatalogPage activation action', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      mocks.listCategories.mockReset().mockResolvedValue([{ id: 1, name: 'عام' }])
      mocks.setActive.mockReset().mockResolvedValue(undefined)
    })

    it('offers a green activate action for a disabled item', async () => {
      mocks.list.mockResolvedValue([product({ is_active: false })])
      page()
      const activate = await screen.findByRole('button', { name: 'تنشيط' })

      // Success identity, so "disabled = red" pairs with "activate = green".
      expect(activate.className).toContain('bg-success-solid')
      fireEvent.click(activate)

      // Activation is confirmed before it reaches the backend.
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'تأكيد تغيير الحالة' })).getByRole('button', {
          name: 'تأكيد',
        }),
      )
      await waitFor(() => expect(mocks.setActive).toHaveBeenCalledWith(1, true))
    })

    it('confirms before deactivating an active item', async () => {
      mocks.list.mockResolvedValue([product({ is_active: true })])
      page()
      fireEvent.click(await screen.findByRole('button', { name: 'إيقاف' }))
      expect(mocks.setActive).not.toHaveBeenCalled()

      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'تأكيد تغيير الحالة' })).getByRole('button', {
          name: 'تأكيد',
        }),
      )
      await waitFor(() => expect(mocks.setActive).toHaveBeenCalledWith(1, false))
    })
  })

  it('renders the new badge for a new item', async () => {
    mocks.list.mockResolvedValue([product({ is_new: true })])
    page()
    expect(await screen.findByTestId('catalog-new-badge')).toHaveTextContent('جديد')
  })

  it('omits the new badge for an existing item', async () => {
    mocks.list.mockResolvedValue([product({ is_new: false })])
    page()
    await screen.findByTestId('catalog-card')
    expect(screen.queryByTestId('catalog-new-badge')).not.toBeInTheDocument()
  })
})
