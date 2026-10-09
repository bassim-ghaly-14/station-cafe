import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import {
  CATEGORY_VISIBILITY_STORAGE_KEY,
  DEFAULT_VISIBLE_LIMIT,
  getCategoryVisibility,
  reloadCategoryVisibility,
  setVisibleCategoryIds,
} from '@/lib/category-visibility'
import '@/lib/i18n'
import CatalogPage from './CatalogPage'
import type { Product } from '@/services/posApi'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listCategories: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  removeCategory: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  setActive: vi.fn(),
  remove: vi.fn(),
  /** Mutable so a test can render the page as a different role. */
  role: 'MANAGER',
}))

vi.mock('@/services/catalogApi', () => ({
  catalogApi: {
    list: mocks.list,
    listCategories: mocks.listCategories,
    createCategory: mocks.createCategory,
    updateCategory: mocks.updateCategory,
    removeCategory: mocks.removeCategory,
    create: mocks.create,
    update: mocks.update,
    setActive: mocks.setActive,
    remove: mocks.remove,
    rename: vi.fn(),
    setPrice: vi.fn(),
  },
}))

vi.mock('@/features/auth/useSession', () => ({
  useSession: () => ({ user: { id: 1, role: mocks.role } }),
}))

const recipeMocks = vi.hoisted(() => ({
  list: vi.fn(),
  getRecipe: vi.fn(),
  recipeCost: vi.fn(),
  setRecipe: vi.fn(),
}))

vi.mock('@/services/recipesApi', () => ({
  recipesApi: {
    list: recipeMocks.list,
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    purchase: vi.fn(),
    adjust: vi.fn(),
    waste: vi.fn(),
    movements: vi.fn(),
    getRecipe: recipeMocks.getRecipe,
    recipeCost: recipeMocks.recipeCost,
    setRecipe: recipeMocks.setRecipe,
  },
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
    has_recipe: false,
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
    mocks.role = 'MANAGER'
    mocks.remove.mockResolvedValue(undefined)
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
      // EXACTLY ONE "new" badge per new card — the corner one, never a second
      // copy under the price.
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

  describe('CatalogPage recipe signal and action', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      mocks.listCategories.mockReset().mockResolvedValue([{ id: 1, name: 'عام' }])
      recipeMocks.list.mockReset().mockResolvedValue([])
      recipeMocks.getRecipe.mockReset().mockResolvedValue([])
      recipeMocks.recipeCost
        .mockReset()
        .mockResolvedValue({ product_id: 1, lines: [], total_cost_minor: null })
      recipeMocks.setRecipe.mockReset().mockResolvedValue(undefined)
    })

    it('shows the recipe badge only on a tracked product that has one', async () => {
      mocks.list.mockResolvedValue([
        product({ id: 1, name: 'Espresso', track_inventory: true, has_recipe: true }),
        product({ id: 2, name: 'Plain', track_inventory: true, has_recipe: false }),
        product({ id: 3, name: 'Untracked', track_inventory: false, has_recipe: false }),
      ])
      page()
      await screen.findByText('Espresso')

      const cards = screen.getAllByTestId('catalog-card')
      expect(within(cards[0]).queryByTestId('catalog-recipe-badge')).toHaveTextContent('لديه وصفة')
      expect(within(cards[1]).queryByTestId('catalog-recipe-badge')).not.toBeInTheDocument()
      expect(within(cards[2]).queryByTestId('catalog-recipe-badge')).not.toBeInTheDocument()
    })

    it('offers the recipe action only to a manager on a tracked product', async () => {
      mocks.list.mockResolvedValue([
        product({ id: 1, name: 'Espresso', track_inventory: true, has_recipe: false }),
        product({ id: 2, name: 'Untracked', track_inventory: false, has_recipe: false }),
      ])
      page()
      await screen.findByText('Espresso')

      const cards = screen.getAllByTestId('catalog-card')
      expect(within(cards[0]).getByRole('button', { name: 'الوصفة' })).toBeInTheDocument()
      expect(within(cards[1]).queryByRole('button', { name: 'الوصفة' })).not.toBeInTheDocument()
    })

    it('hides the recipe action from STAFF entirely', async () => {
      mocks.role = 'STAFF'
      mocks.list.mockResolvedValue([
        product({ id: 1, name: 'Espresso', track_inventory: true, has_recipe: true }),
      ])
      page()
      await screen.findByText('Espresso')
      expect(screen.queryByRole('button', { name: 'الوصفة' })).not.toBeInTheDocument()
    })

    it('opens the recipe dialog and saves the edited lines', async () => {
      recipeMocks.list.mockResolvedValue([
        {
          id: 7,
          name: 'Coffee beans',
          department: 'CAFE',
          base_unit: 'GRAM',
          current_quantity: 1000,
          last_purchase_unit_cost_minor: 50,
          is_active: true,
          created_at: '2026-01-01T00:00:00',
        },
      ])
      mocks.list.mockResolvedValue([
        product({ id: 1, name: 'Espresso', track_inventory: true, has_recipe: false }),
      ])
      page()
      await screen.findByText('Espresso')
      fireEvent.click(screen.getByRole('button', { name: 'الوصفة' }))

      const dialog = await screen.findByRole('dialog', { name: /وصفة/ })
      // The empty-recipe state explains a tracked product may sell with no recipe.
      expect(within(dialog).getByText(/يمكن أن يباع بدون وصفة/)).toBeInTheDocument()

      fireEvent.click(within(dialog).getByRole('button', { name: 'إضافة مادة' }))
      const selects = within(dialog).getAllByRole('combobox')
      fireEvent.change(selects[selects.length - 1], { target: { value: '7' } })
      const qty = within(dialog).getByLabelText('الكمية للوحدة')
      fireEvent.change(qty, { target: { value: '18' } })

      fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }))
      await waitFor(() =>
        expect(recipeMocks.setRecipe).toHaveBeenCalledWith(1, [
          { raw_material_id: 7, quantity_base: 18 },
        ]),
      )
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

  it('renders exactly one new badge, in the card corner above the price', async () => {
    mocks.list.mockResolvedValue([product({ is_new: true })])
    page()
    const card = await screen.findByTestId('catalog-card')

    const badges = within(card).getAllByTestId('catalog-new-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0]).toHaveTextContent('جديد')

    // It sits ABOVE the price, never repeated underneath it: the badge row that
    // follows the price carries availability and the category, and nothing else.
    const price = within(card).getByTestId('catalog-card-price')
    const badgeRow = price.nextElementSibling
    expect(badgeRow?.querySelector('[data-testid="catalog-new-badge"]')).toBeNull()
    expect(badgeRow?.querySelector('[data-testid="catalog-category-badge"]')).not.toBeNull()
  })

  it('omits the new badge for an existing item', async () => {
    mocks.list.mockResolvedValue([product({ is_new: false })])
    page()
    await screen.findByTestId('catalog-card')
    expect(screen.queryByTestId('catalog-new-badge')).not.toBeInTheDocument()
  })

  // Deleting an item is ADMIN-only. Hiding the button is a convenience; the
  // real boundary is the backend command plus the service role check.
  describe('delete is an ADMIN-only action', () => {
    it('offers the delete action to an ADMIN', async () => {
      mocks.role = 'ADMIN'
      page()
      expect(await screen.findByTestId('catalog-card-delete')).toBeInTheDocument()
    })

    it('hides the delete action from a MANAGER', async () => {
      mocks.role = 'MANAGER'
      page()
      await screen.findByTestId('catalog-card')
      expect(screen.queryByTestId('catalog-card-delete')).not.toBeInTheDocument()
    })

    it('hides the delete action from a STAFF user', async () => {
      mocks.role = 'STAFF'
      page()
      await screen.findByTestId('catalog-card')
      expect(screen.queryByTestId('catalog-card-delete')).not.toBeInTheDocument()
      // STAFF is read-only, so it has no catalog management actions at all.
      expect(screen.queryByRole('button', { name: 'تعديل' })).not.toBeInTheDocument()
    })

    it('names the item and reassures about history before deleting', async () => {
      mocks.role = 'ADMIN'
      mocks.list.mockResolvedValue([product({ name: 'كابتشينو' })])
      page()
      fireEvent.click(await screen.findByTestId('catalog-card-delete'))

      // Nothing is deleted before the confirmation is accepted.
      expect(mocks.remove).not.toHaveBeenCalled()

      const dialog = screen.getByRole('dialog', { name: 'حذف الصنف' })
      expect(within(dialog).getByText(/كابتشينو/)).toBeInTheDocument()
      expect(
        within(dialog).getByText('لن يؤثر حذف الصنف على الفواتير أو السجلات التاريخية السابقة.'),
      ).toBeInTheDocument()

      fireEvent.click(within(dialog).getByRole('button', { name: 'حذف' }))
      await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(1))
    })

    it('cancels the confirmation without deleting', async () => {
      mocks.role = 'ADMIN'
      page()
      fireEvent.click(await screen.findByTestId('catalog-card-delete'))
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'حذف الصنف' })).getByRole('button', {
          name: 'إلغاء',
        }),
      )
      expect(mocks.remove).not.toHaveBeenCalled()
    })
  })

  /* ========================================================================== */
  /* The NEW card state                                                         */
  /* ========================================================================== */

  describe('CatalogPage new item visual state', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      mocks.listCategories.mockReset().mockResolvedValue([{ id: 1, name: 'عام' }])
      mocks.create.mockReset().mockResolvedValue(2)
      mocks.update.mockReset().mockResolvedValue(undefined)
      mocks.setActive.mockReset().mockResolvedValue(undefined)
    })

    it('gives a NEW item a card-level identity, not only a badge', async () => {
      mocks.list.mockResolvedValue([product({ is_new: true })])
      page()

      const card = await screen.findByTestId('catalog-card')
      // The state is on the card itself, so it is recognizable while scanning.
      expect(card).toHaveAttribute('data-new', 'true')
      expect(card.className).toContain('bg-new-soft')
      expect(card.className).toContain('border-new-border')
      // The accent edge on the reading (inline-start) side + the corner ribbon,
      // which is now the ONE and only "new" badge on the card.
      expect(within(card).getByTestId('catalog-new-badge')).toHaveTextContent('جديد')
      expect(card.querySelectorAll('[data-testid="catalog-new-badge"]')).toHaveLength(1)
    })

    it('leaves a normal item visually normal', async () => {
      mocks.list.mockResolvedValue([product({ is_new: false })])
      page()

      const card = await screen.findByTestId('catalog-card')
      expect(card).not.toHaveAttribute('data-new')
      expect(card.className).not.toContain('bg-new-soft')
      expect(screen.queryByTestId('catalog-new-badge')).not.toBeInTheDocument()
    })

    it('keeps the dialog صنف جديد field on the shared Switch with the NEW identity', async () => {
      mocks.role = 'MANAGER'
      mocks.list.mockResolvedValue([product()])
      page()
      fireEvent.click(await screen.findByRole('button', { name: /صنف جديد/ }))
      const dialog = await screen.findByRole('dialog')

      // Standardization is about the COMPONENT, so this is the same shared
      // Switch every other boolean uses — not a bespoke control.
      const control = within(dialog).getByRole('switch', { name: 'صنف جديد في القائمة' })
      expect(control.tagName).toBe('BUTTON')
      expect(control.className).toContain('focus-visible:outline-focus')
      // …and it keeps the intentional NEW accent, because turning it ON is what
      // paints the magenta card frame/edge/ribbon. That identity is deliberate.
      expect(control.className).toContain('bg-new-soft')
      expect(control.className).toContain('bg-new')

      // It still flips: the add dialog opens with the item marked NEW, so the
      // first press clears it and the second restores it.
      fireEvent.click(control)
      const afterFirst = within(dialog).getByRole('switch', { name: 'صنف جديد في القائمة' })
      expect(afterFirst).toHaveAttribute('aria-checked', 'false')
      expect(afterFirst.className).toContain('border-border-strong')

      fireEvent.click(afterFirst)
      expect(within(dialog).getByRole('switch', { name: 'صنف جديد في القائمة' })).toHaveAttribute(
        'aria-checked',
        'true',
      )
    })

    it('does not let the NEW treatment swallow the price, the name or the actions', async () => {
      mocks.role = 'MANAGER'
      mocks.list.mockResolvedValue([product({ is_new: true, price_minor: 5_000 })])
      page()

      const card = await screen.findByTestId('catalog-card')
      // The price stays the hero element, with its own foreground tokens.
      const price = within(card).getByTestId('catalog-card-price')
      expect(price.querySelector('span')?.className).toContain('text-foreground-strong')
      // The name and the management actions are still rendered and operable.
      expect(within(card).getByText('Test Item')).toBeInTheDocument()
      expect(within(card).getByRole('button', { name: 'تعديل' })).toBeEnabled()
      expect(within(card).getByTestId('catalog-status-badge')).toHaveTextContent('متاح')
    })

    it('places the NEW accent edge on the inline-start side, so RTL needs no override', async () => {
      mocks.list.mockResolvedValue([product({ is_new: true })])
      page()

      const edge = within(await screen.findByTestId('catalog-card')).getByTestId('catalog-card-new')
      // A logical property: it resolves to the right (reading) side in Arabic.
      expect(edge.className).toContain('inset-s-0')
      expect(edge.className).toContain('bg-new')
    })

    it('keeps availability independent of the new state on the card too', async () => {
      mocks.list.mockResolvedValue([product({ is_new: true, is_active: false })])
      page()

      const card = await screen.findByTestId('catalog-card')
      expect(card).toHaveAttribute('data-new', 'true')
      // Disabled still reads as disabled, and the item is never hidden.
      expect(within(card).getByTestId('catalog-status-badge')).toHaveTextContent('موقوف')
    })
  })

  /* ========================================================================== */
  /* Category visibility: compact bar, show all, cashier pinning                */
  /* ========================================================================== */

  describe('CatalogPage category visibility', () => {
    /** Eight categories, so the bar genuinely overflows a single compact row. */
    const MANY = Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      name: `تصنيف ${index + 1}`,
    }))

    beforeEach(() => {
      vi.clearAllMocks()
      localStorage.clear()
      // The visibility store is a module singleton, so each test starts from the
      // untouched default. `act` because a mounted page may still be subscribed.
      act(() => {
        reloadCategoryVisibility()
      })
      mocks.role = 'MANAGER'
      mocks.create.mockReset().mockResolvedValue(2)
      mocks.update.mockReset().mockResolvedValue(undefined)
      mocks.setActive.mockReset().mockResolvedValue(undefined)
      mocks.listCategories.mockReset().mockResolvedValue(MANY)
      mocks.list.mockResolvedValue(
        MANY.map((category) =>
          product({
            id: category.id,
            name: `صنف ${category.id}`,
            category_id: category.id,
            category_name: category.name,
          }),
        ),
      )
    })

    afterEach(() => {
      localStorage.clear()
      act(() => {
        reloadCategoryVisibility()
      })
    })

    /** Chip labels currently rendered in the primary bar, in order. */
    function barLabels(): string[] {
      const nav = screen.getByTestId('catalog-category-nav')
      return [...nav.querySelectorAll('button')].map((chip) => chip.textContent ?? '')
    }

    it('shows only the default primary categories, and never a horizontal scrollbar', async () => {
      page()
      const nav = await screen.findByTestId('catalog-category-nav')

      // The catalog's own order, capped: nothing is cut off and nothing scrolls.
      expect(barLabels()).toHaveLength(1 + DEFAULT_VISIBLE_LIMIT)
      expect(nav.className).toContain('flex-wrap')
      expect(nav.className).not.toContain('overflow-x-auto')
      expect(nav).toHaveAttribute('data-expanded', 'false')
    })

    it('keeps the "All" chip working in compact mode', async () => {
      page()
      const nav = await screen.findByTestId('catalog-category-nav')

      fireEvent.click(within(nav).getByRole('button', { name: /تصنيف 1/ }))
      expect(screen.queryByText('صنف 2')).not.toBeInTheDocument()

      fireEvent.click(within(nav).getByRole('button', { name: /كل التصنيفات/ }))
      expect(screen.getByText('صنف 2')).toBeInTheDocument()
      expect(within(nav).getByRole('button', { name: /كل التصنيفات/ })).toHaveAttribute(
        'aria-current',
        'true',
      )
    })

    it('reveals the hidden categories in expanded mode and collapses back', async () => {
      page()
      const nav = await screen.findByTestId('catalog-category-nav')
      expect(within(nav).queryByRole('button', { name: /تصنيف 8/ })).not.toBeInTheDocument()

      fireEvent.click(screen.getByTestId('catalog-category-expand'))
      expect(nav).toHaveAttribute('data-expanded', 'true')
      // Every category is reachable, and filtering still works from there.
      expect(within(nav).getByRole('button', { name: /تصنيف 8/ })).toBeInTheDocument()
      expect(barLabels()).toHaveLength(1 + MANY.length)

      fireEvent.click(within(nav).getByRole('button', { name: /تصنيف 8/ }))
      expect(screen.getByText('صنف 8')).toBeInTheDocument()
      expect(screen.queryByText('صنف 1')).not.toBeInTheDocument()

      fireEvent.click(screen.getByTestId('catalog-category-expand'))
      expect(nav).toHaveAttribute('data-expanded', 'false')
    })

    it('says in Arabic what the toggle does, in both directions', async () => {
      page()
      const toggle = await screen.findByTestId('catalog-category-expand')
      expect(toggle).toHaveTextContent('إظهار الكل')
      expect(toggle).toHaveAttribute('aria-expanded', 'false')

      fireEvent.click(toggle)
      expect(screen.getByTestId('catalog-category-expand')).toHaveTextContent('إخفاء التصنيفات')
      expect(screen.getByTestId('catalog-category-expand')).toHaveAttribute('aria-expanded', 'true')
    })

    it('tells the cashier how many categories are out of the bar', async () => {
      page()
      expect(await screen.findByTestId('catalog-hidden-note')).toHaveTextContent(
        String(MANY.length - DEFAULT_VISIBLE_LIMIT),
      )
    })

    it('lets the cashier pin and unpin categories from the manager drawer', async () => {
      page()
      fireEvent.click(await screen.findByTestId('catalog-category-manage'))

      const drawer = screen.getByRole('dialog', { name: 'إدارة التصنيفات' })
      // Every category is listed — hiding is never deletion.
      expect(within(drawer).getAllByTestId('catalog-category-row')).toHaveLength(MANY.length)

      // Pin a category that was not in the default bar.
      const toggle = within(drawer).getByRole('switch', { name: /إظهار تصنيف 8/ })
      fireEvent.click(toggle)
      expect(within(drawer).getByRole('switch', { name: /إظهار تصنيف 8/ })).toBeChecked()

      fireEvent.click(within(drawer).getByTestId('catalog-category-done'))
      expect(
        within(screen.getByTestId('catalog-category-nav')).getByRole('button', { name: /تصنيف 8/ }),
      ).toBeInTheDocument()
    })

    it('persists the pinned categories across a page reload', async () => {
      const first = page()
      fireEvent.click(await screen.findByTestId('catalog-category-manage'))
      const drawer = screen.getByRole('dialog', { name: 'إدارة التصنيفات' })
      fireEvent.click(within(drawer).getByRole('switch', { name: /إظهار تصنيف 8/ }))
      fireEvent.click(within(drawer).getByTestId('catalog-category-done'))

      // Simulate a restart: only what was persisted is still around.
      expect(localStorage.getItem(CATEGORY_VISIBILITY_STORAGE_KEY)).toContain('8')
      first.unmount()
      act(() => {
        reloadCategoryVisibility()
      })
      page()

      const nav = await screen.findByTestId('catalog-category-nav')
      expect(within(nav).getByRole('button', { name: /تصنيف 8/ })).toBeInTheDocument()
    })

    it('reorders the pinned categories and applies the order to the bar', async () => {
      page()
      fireEvent.click(await screen.findByTestId('catalog-category-manage'))
      const drawer = screen.getByRole('dialog', { name: 'إدارة التصنيفات' })

      fireEvent.click(within(drawer).getByRole('button', { name: 'تحريك تصنيف 2 للأعلى' }))
      expect(getCategoryVisibility().visible?.[0]).toBe(2)
      // The first row cannot move any further up.
      expect(within(drawer).getByRole('button', { name: 'تحريك تصنيف 2 للأعلى' })).toBeDisabled()
    })

    it('restores the default bar on request', async () => {
      page()
      fireEvent.click(await screen.findByTestId('catalog-category-manage'))
      const drawer = screen.getByRole('dialog', { name: 'إدارة التصنيفات' })
      fireEvent.click(within(drawer).getByRole('switch', { name: /إظهار تصنيف 8/ }))
      expect(getCategoryVisibility().visible).not.toBeNull()

      fireEvent.click(within(drawer).getByTestId('catalog-category-reset'))
      expect(getCategoryVisibility().visible).toBeNull()
      fireEvent.click(within(drawer).getByTestId('catalog-category-done'))
      expect(barLabels()).toHaveLength(1 + DEFAULT_VISIBLE_LIMIT)
    })

    it('keeps an active filter visible even when its category is not pinned', async () => {
      // Pin only the first category, so the rest of the bar is genuinely empty.
      setVisibleCategoryIds([1])
      page()
      const nav = await screen.findByTestId('catalog-category-nav')

      fireEvent.click(screen.getByTestId('catalog-category-expand'))
      fireEvent.click(within(nav).getByRole('button', { name: /تصنيف 5/ }))
      fireEvent.click(screen.getByTestId('catalog-category-expand'))

      // Collapsing must never leave a filter applied that the cashier cannot see.
      const collapsed = screen.getByTestId('catalog-category-nav')
      expect(within(collapsed).getByRole('button', { name: /تصنيف 5/ })).toHaveAttribute(
        'aria-current',
        'true',
      )
      expect(screen.getByText('صنف 5')).toBeInTheDocument()
    })

    it('keeps the category area usable in Arabic RTL', async () => {
      page()
      const nav = await screen.findByTestId('catalog-category-nav')

      // The app is RTL-first, and the bar relies on logical/wrapping layout
      // rather than physical offsets, so no direction-specific override exists.
      expect(document.documentElement.dir).toBe('rtl')
      expect(nav.className).toContain('flex-wrap')
      expect(nav.className).not.toMatch(/(^|[\s:])ml-|mr-|left-|right-/)
    })
  })

  /* ========================================================================== */
  /* Category management: rename (MANAGER) and delete (ADMIN only)            */
  /* ========================================================================== */

  describe('CatalogPage category management', () => {
    const TWO = [
      { id: 1, name: 'عام' },
      { id: 2, name: 'مشروبات' },
    ]

    beforeEach(() => {
      vi.clearAllMocks()
      localStorage.clear()
      act(() => {
        reloadCategoryVisibility()
      })
      mocks.list
        .mockReset()
        .mockResolvedValue([
          product({ id: 1, name: 'كابتشينو', category_id: 1, category_name: 'عام' }),
        ])
      mocks.listCategories.mockReset().mockResolvedValue(TWO)
      mocks.createCategory.mockReset().mockResolvedValue(3)
      mocks.updateCategory.mockReset().mockResolvedValue(undefined)
      mocks.removeCategory.mockReset().mockResolvedValue(undefined)
    })

    afterEach(() => {
      localStorage.clear()
      act(() => {
        reloadCategoryVisibility()
      })
    })

    /** Open the category manager drawer, where the row actions live. */
    async function openDrawer() {
      page()
      await screen.findByText('كابتشينو')
      fireEvent.click(await screen.findByTestId('catalog-category-manage'))
      return screen.getByRole('dialog', { name: 'إدارة التصنيفات' })
    }

    it('offers rename to a MANAGER and keeps delete away from them', async () => {
      mocks.role = 'MANAGER'
      const drawer = await openDrawer()

      expect(within(drawer).getAllByTestId('catalog-category-edit').length).toBeGreaterThan(0)
      expect(within(drawer).queryByTestId('catalog-category-delete')).not.toBeInTheDocument()
    })

    it('offers both rename and delete to an ADMIN', async () => {
      mocks.role = 'ADMIN'
      const drawer = await openDrawer()

      expect(within(drawer).getAllByTestId('catalog-category-edit').length).toBeGreaterThan(0)
      expect(within(drawer).getAllByTestId('catalog-category-delete').length).toBeGreaterThan(0)
    })

    it('offers no category action at all to a STAFF user', async () => {
      mocks.role = 'STAFF'
      const drawer = await openDrawer()

      expect(within(drawer).queryByTestId('catalog-category-edit')).not.toBeInTheDocument()
      expect(within(drawer).queryByTestId('catalog-category-delete')).not.toBeInTheDocument()
    })

    it('names the category on its action buttons for assistive tech', async () => {
      mocks.role = 'ADMIN'
      const drawer = await openDrawer()

      expect(
        within(drawer).getByRole('button', { name: 'تعديل التصنيف مشروبات' }),
      ).toBeInTheDocument()
      expect(
        within(drawer).getByRole('button', { name: 'حذف التصنيف مشروبات' }),
      ).toBeInTheDocument()
    })

    it('opens the SAME form pre-filled with the category and saves the rename', async () => {
      mocks.role = 'MANAGER'
      const drawer = await openDrawer()
      fireEvent.click(within(drawer).getByRole('button', { name: 'تعديل التصنيف مشروبات' }))

      // The shared add/rename form, retitled and carrying the current name.
      const dialog = screen.getByRole('dialog', { name: 'تعديل التصنيف' })
      const input = within(dialog).getByRole('textbox')
      expect(input).toHaveValue('مشروبات')
      expect(mocks.createCategory).not.toHaveBeenCalled()

      fireEvent.change(input, { target: { value: 'مشروبات ساخنة' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }))

      await waitFor(() => expect(mocks.updateCategory).toHaveBeenCalledWith(2, 'مشروبات ساخنة'))
      expect(mocks.createCategory).not.toHaveBeenCalled()
      // A rename changes the name every card shows, so the grid is re-read too.
      await waitFor(() => expect(mocks.listCategories).toHaveBeenCalledTimes(2))
    })

    it('rejects an empty or duplicate name before calling the backend', async () => {
      mocks.role = 'MANAGER'
      const drawer = await openDrawer()
      fireEvent.click(within(drawer).getByRole('button', { name: 'تعديل التصنيف مشروبات' }))

      const dialog = screen.getByRole('dialog', { name: 'تعديل التصنيف' })
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '  ' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }))
      expect(await within(dialog).findByText('اسم التصنيف مطلوب')).toBeInTheDocument()

      // Another category's name is still a duplicate...
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'عام' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }))
      expect(await within(dialog).findByText('التصنيف موجود بالفعل')).toBeInTheDocument()

      // ...while the category's OWN name is not: it is not a duplicate of itself.
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'مشروبات' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }))
      await waitFor(() => expect(mocks.updateCategory).toHaveBeenCalledWith(2, 'مشروبات'))
    })

    it('never offers a delete confirmation to a MANAGER', async () => {
      mocks.role = 'MANAGER'
      const drawer = await openDrawer()

      expect(within(drawer).queryByTestId('catalog-category-delete')).not.toBeInTheDocument()
      expect(screen.queryByRole('dialog', { name: 'حذف التصنيف' })).not.toBeInTheDocument()
      expect(mocks.removeCategory).not.toHaveBeenCalled()
    })

    it('names the category and the rule in the ADMIN delete confirmation', async () => {
      mocks.role = 'ADMIN'
      const drawer = await openDrawer()
      fireEvent.click(within(drawer).getByRole('button', { name: 'حذف التصنيف مشروبات' }))

      // Nothing is deleted before the confirmation is accepted.
      expect(mocks.removeCategory).not.toHaveBeenCalled()

      const dialog = screen.getByRole('dialog', { name: 'حذف التصنيف' })
      expect(within(dialog).getByText(/مشروبات/)).toBeInTheDocument()
      expect(within(dialog).getByText(/لا يمكن حذف تصنيف يحتوي على أصناف/)).toBeInTheDocument()

      fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }))
      expect(mocks.removeCategory).not.toHaveBeenCalled()
    })

    it('deletes the category on an explicit confirm and refreshes the page', async () => {
      mocks.role = 'ADMIN'
      const drawer = await openDrawer()
      fireEvent.click(within(drawer).getByRole('button', { name: 'حذف التصنيف مشروبات' }))

      const dialog = screen.getByRole('dialog', { name: 'حذف التصنيف' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'حذف' }))

      await waitFor(() => expect(mocks.removeCategory).toHaveBeenCalledWith(2))
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'حذف التصنيف' })).not.toBeInTheDocument(),
      )
      await waitFor(() => expect(mocks.listCategories).toHaveBeenCalledTimes(2))
    })

    it('surfaces the Arabic business error when the backend refuses the delete', async () => {
      mocks.role = 'ADMIN'
      mocks.removeCategory.mockRejectedValue({ message: 'catalog.category_in_use' })
      const drawer = await openDrawer()
      fireEvent.click(within(drawer).getByRole('button', { name: 'حذف التصنيف مشروبات' }))

      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'حذف التصنيف' })).getByRole('button', {
          name: 'حذف',
        }),
      )

      expect(
        await screen.findByText(
          'لا يمكن حذف التصنيف لوجود أصناف مرتبطة به. انقل الأصناف إلى تصنيف آخر أولاً.',
        ),
      ).toBeInTheDocument()
    })
  })
})
