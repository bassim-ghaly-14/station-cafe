/**
 * Hierarchical product/service discovery for the POS.
 *
 *   القسم (كافيه / مغسلة) → التصنيف → الصنف
 *
 * Three intentional taps reach any item, and there is no search box: the
 * catalog's own categories are the navigation, so a cashier never has to guess
 * how something is spelled. Everything rendered here comes from the real
 * catalog (`api.products()`) — no category is hardcoded in the UI.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import { Coffee, Droplets } from '@/components/ui/icon'
import { PosProductCard } from './PosProductCard'
import { QtyStepper } from './QtyStepper'
import { categoryTone } from '@/lib/category-visual'
import { cn } from '@/lib/utils'
import type { Product } from '@/services/posApi'

type Department = 'CAFE' | 'WASH'

const DEPARTMENTS: Department[] = ['CAFE', 'WASH']

/**
 * The shared grid for the category list and the product list.
 *
 * It is an auto-fill track rather than a column COUNT, so the number of columns
 * follows the width actually available instead of a hardcoded breakpoint that
 * only suits one screen. The 11rem floor is what a tile needs to show a name
 * over two lines beside its price with neither truncated; a narrower track than
 * that is precisely the defect this replaces.
 *
 * There is deliberately NO height cap and NO internal scroll here. The order
 * workspace owns exactly one scroll container per axis: on a desktop the two
 * columns scroll inside themselves, and on a phone the page does. A capped grid
 * nested inside one of those is the nested-scroll trap — dragging through the
 * products scrolls a small inner box while the surrounding pane stays put, and
 * the cashier has to hunt for the right scroll target.
 */
const PRODUCT_GRID =
  'grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(11rem,1fr))] sm:gap-3'

interface CategoryGroup {
  id: number
  name: string
  items: Product[]
}

export function ProductBrowser({
  products,
  qty,
  onQtyChange,
  onAdd,
}: {
  /** The whole active catalog; grouping happens here, not in the API. */
  readonly products: Product[]
  readonly qty: number
  readonly onQtyChange: (quantity: number) => void
  readonly onAdd: (product: Product) => void
}) {
  const { t } = useTranslation()
  const [department, setDepartment] = useState<Department | null>(null)
  const [categoryId, setCategoryId] = useState<number | null>(null)

  const byDepartment = useMemo(
    () =>
      DEPARTMENTS.map((value) => ({
        value,
        items: products.filter((p) => p.department === value),
      })),
    [products],
  )

  const categories = useMemo<CategoryGroup[]>(() => {
    if (!department) return []
    const groups = new Map<number, CategoryGroup>()
    for (const product of byDepartment.find((d) => d.value === department)?.items ?? []) {
      const existing = groups.get(product.category_id)
      if (existing) {
        existing.items.push(product)
      } else {
        groups.set(product.category_id, {
          id: product.category_id,
          name: product.category_name,
          items: [product],
        })
      }
    }
    return [...groups.values()]
  }, [byDepartment, department])

  const activeCategory = categories.find((c) => c.id === categoryId) ?? null

  // The breadcrumb doubles as the back control, so a mis-tap is one tap to undo
  // instead of a hidden state reset.
  const crumb = (label: string, onClick: () => void, isLast: boolean) => (
    <Button
      key={label}
      variant="ghost"
      size="sm"
      onClick={onClick}
      className={isLast ? 'pointer-events-none font-bold text-foreground-strong' : undefined}
      aria-current={isLast ? 'page' : undefined}
    >
      {label}
    </Button>
  )

  return (
    <section aria-label={t('pos.products')} className="flex flex-col">
      <nav aria-label={t('pos.products')} className="mb-3 flex flex-wrap items-center gap-1">
        {crumb(
          t('pos.products'),
          () => {
            setDepartment(null)
            setCategoryId(null)
          },
          department === null,
        )}
        {department
          ? crumb(t(`pos.dept.${department}`), () => setCategoryId(null), categoryId === null)
          : null}
        {activeCategory ? crumb(activeCategory.name, () => {}, true) : null}
      </nav>

      {/* Quantity applies to the next tap: one decision, not one per item. */}
      {department ? (
        <div className="mb-3 flex items-center justify-between gap-3 border-y border-border-subtle py-2">
          <span className="text-sm font-medium text-foreground-muted">{t('pos.qty')}</span>

          <QtyStepper qty={qty} min={1} onChange={onQtyChange} big />
        </div>
      ) : null}

      {department === null ? (
        <DepartmentGrid departments={byDepartment} onPick={setDepartment} />
      ) : activeCategory === null ? (
        categories.length === 0 ? (
          <p className="py-4 text-center text-sm text-foreground-subtle">{t('pos.noCategories')}</p>
        ) : (
          // See PRODUCT_GRID for why there is no internal scroll here.
          <div className={PRODUCT_GRID}>
            {categories.map((category) => (
              // The category tile carries the SAME tone the product tiles inside it
              // will carry, so the cashier's eye learns one colour per category
              // and the two levels of the hierarchy agree.
              <CategoryTile
                key={category.id}
                id={category.id}
                name={category.name}
                itemCount={category.items.length}
                onPick={() => setCategoryId(category.id)}
              />
            ))}
          </div>
        )
      ) : activeCategory.items.length === 0 ? (
        <p className="py-4 text-center text-sm text-foreground-subtle">{t('pos.noItems')}</p>
      ) : (
        <div className={PRODUCT_GRID}>
          {activeCategory.items.map((product) => (
            <PosProductCard key={product.id} product={product} onAdd={onAdd} />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * One category in the middle level of the hierarchy.
 *
 * It wears the category's own palette — the same `categoryTone` its products
 * will wear one level down — so the two levels of the hierarchy agree visually
 * and the cashier can recognise a category by colour before reading it.
 */
function CategoryTile({
  id,
  name,
  itemCount,
  onPick,
}: Readonly<{
  readonly id: number
  readonly name: string
  readonly itemCount: number
  readonly onPick: () => void
}>) {
  const { t } = useTranslation()
  const tone = categoryTone(id)

  return (
    <button
      type="button"
      onClick={onPick}
      data-testid={`pos-category-${id}`}
      data-category-tone={tone.slot}
      className={cn(
        'flex min-h-24 flex-col items-start justify-center gap-1 rounded-lg border p-3 text-start',
        'transition-[border-color,box-shadow] duration-150 motion-reduce:transition-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        tone.background,
        tone.border,
        'hover:border-border-accent-hover hover:shadow-md',
      )}
    >
      <span className={cn('line-clamp-2 text-base leading-snug font-bold', tone.foreground)}>
        {name}
      </span>

      <span className="text-caption text-foreground-subtle">
        {t('pos.itemTypesCount', { count: itemCount })}
      </span>
    </button>
  )
}

/**
 * The first question the browser asks: which area is this order for.
 *
 * Each area carries its own glyph and the number of item types behind it, so a
 * cashier can tell the two apart before reading any text. The grid is the only
 * place the two departments are compared, which is why it is its own component.
 */
function DepartmentGrid({
  departments,
  onPick,
}: Readonly<{
  departments: readonly { value: Department; items: Product[] }[]
  onPick: (value: Department) => void
}>) {
  const { t } = useTranslation()
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {departments.map((group) => (
        <button
          key={group.value}
          type="button"
          onClick={() => onPick(group.value)}
          className="flex min-h-24 items-center gap-3 rounded-lg border border-border-strong bg-transparent p-3 text-start transition-colors hover:border-border-accent-hover hover:bg-surface-hover active:bg-accent"
        >
          <span
            aria-hidden
            className="flex size-11 shrink-0 items-center justify-center rounded-md bg-surface-muted text-foreground-strong"
          >
            {group.value === 'CAFE' ? <Coffee size={22} /> : <Droplets size={22} />}
          </span>

          <span className="min-w-0">
            <span className="block text-base font-bold text-foreground-strong">
              {t(`pos.${group.value.toLowerCase()}`)}
            </span>

            <span className="mt-0.5 block text-xs text-foreground-subtle">
              {t('pos.itemTypesCount', { count: group.items.length })}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}
