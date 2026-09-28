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
import { Button, MoneyDisplay } from '@/components/ui'
import { Coffee, Droplets } from '@/components/ui/icon'
import { QtyStepper } from './QtyStepper'
import type { Product } from '@/services/posApi'

type Department = 'CAFE' | 'WASH'

const DEPARTMENTS: Department[] = ['CAFE', 'WASH']

/**
 * The shared grid for the category list and the product list.
 *
 * Two columns on a phone, three from `sm` up — chosen so a product name and its
 * price both fit legibly at 360px rather than being truncated to nothing.
 *
 * The height cap and the internal scroll are `sm:`-only, and that is the whole
 * point of this constant. The POS page is a two-pane desktop layout: a fixed
 * product grid beside a live order panel, each scrolling inside itself. On a
 * phone the two panes are stacked and the PAGE is the only scroll container, so
 * a capped, independently scrolling grid inside it produced the nested-scroll
 * trap — dragging through the products scrolled a small inner box while the
 * page stayed put, and the cashier had to find the right scroll target. Letting
 * the phone grid grow with the page removes the inner scroller entirely, which
 * is why the cap is not applied below `sm`.
 */
const PRODUCT_GRID = 'grid grid-cols-2 gap-2 sm:max-h-72 sm:grid-cols-3 sm:overflow-y-auto'

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
          // See PRODUCT_GRID for why the internal scroll is desktop-only.
          <div className={PRODUCT_GRID}>
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => setCategoryId(category.id)}
                className="flex min-h-16 flex-col items-start justify-center gap-0.5 rounded-lg border border-border-strong bg-transparent p-2 text-start transition-colors hover:border-border-accent-hover hover:bg-surface-hover active:bg-accent"
              >
                <span className="w-full truncate text-sm font-medium">{category.name}</span>

                <span className="text-xs text-foreground-subtle">
                  {t('pos.itemTypesCount', { count: category.items.length })}
                </span>
              </button>
            ))}
          </div>
        )
      ) : activeCategory.items.length === 0 ? (
        <p className="py-4 text-center text-sm text-foreground-subtle">{t('pos.noItems')}</p>
      ) : (
        <div className={PRODUCT_GRID}>
          {activeCategory.items.map((product) => (
            <button
              key={product.id}
              type="button"
              onClick={() => onAdd(product)}
              className="flex min-h-16 flex-col items-start justify-center gap-0.5 rounded-lg border border-border-strong bg-transparent p-2 text-start text-foreground transition-colors hover:border-border-accent-hover hover:bg-accent active:border-border-accent-hover active:bg-accent-hover"
            >
              <span className="w-full truncate text-sm font-medium">{product.name}</span>

              <span className="text-sm font-bold text-foreground-muted">
                <MoneyDisplay amount={product.price_minor} />
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
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
