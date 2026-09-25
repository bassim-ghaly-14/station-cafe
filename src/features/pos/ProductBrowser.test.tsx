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

function renderBrowser(onAdd = vi.fn()) {
  render(<ProductBrowser products={CATALOG} qty={1} onQtyChange={vi.fn()} onAdd={onAdd} />)

  return onAdd
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
})
