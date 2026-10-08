/** Typed wrappers over the catalog (products & services) command surface. */
import { call } from './ipc'
import type { Product } from './posApi'

export interface Category {
  id: number
  name: string
}

export interface NewProductInput {
  name: string
  item_type: 'PRODUCT' | 'SERVICE'
  department: 'CAFE' | 'WASH'
  category_id: number
  price_minor: number
  track_inventory: boolean
  /** Opening/current stock quantity; ignored when `track_inventory` is false. */
  stock_quantity: number | null
  /**
   * Minimum-stock threshold; ignored when `track_inventory` is false.
   * `null` means 0 (the legacy default). Persisted atomically with the
   * product row — no second `setStockMinimum` round-trip.
   */
  min_quantity: number | null
  /** Marks the item as a recent addition; independent of its availability. */
  is_new: boolean
}

export const catalogApi = {
  list: (department?: string, activeOnly?: boolean) =>
    call<Product[]>('list_products', {
      department: department || null,
      active_only: activeOnly ?? false,
    }),
  listCategories: () => call<Category[]>('list_categories'),
  createCategory: (name: string) => call<number>('create_category', { name }),
  /** MANAGER+ rename; the same name rules as creation apply. */
  updateCategory: (category_id: number, name: string) =>
    call<void>('update_category', { category_id, name }),
  /**
   * ADMIN-only delete. The backend refuses a category that still holds products
   * or is the system one, so the business error is what the UI must surface.
   */
  removeCategory: (category_id: number) => call<void>('delete_category', { category_id }),
  create: (input: NewProductInput) => call<number>('create_product', { input }),
  update: (product_id: number, input: NewProductInput) =>
    call<void>('update_product', { product_id, input }),
  rename: (product_id: number, name: string) => call<void>('rename_product', { product_id, name }),
  setPrice: (product_id: number, price_minor: number) =>
    call<void>('set_product_price', { product_id, price_minor }),
  setActive: (product_id: number, active: boolean) =>
    call<void>('set_product_active', { product_id, active }),
  /** ADMIN-only archive of a product/service; history is preserved. */
  remove: (product_id: number) => call<void>('delete_product', { product_id }),
}
