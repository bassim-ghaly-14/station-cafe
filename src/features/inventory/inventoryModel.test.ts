/**
 * The inventory presentation model.
 *
 * These tests exist to pin the ONE rule that must not drift: the stock status is
 * the backend's `quantity <= min_quantity`, unchanged from the row badge this
 * page used before the redesign. Everything else here is presentation arithmetic
 * over the complete set `list_stock` returns.
 */
import { describe, expect, it } from 'vitest'
import {
  attentionRows,
  filterStock,
  formatMovementChange,
  hasStockQuery,
  isLowStock,
  movementTone,
  NO_STOCK_QUERY,
  stockStateOf,
  stockStatusOf,
  summarizeStock,
} from './inventoryModel'
import type { MovementRow, StockRow } from '@/services/opsApi'

function stock(over: Partial<StockRow> = {}): StockRow {
  return {
    product_id: 1,
    product_name: 'حليب',
    department: 'CAFE',
    category_name: 'عام',
    item_type: 'PRODUCT',
    quantity: 10,
    min_quantity: 3,
    ...over,
  }
}

function movement(over: Partial<MovementRow> = {}): MovementRow {
  return {
    id: 1,
    product_name: 'حليب',
    change: 5,
    reason: 'PURCHASE',
    note: null,
    created_at: '2026-03-01 10:00:00',
    ...over,
  }
}

describe('isLowStock — the backend rule, restated exactly', () => {
  it('treats an item AT its minimum as low, not only below it', () => {
    // `<=` is the contract. `<` would silently reclassify a row the backend's
    // own `ORDER BY (quantity <= min_quantity) DESC` already puts first.
    expect(isLowStock(stock({ quantity: 3, min_quantity: 3 }))).toBe(true)
  })

  it('treats an item below its minimum, including a negative balance, as low', () => {
    expect(isLowStock(stock({ quantity: 2, min_quantity: 3 }))).toBe(true)
    expect(isLowStock(stock({ quantity: -4, min_quantity: 0 }))).toBe(true)
  })

  it('treats an item above its minimum as OK', () => {
    expect(isLowStock(stock({ quantity: 4, min_quantity: 3 }))).toBe(false)
  })

  it('exposes only the two states Station stores, with no third state', () => {
    // An item at zero is LOW, exactly as before. A separate out-of-stock status
    // would be a new business distinction, so it is not modelled here at all.
    expect(stockStatusOf(stock({ quantity: 0, min_quantity: 0 }))).toBe('LOW')
    expect(stockStatusOf(stock({ quantity: 0, min_quantity: 5 }))).toBe('LOW')
    expect(stockStatusOf(stock({ quantity: 9, min_quantity: 5 }))).toBe('OK')
  })
})

describe('summarizeStock — three counts over the complete loaded set', () => {
  it('reports zero of everything for an empty set rather than throwing', () => {
    expect(summarizeStock([])).toEqual({ total: 0, low: 0, ok: 0, below: 0, atMin: 0 })
  })

  it('splits the rows into low and OK with no third bucket', () => {
    const rows = [
      stock({ product_id: 1, quantity: 2, min_quantity: 3 }),
      stock({ product_id: 2, quantity: 50, min_quantity: 3 }),
      stock({ product_id: 3, quantity: 0, min_quantity: 0 }),
      stock({ product_id: 4, quantity: 1, min_quantity: 1 }),
    ]
    const summary = summarizeStock(rows)
    expect(summary).toEqual({ total: 4, low: 3, ok: 1, below: 1, atMin: 2 })
    // The invariant the band relies on: nothing is unaccounted for.
    expect(summary.low + summary.ok).toBe(summary.total)
    expect(summary.below + summary.atMin).toBe(summary.low)
  })
})

describe('stockStateOf — the three explicit states', () => {
  it('distinguishes below, at, and above minimum', () => {
    expect(stockStateOf(stock({ quantity: 4, min_quantity: 5 }))).toBe('BELOW_MINIMUM')
    expect(stockStateOf(stock({ quantity: 5, min_quantity: 5 }))).toBe('AT_MINIMUM')
    expect(stockStateOf(stock({ quantity: 12, min_quantity: 5 }))).toBe('ABOVE_MINIMUM')
  })

  it('treats the 20/5 → 5/5 → 4/5 walk as above → at → below', () => {
    expect(stockStateOf(stock({ quantity: 20, min_quantity: 5 }))).toBe('ABOVE_MINIMUM')
    expect(stockStateOf(stock({ quantity: 5, min_quantity: 5 }))).toBe('AT_MINIMUM')
    expect(stockStateOf(stock({ quantity: 4, min_quantity: 5 }))).toBe('BELOW_MINIMUM')
  })
})

describe('filterStock — presentational filtering over rows already in memory', () => {
  const rows = [
    stock({ product_id: 1, product_name: 'حليب', quantity: 10, min_quantity: 3 }),
    stock({ product_id: 2, product_name: 'شوكولاتة', quantity: 1, min_quantity: 3 }),
    stock({ product_id: 3, product_name: 'Ice Coffee', quantity: 7, min_quantity: 3 }),
  ]

  it('returns the whole set for the empty query', () => {
    expect(filterStock(rows, NO_STOCK_QUERY)).toHaveLength(3)
  })

  it('matches the product name case-insensitively', () => {
    expect(filterStock(rows, { query: 'ice', status: 'ALL' }).map((r) => r.product_id)).toEqual([3])
  })

  it('ignores surrounding whitespace rather than searching for it', () => {
    expect(filterStock(rows, { query: '  حليب ', status: 'ALL' })).toHaveLength(1)
  })

  it('combines the name with the status filter', () => {
    expect(filterStock(rows, { query: 'شوكولاتة', status: 'LOW' })).toHaveLength(1)
    expect(filterStock(rows, { query: 'حليب', status: 'LOW' })).toHaveLength(0)
  })

  it('never matches Catalog metadata, because it is not searchable here', () => {
    // The row carries these fields, but they belong to Catalog. Searching them
    // would make this page a second product browser.
    expect(filterStock(rows, { query: 'CAFE', status: 'ALL' })).toHaveLength(0)
    expect(filterStock(rows, { query: 'عام', status: 'ALL' })).toHaveLength(0)
  })
})

describe('hasStockQuery — the reset control is only offered when it would do something', () => {
  it('is false for the empty query and for whitespace alone', () => {
    expect(hasStockQuery(NO_STOCK_QUERY)).toBe(false)
    expect(hasStockQuery({ query: '   ', status: 'ALL' })).toBe(false)
  })

  it('is true as soon as either half narrows the list', () => {
    expect(hasStockQuery({ query: 'حليب', status: 'ALL' })).toBe(true)
    expect(hasStockQuery({ query: '', status: 'LOW' })).toBe(true)
  })
})

describe('attentionRows — the same rows, in the backend order', () => {
  it('lists only the low rows and preserves the order it was given', () => {
    const rows = [
      stock({ product_id: 7, quantity: 0, min_quantity: 2 }),
      stock({ product_id: 3, quantity: 40, min_quantity: 2 }),
      stock({ product_id: 9, quantity: 1, min_quantity: 2 }),
    ]
    expect(attentionRows(rows).map((r) => r.product_id)).toEqual([7, 9])
  })

  it('is empty when nothing needs attention, so the area is not rendered', () => {
    expect(attentionRows([stock({ quantity: 40, min_quantity: 2 })])).toEqual([])
  })
})

describe('movementTone / formatMovementChange — the sign is in the text, not only the colour', () => {
  it('reads a receipt as IN and prints it with an explicit plus', () => {
    expect(movementTone(movement({ change: 5 }))).toBe('IN')
    expect(formatMovementChange(movement({ change: 5 }))).toBe('+5')
  })

  it('reads a reduction as OUT and keeps the backend minus sign', () => {
    expect(movementTone(movement({ change: -3 }))).toBe('OUT')
    expect(formatMovementChange(movement({ change: -3 }))).toBe('-3')
  })

  it('prints a zero movement unchanged rather than decorating it', () => {
    // The backend refuses a zero change on an adjustment, so this is only
    // defensive; the point is that no sign is invented for it.
    expect(formatMovementChange(movement({ change: 0 }))).toBe('0')
  })
})
