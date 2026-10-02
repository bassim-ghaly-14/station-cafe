/**
 * Hierarchical product discovery: القسم → التصنيف → الصنف.
 *
 * The assertions are about REACHABILITY and REAL data, not pixels: a product
 * must be addable in three intentional taps, and no search box may exist.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/lib/i18n'
import { ProductBrowser } from './ProductBrowser'
import type { Product } from '@/services/posApi'

function product(over: Partial<Product>): Product {
  return {
    id: 1,
    name: 'صنف',
    item_type: 'PRODUCT',
    department: 'CAFE',
    category_id: 1,
    category_name: 'تصنيف',
    price_minor: 1000,
    is_active: true,
    track_inventory: false,
    stock_quantity: 0,
    is_seed: true,
    is_new: false,
    ...over,
  }
}

const CATALOG: Product[] = [
  product({ id: 1, name: 'شاي كلاسيك', category_id: 10, category_name: 'مشروبات ساخنة' }),
  product({ id: 2, name: 'كابتشينو', category_id: 10, category_name: 'مشروبات ساخنة' }),
  product({ id: 3, name: 'كرواسون رومي', category_id: 20, category_name: 'الإفطار' }),
  product({
    id: 4,
    name: 'غسيل كامل',
    item_type: 'SERVICE',
    department: 'WASH',
    category_id: 30,
    category_name: 'خدمات غسيل السيارات',
  }),
]

function renderBrowser(onAdd = vi.fn(), catalog: Product[] = CATALOG) {
  render(<ProductBrowser products={catalog} qty={1} onQtyChange={vi.fn()} onAdd={onAdd} />)

  return onAdd
}

/** Renders a browser over a single-category catalog, for one-product assertions. */
function renderBrowserWith(catalog: Product[]) {
  return renderBrowser(vi.fn(), catalog)
}

describe('ProductBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('offers the two business sections first and no product search', () => {
    renderBrowser()

    expect(screen.getByRole('button', { name: /كافيه/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /مغسلة/ })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    // Items are NOT listed before a section is chosen.
    expect(screen.queryByText('شاي كلاسيك')).not.toBeInTheDocument()
  })

  it('reaches a product in three taps: section → category → product', () => {
    const onAdd = renderBrowser()

    fireEvent.click(screen.getByRole('button', { name: /كافيه/ }))

    // Real catalog categories, straight from the product rows.
    expect(screen.getByRole('button', { name: /مشروبات ساخنة/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /الإفطار/ })).toBeInTheDocument()
    expect(screen.queryByText('شاي كلاسيك')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /مشروبات ساخنة/ }))
    fireEvent.click(screen.getByRole('button', { name: /شاي كلاسيك/ }))

    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 1, name: 'شاي كلاسيك' }))
  })

  it('follows the same path for a wash service', () => {
    const onAdd = renderBrowser()

    fireEvent.click(screen.getByRole('button', { name: /مغسلة/ }))
    fireEvent.click(screen.getByRole('button', { name: /خدمات غسيل السيارات/ }))
    fireEvent.click(screen.getByRole('button', { name: /غسيل كامل/ }))

    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 4, item_type: 'SERVICE' }))
  })

  it('goes back through the breadcrumb instead of resetting silently', () => {
    renderBrowser()

    fireEvent.click(screen.getByRole('button', { name: /كافيه/ }))
    fireEvent.click(screen.getByRole('button', { name: /الإفطار/ }))
    expect(screen.getByText('كرواسون رومي')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'كافيه' }))

    expect(screen.getByRole('button', { name: /مشروبات ساخنة/ })).toBeInTheDocument()
    expect(screen.queryByText('كرواسون رومي')).not.toBeInTheDocument()
  })

  it('shows an explicit empty state for a section without categories', () => {
    render(<ProductBrowser products={[]} qty={1} onQtyChange={vi.fn()} onAdd={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /مغسلة/ }))

    expect(screen.getByText('لا توجد تصنيفات في هذا القسم')).toBeInTheDocument()
  })

  it('never truncates a product name — it wraps, and the full name stays reachable', () => {
    const longName = 'منتج قهوة بالحليب والكراميل المكسو بالفوكا وطبقة额外 من الشوكولاتة الداكنة'
    const onAdd = renderBrowserWith([
      product({ id: 9, name: longName, category_id: 10, category_name: 'مشروبات ساخنة' }),
    ])

    fireEvent.click(screen.getByRole('button', { name: /كافيه/ }))
    fireEvent.click(screen.getByRole('button', { name: /مشروبات ساخنة/ }))

    const tile = screen.getByTestId('pos-product-9')

    // The whole name is in the accessible tree and in the text — nothing is cut.
    expect(tile).toHaveTextContent(longName)
    expect(tile).toHaveAttribute('title', longName)
    // It WRAPS over up to three reserved lines rather than a one-line truncate:
    // a hard `truncate` is what made an orderable name unreadable.
    expect(tile.querySelector('.line-clamp-3')).not.toBeNull()
    expect(tile.className).not.toContain('truncate')

    fireEvent.click(tile)
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }))
  })

  it('gives a category and its products ONE colour, from the shared catalog tone', () => {
    renderBrowser()

    fireEvent.click(screen.getByRole('button', { name: /كافيه/ }))

    const category = screen.getByTestId('pos-category-10')
    fireEvent.click(category)

    const productTile = screen.getByTestId('pos-product-1')

    // The same deterministic slot on both levels, and the real Station tokens —
    // not an ad-hoc palette invented for the POS.
    expect(productTile).toHaveAttribute('data-category-tone', category.dataset.categoryTone)
    expect(productTile.className).toMatch(/bg-category-\d-bg/)
    expect(productTile.className).toMatch(/border-category-\d-border/)
    expect(category.className).toMatch(/bg-category-\d-bg/)
  })

  it('keeps the catalog NEW treatment on a new product', () => {
    renderBrowserWith([
      product({
        id: 7,
        name: 'صنف جديد',
        category_id: 10,
        category_name: 'مشروبات ساخنة',
        is_new: true,
      }),
    ])

    fireEvent.click(screen.getByRole('button', { name: /كافيه/ }))
    fireEvent.click(screen.getByRole('button', { name: /مشروبات ساخنة/ }))

    const tile = screen.getByTestId('pos-product-7')

    // The SAME treatment the Catalog card uses — one definition, shared tokens —
    // so a new item is recognisable identically on both screens.
    expect(tile).toHaveAttribute('data-new', 'true')
    expect(screen.getByTestId('catalog-card-new')).toBeInTheDocument()
    expect(tile.className).toContain('bg-new-soft')
    expect(tile.className).toContain('border-new-border')

    // Stated exactly once, by the shared ribbon, and never overwhelming the name.
    expect(screen.getAllByTestId('catalog-new-badge')).toHaveLength(1)
  })

  it('keeps a NON-new product free of any new treatment', () => {
    renderBrowser()

    fireEvent.click(screen.getByRole('button', { name: /كافيه/ }))
    fireEvent.click(screen.getByRole('button', { name: /مشروبات ساخنة/ }))

    const tile = screen.getByTestId('pos-product-1')

    expect(tile).not.toHaveAttribute('data-new')
    expect(screen.queryByTestId('catalog-new-badge')).not.toBeInTheDocument()
    expect(tile.className).not.toContain('bg-new-soft')
  })

  it('sizes the product grid by available width, not a hardcoded column count', () => {
    renderBrowser()

    fireEvent.click(screen.getByRole('button', { name: /كافيه/ }))
    fireEvent.click(screen.getByRole('button', { name: /مشروبات ساخنة/ }))

    const grid = screen.getByTestId('pos-product-1').parentElement as HTMLElement

    // An auto-fill track adapts as the workspace widens; a fixed `grid-cols-N`
    // is what left the pad cramped in a 460px column.
    expect(grid.className).toContain('auto-fill')
    expect(grid.className).toMatch(/minmax\(\s*11rem/)
    expect(grid.className).not.toMatch(/(^|\s)grid-cols-\d/)
  })
})
