/** Typed wrappers over the catalog (products & services) command surface. */
import { call } from './ipc'
import type { Product } from './posApi'

export interface NewProductInput {
  name: string
  item_type: 'PRODUCT' | 'SERVICE'
  department: 'CAFE' | 'WASH'
  price_minor: number
  track_inventory: boolean
}

export const catalogApi = {
  list: (department?: string, activeOnly?: boolean) =>
    call<Product[]>('list_products', {
      department: department || null,
      active_only: activeOnly ?? false,
    }),
  create: (input: NewProductInput) => call<number>('create_product', { input }),
  rename: (product_id: number, name: string) => call<void>('rename_product', { product_id, name }),
  setPrice: (product_id: number, price_minor: number) =>
    call<void>('set_product_price', { product_id, price_minor }),
  setActive: (product_id: number, active: boolean) =>
    call<void>('set_product_active', { product_id, active }),
}
