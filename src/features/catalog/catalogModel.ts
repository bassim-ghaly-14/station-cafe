/**
 * Pure catalog derivations.
 *
 * Everything here is a plain function of its arguments: no state, no effects, no
 * API calls. The page owns the state and the effects; this module owns the rules
 * that turn that state into what the screen shows, so the deliberate UX
 * decisions (an empty selection falling back to "all", a selected category being
 * rendered even when it is hidden from the bar) live in ONE readable place
 * instead of being spread through a component body.
 */
import type { CatalogCategoryOption } from './CatalogCategoryFilter'
import type { Category } from '@/services/catalogApi'
import type { Product } from '@/services/posApi'

export type Department = 'CAFE' | 'WASH'
export type ItemType = 'PRODUCT' | 'SERVICE'
export type Status = '' | 'ACTIVE' | 'INACTIVE'

/**
 * Category navigation is built from the REAL categories the backend knows
 * about, merged with the categories actually present in the loaded items, so a
 * manager always reaches every grouping — including one whose items are all
 * filtered out right now. Counts reflect the loaded catalog, and the order is
 * alphabetical, so the strip is stable between visits.
 */
export function buildCategoryOptions(
  items: Product[] | null,
  categories: Category[],
): CatalogCategoryOption[] {
  const counts = new Map<number, number>()
  for (const item of items ?? []) {
    counts.set(item.category_id, (counts.get(item.category_id) ?? 0) + 1)
  }

  const names = new Map<number, string>()
  for (const category of categories) {
    names.set(category.id, category.name)
  }
  for (const item of items ?? []) {
    if (!names.has(item.category_id)) {
      names.set(item.category_id, item.category_name)
    }
  }

  return [...names.entries()]
    .map(([id, name]) => ({ id, name, count: counts.get(id) ?? 0 }))
    .sort((left, right) => left.name.localeCompare(right.name, 'ar'))
}

/**
 * A category selection that no longer has any items is a contradictory state:
 * the grid would be empty while the strip implies there is something there.
 * It is resolved DURING RENDER (not in an effect) by treating such a
 * selection as "all", so what is on screen is always self-consistent and no
 * extra render pass is needed.
 */
export function resolveEffectiveCategoryId(
  categoryId: number | null,
  categoryOptions: CatalogCategoryOption[],
): number | null {
  const selectedCategoryIsEmpty =
    categoryId !== null && categoryOptions.some((c) => c.id === categoryId && c.count === 0)

  return selectedCategoryIsEmpty ? null : categoryId
}

/**
 * A selected category must always be VISIBLE in the bar: the filter is applied
 * to the grid, so a chip the cashier cannot see would be a filter they cannot
 * see or undo. When the selection is not pinned, the compact bar renders it
 * anyway rather than hiding the active state.
 */
export function buildBarCategories(
  shownCategories: CatalogCategoryOption[],
  categoryOptions: CatalogCategoryOption[],
  effectiveCategoryId: number | null,
): CatalogCategoryOption[] {
  const selectedButHidden =
    effectiveCategoryId !== null &&
    !shownCategories.some((category) => category.id === effectiveCategoryId)

  const selectedHiddenCategory =
    effectiveCategoryId === null
      ? undefined
      : categoryOptions.find((category) => category.id === effectiveCategoryId)

  return selectedButHidden && selectedHiddenCategory
    ? [...shownCategories, selectedHiddenCategory]
    : shownCategories
}

export function countCatalog(items: Product[] | null): {
  total: number
  active: number
  cafe: number
  wash: number
} {
  const source = items ?? []

  return {
    total: source.length,
    active: source.filter((item) => item.is_active).length,
    cafe: source.filter((item) => item.department === 'CAFE').length,
    wash: source.filter((item) => item.department === 'WASH').length,
  }
}

export interface CatalogFilterCriteria {
  readonly query: string
  readonly effectiveCategoryId: number | null
  readonly dept: '' | Department
  readonly type: '' | ItemType
  readonly status: Status
}

function matchesStatus(item: Product, status: Status): boolean {
  if (status === 'ACTIVE') {
    return item.is_active
  }
  if (status === 'INACTIVE') {
    return !item.is_active
  }
  return true
}

export function filterCatalogItems(
  items: Product[] | null,
  { query, effectiveCategoryId, dept, type, status }: CatalogFilterCriteria,
): Product[] {
  const q = query.trim().toLowerCase()

  return (items ?? []).filter(
    (item) =>
      (!q || item.name.toLowerCase().includes(q)) &&
      (effectiveCategoryId === null || item.category_id === effectiveCategoryId) &&
      (!dept || item.department === dept) &&
      (!type || item.item_type === type) &&
      matchesStatus(item, status),
  )
}

export function hasCatalogFilters(
  query: string,
  dept: '' | Department,
  type: '' | ItemType,
  status: Status,
  categoryId: number | null,
): boolean {
  return Boolean(query.trim() || dept || type || status || categoryId !== null)
}
