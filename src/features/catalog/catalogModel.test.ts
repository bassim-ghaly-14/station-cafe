/**
 * The catalog's DERIVED rules, tested directly.
 *
 * These are the decisions that make the screen self-consistent — a selection
 * that points at nothing, a selection the compact bar does not show, the
 * counts behind the overview. They are pure functions precisely so they can be
 * checked here without rendering the page.
 */
import { describe, expect, it } from 'vitest'

import type { Product } from '@/services/posApi'

import {
  buildBarCategories,
  buildCategoryOptions,
  countCatalog,
  filterCatalogItems,
  hasCatalogFilters,
  resolveEffectiveCategoryId,
} from './catalogModel'

function product(over: Partial<Product> = {}): Product {
  return {
    id: 1,
    name: 'Item',
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

const NO_FILTER = { query: '', effectiveCategoryId: null, dept: '', type: '', status: '' } as const

describe('buildCategoryOptions', () => {
  it('merges the real categories with the categories present in the items', () => {
    const options = buildCategoryOptions(
      [product({ id: 1, category_id: 1, category_name: 'عام' })],
      [
        { id: 1, name: 'عام' },
        { id: 2, name: 'مشروبات' },
      ],
    )

    // The empty category is still reachable, with a count of zero, and the
    // strip is in the catalog's own alphabetical order.
    expect(options).toEqual([
      { id: 1, name: 'عام', count: 1 },
      { id: 2, name: 'مشروبات', count: 0 },
    ])
  })

  it('names a category that exists only on the items, and counts every item', () => {
    const options = buildCategoryOptions(
      [
        product({ id: 1, category_id: 7, category_name: 'غسيل' }),
        product({ id: 2, category_id: 7, category_name: 'غسيل' }),
      ],
      [],
    )

    expect(options).toEqual([{ id: 7, name: 'غسيل', count: 2 }])
  })

  it('keeps a still-nonzero empty selection on itself', () => {
    const options = buildCategoryOptions(
      [product({ id: 1, category_id: 1, category_name: 'عام' })],
      [{ id: 1, name: 'عام' }],
    )

    expect(resolveEffectiveCategoryId(1, options)).toBe(1)
  })

  it('resolves a selection with no items to "all", during render', () => {
    const options = buildCategoryOptions([], [{ id: 1, name: 'عام' }])

    expect(resolveEffectiveCategoryId(1, options)).toBeNull()
    expect(resolveEffectiveCategoryId(null, options)).toBeNull()
  })
})

describe('buildBarCategories', () => {
  const pinned = [
    { id: 1, name: 'عام', count: 1 },
    { id: 2, name: 'مشروبات', count: 0 },
  ]
  const all = [...pinned, { id: 3, name: 'غسيل', count: 4 }]

  it('leaves the bar untouched when the selection is already shown', () => {
    expect(buildBarCategories(pinned, all, 2)).toEqual(pinned)
  })

  it('appends a selected category the compact bar is hiding', () => {
    expect(buildBarCategories(pinned, all, 3)).toEqual([...pinned, all[2]])
  })

  it('never appends anything when "all" is selected', () => {
    expect(buildBarCategories(pinned, all, null)).toEqual(pinned)
  })
})

describe('countCatalog', () => {
  it('counts total, active and each department, and tolerates a pending load', () => {
    expect(countCatalog(null)).toEqual({ total: 0, active: 0, cafe: 0, wash: 0 })

    expect(
      countCatalog([
        product({ id: 1, department: 'CAFE' }),
        product({ id: 2, department: 'WASH' }),
        product({ id: 3, department: 'WASH', is_active: false }),
      ]),
    ).toEqual({ total: 3, active: 2, cafe: 1, wash: 2 })
  })
})

describe('filterCatalogItems', () => {
  const items = [
    product({ id: 1, name: 'كابتشينو', department: 'CAFE', category_id: 1 }),
    product({ id: 2, name: 'غسيل خارجي', department: 'WASH', category_id: 2 }),
    product({ id: 3, name: 'كابتشينو فاخر', department: 'CAFE', category_id: 2, is_active: false }),
  ]

  it('matches the search case-insensitively on the item name only', () => {
    expect(filterCatalogItems(items, { ...NO_FILTER, query: 'كابتشينو' }).map((i) => i.id)).toEqual(
      [1, 3],
    )
  })

  it('combines every narrowing rule, not just the last one set', () => {
    const result = filterCatalogItems(items, {
      query: 'كابتشينو',
      effectiveCategoryId: 1,
      dept: 'CAFE',
      type: 'PRODUCT',
      status: 'ACTIVE',
    })

    expect(result.map((item) => item.id)).toEqual([1])
  })

  it('separates active from inactive and returns everything otherwise', () => {
    expect(
      filterCatalogItems(items, { ...NO_FILTER, status: 'INACTIVE' }).map((i) => i.id),
    ).toEqual([3])
    expect(filterCatalogItems(items, NO_FILTER)).toHaveLength(3)
  })

  it('treats a pending load as an empty result rather than throwing', () => {
    expect(filterCatalogItems(null, NO_FILTER)).toEqual([])
  })
})

describe('hasCatalogFilters', () => {
  it('is true for any single active filter', () => {
    expect(hasCatalogFilters('', '', '', '', null)).toBe(false)
    expect(hasCatalogFilters('', 'WASH', '', '', null)).toBe(true)
    expect(hasCatalogFilters('', '', 'SERVICE', '', null)).toBe(true)
    expect(hasCatalogFilters('', '', '', 'INACTIVE', null)).toBe(true)
    expect(hasCatalogFilters('', '', '', '', 3)).toBe(true)
    expect(hasCatalogFilters('tea', '', '', '', null)).toBe(true)
  })

  it('treats a whitespace-only search as no filter, like the grid does', () => {
    // The grid trims the query too, so a stray space must not light up the
    // "you are filtering" bar and offer a clear button that does nothing.
    expect(hasCatalogFilters('  ', '', '', '', null)).toBe(false)
  })
})
