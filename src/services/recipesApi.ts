/**
 * Typed wrappers over the raw-material / recipe command surface.
 *
 * Raw materials are a SEPARATE inventory domain from products: a material's
 * quantity is in its NORMALIZED base unit (grams or milliliters, always an
 * integer), while a product's stock stays in `inventory_items`. Nothing in this
 * module may read or write product stock.
 */
import { call } from './ipc'

/** The normalized base unit a material's quantity is stored in. */
export type BaseUnit = 'GRAM' | 'MILLILITER'

/** The units a manager may select when creating a material or buying stock. */
export const MATERIAL_UNITS = ['GRAM', 'KILOGRAM', 'MILLILITER', 'LITER'] as const
export type MaterialUnit = (typeof MATERIAL_UNITS)[number]

/** The closed movement vocabulary. Every balance change is one of these. */
export const MATERIAL_REASONS = ['PURCHASE', 'SALE_CONSUMPTION', 'WASTE', 'ADJUSTMENT'] as const
export type MaterialReason = (typeof MATERIAL_REASONS)[number]

export interface RawMaterial {
  id: number
  name: string
  department: 'CAFE' | 'WASH'
  base_unit: BaseUnit
  /** Authoritative live balance in base units. Never negative. */
  current_quantity: number
  /** Latest per-base-unit cost — informational Recipe Cost basis only. */
  last_purchase_unit_cost_minor: number | null
  is_active: boolean
  created_at: string
}

export interface RawMaterialMovement {
  id: number
  raw_material_id: number
  raw_material_name: string
  base_unit: BaseUnit
  change: number
  reason: MaterialReason
  note: string | null
  ref_invoice_id: number | null
  /** Populated only for PURCHASE — the expense this purchase created. */
  expense_id: number | null
  user_name: string | null
  created_at: string
}

export interface NewMaterialInput {
  name: string
  department: 'CAFE' | 'WASH'
  base_unit: BaseUnit
}

/**
 * A purchase. `quantity` is entered in `purchase_unit` and `total_cost_minor`
 * is the TOTAL paid for the whole purchase — so the expense can never be
 * double-scaled by the normalized base quantity.
 */
export interface PurchaseInput {
  raw_material_id: number
  quantity: number
  purchase_unit: MaterialUnit
  total_cost_minor: number
  note: string | null
}

export interface RecipeItem {
  id: number
  product_id: number
  raw_material_id: number
  raw_material_name: string
  base_unit: BaseUnit
  /** Base units consumed by ONE unit of the product. */
  quantity_base: number
  last_purchase_unit_cost_minor: number | null
}

export interface RecipeLineInput {
  raw_material_id: number
  quantity_base: number
}

export interface RecipeCostLine {
  raw_material_id: number
  raw_material_name: string
  base_unit: BaseUnit
  quantity_base: number
  unit_cost_minor: number | null
  cost_minor: number | null
}

export interface RecipeCostView {
  product_id: number
  lines: RecipeCostLine[]
  /** Informational total; `null` when any line has no known unit cost. */
  total_cost_minor: number | null
}

export interface RecipeRequirement {
  raw_material_id: number
  required_base: number
  available_base: number
}

export interface RecipeAvailability {
  product_id: number
  /** Advisory: every material covers ONE unit right now. Checkout revalidates. */
  available: boolean
  requirements: RecipeRequirement[]
}

export const recipesApi = {
  list: (activeOnly = true) =>
    call<RawMaterial[]>('list_raw_materials', { active_only: activeOnly }),
  create: (input: NewMaterialInput) => call<number>('create_raw_material', { input }),
  update: (material_id: number, input: NewMaterialInput) =>
    call<void>('update_raw_material', { material_id, input }),
  archive: (material_id: number) => call<void>('archive_raw_material', { material_id }),
  purchase: (input: PurchaseInput) => call<void>('purchase_raw_material', { input }),
  adjust: (material_id: number, change: number, note: string | null) =>
    call<void>('adjust_raw_material', { material_id, change, note }),
  waste: (material_id: number, quantity: number, note: string | null) =>
    call<void>('waste_raw_material', { material_id, quantity, note }),
  movements: (material_id: number | null, limit = 50) =>
    call<RawMaterialMovement[]>('list_raw_material_movements', { material_id, limit }),
  getRecipe: (product_id: number) => call<RecipeItem[]>('get_product_recipe', { product_id }),
  recipeCost: (product_id: number) => call<RecipeCostView>('get_recipe_cost', { product_id }),
  setRecipe: (product_id: number, lines: RecipeLineInput[]) =>
    call<void>('set_product_recipe', { product_id, lines }),
  availability: (product_ids: number[]) =>
    call<RecipeAvailability[]>('recipe_availability', { product_ids }),
}
