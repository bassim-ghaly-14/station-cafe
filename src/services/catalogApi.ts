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
}

export const catalogApi = {
  list: (department?: string, activeOnly?: boolean) =>
    call<Product[]>('list_products', {
      department: department || null,
      active_only: activeOnly ?? false,
    }),
  listCategories: () => call<Category[]>('list_categories'),
  create: (input: NewProductInput) => call<number>('create_product', { input }),
  update: (product_id: number, input: NewProductInput) =>
    call<void>('update_product', { product_id, input }),
  rename: (product_id: number, name: string) => call<void>('rename_product', { product_id, name }),
  setPrice: (product_id: number, price_minor: number) =>
    call<void>('set_product_price', { product_id, price_minor }),
  setActive: (product_id: number, active: boolean) =>
    call<void>('set_product_active', { product_id, active }),
}
