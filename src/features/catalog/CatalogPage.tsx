/**
 * Station Cafe — Catalog
 *
 * Catalog is visually divided into two business identities:
 *
 * CAFE
 * - Warm / product-oriented
 * - Uses the primary brand tokens
 *
 * WASH
 * - Clean / service-oriented
 * - Uses the info tokens
 *
 * STAFF:
 * - Read-only catalog access.
 *
 * MANAGER / ADMIN:
 * - Full catalog management.
 *
 * Backend remains authoritative for all mutations.
 *
 * Visual rules:
 * - No raw colors.
 * - No "PRODUCT · CAFE" metadata sentences.
 * - Department is the visual identity.
 * - Item type is secondary metadata.
 * - Price is the visual focal point.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState, ErrorState } from '@/components/states'
import { Button, CardGridSkeleton, Dialog } from '@/components/ui'
import { Field, Input, Label, Switch } from '@/components/ui/input'
import { Check, Coffee, Droplets, Package, Plus, Save, Search } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'

import { useErrText } from '@/lib/err'
import { formatMinorMoneyInput } from '@/lib/money'
import { parseMajor } from '@/lib/utils'

import { catalogApi, type Category, type NewProductInput } from '@/services/catalogApi'
import type { Product } from '@/services/posApi'

import { useSession } from '@/features/auth/useSession'

import { CatalogCard } from './CatalogCard'
import { CatalogCategoryFilter, type CatalogCategoryOption } from './CatalogCategoryFilter'

const DEPARTMENTS = ['CAFE', 'WASH'] as const
const TYPES = ['PRODUCT', 'SERVICE'] as const

/** Non-negative integer stock quantity; empty input means zero. */
function parseStockQuantity(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return 0
  }
  if (!/^\d+$/.test(trimmed)) {
    return null
  }
  const quantity = Number(trimmed)
  return Number.isSafeInteger(quantity) ? quantity : null
}

type Department = (typeof DEPARTMENTS)[number]
type ItemType = (typeof TYPES)[number]
type Status = '' | 'ACTIVE' | 'INACTIVE'

/* ========================================================================== */
/* Department visual identity                                                 */
/* ========================================================================== */

const departmentStyles: Record<
  Department,
  {
    accent: string
    accentText: string
    soft: string
    softStrong: string
    border: string
    mutedBorder: string
    price: string
  }
> = {
  CAFE: {
    accent: 'bg-primary',
    accentText: 'text-primary',
    soft: 'bg-accent',
    softStrong: 'bg-secondary',
    border: 'border-primary-border',
    mutedBorder: 'border-primary-soft',
    price: 'text-primary',
  },

  WASH: {
    accent: 'bg-info',
    accentText: 'text-info',
    soft: 'bg-info-soft',
    softStrong: 'bg-info-soft',
    border: 'border-info-border',
    mutedBorder: 'border-info-soft',
    price: 'text-info',
  },
}

/* ========================================================================== */
/* Page                                                                       */
/* ========================================================================== */

export default function CatalogPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const { user } = useSession()

  const [items, setItems] = useState<Product[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [dept, setDept] = useState<'' | Department>('')
  const [type, setType] = useState<'' | ItemType>('')
  const [status, setStatus] = useState<Status>('')
  /** `null` = every category; otherwise the category's database id. */
  const [categoryId, setCategoryId] = useState<number | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [categoryCreateOpen, setCategoryCreateOpen] = useState(false)
  const [categories, setCategories] = useState<Category[]>([])
  const [editing, setEditing] = useState<Product | null>(null)
  const [confirming, setConfirming] = useState<Product | null>(null)

  const canManageCatalog = user?.role === 'MANAGER' || user?.role === 'ADMIN'

  const load = useCallback(() => {
    setLoadError(null)

    catalogApi
      .list()
      .then(setItems)
      .catch((error) => {
        const message = errText(error)

        setLoadError(message)
        toast(message, 'error')
      })
  }, [errText, toast])

  const loadCategories = useCallback(() => {
    catalogApi
      .listCategories()
      .then(setCategories)
      .catch((error) => toast(errText(error), 'error'))
  }, [errText, toast])

  useEffect(() => {
    load()
    loadCategories()
  }, [load, loadCategories])

  /**
   * Category navigation is built from the REAL categories the backend knows
   * about, merged with the categories actually present in the loaded items, so
   * a manager always reaches every grouping — including one whose items are all
   * filtered out right now. Counts reflect the loaded catalog, and the order is
   * the backend's (alphabetical) order, so the strip is stable between visits.
   */
  const categoryOptions = useMemo<CatalogCategoryOption[]>(() => {
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
  }, [categories, items])

  /**
   * A category selection that no longer has any items is a contradictory state:
   * the grid would be empty while the strip implies there is something there.
   * It is resolved DURING RENDER (not in an effect) by treating such a
   * selection as "all", so what is on screen is always self-consistent and no
   * extra render pass is needed.
   */
  const selectedCategoryIsEmpty =
    categoryId !== null && categoryOptions.some((c) => c.id === categoryId && c.count === 0)
  const effectiveCategoryId = selectedCategoryIsEmpty ? null : categoryId

  const counts = useMemo(() => {
    const source = items ?? []

    return {
      total: source.length,
      active: source.filter((item) => item.is_active).length,
      cafe: source.filter((item) => item.department === 'CAFE').length,
      wash: source.filter((item) => item.department === 'WASH').length,
    }
  }, [items])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()

    return (items ?? []).filter((item) => {
      if (q && !item.name.toLowerCase().includes(q)) {
        return false
      }

      if (effectiveCategoryId !== null && item.category_id !== effectiveCategoryId) {
        return false
      }

      if (dept && item.department !== dept) {
        return false
      }

      if (type && item.item_type !== type) {
        return false
      }

      if (status === 'ACTIVE' && !item.is_active) {
        return false
      }

      if (status === 'INACTIVE' && item.is_active) {
        return false
      }

      return true
    })
  }, [items, query, effectiveCategoryId, dept, type, status])

  const hasFilters = Boolean(query.trim() || dept || type || status || categoryId !== null)

  function clearFilters() {
    setQuery('')
    setDept('')
    setType('')
    setStatus('')
    setCategoryId(null)
  }

  async function toggleActive(product: Product) {
    if (!canManageCatalog) {
      return
    }

    try {
      await catalogApi.setActive(product.id, !product.is_active)

      toast(product.is_active ? t('catalog.deactivated') : t('catalog.activated'), 'success')

      setConfirming(null)
      load()
    } catch (error) {
      toast(errText(error), 'error')
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ================================================================== */}
      {/* Header                                                             */}
      {/* ================================================================== */}

      <header className="flex flex-col gap-5 border-b border-border pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center border border-border bg-surface-muted text-foreground-muted">
              <Package size={16} aria-hidden />
            </div>

            <span className="text-caption font-bold uppercase tracking-[0.16em] text-foreground-subtle">
              {t('nav.catalog')}
            </span>
          </div>

          <h1 className="text-heading">{t('catalog.description')}</h1>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-caption">
              {filtered.length} {t('catalog.type')}
            </span>

            <span className="h-1 w-1 bg-foreground-faint" aria-hidden />

            <span className="text-caption">
              {counts.active} {t('catalog.active')}
            </span>
          </div>
        </div>

        {canManageCatalog ? (
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Button onClick={() => setCreateOpen(true)} className="w-full sm:w-auto">
              <Plus size={16} aria-hidden />
              {t('catalog.add')}
            </Button>
            <Button
              variant="outline"
              onClick={() => setCategoryCreateOpen(true)}
              className="w-full sm:w-auto"
            >
              <Plus size={16} aria-hidden />
              {t('catalog.addCategory')}
            </Button>
          </div>
        ) : null}
      </header>

      {/* ================================================================== */}
      {/* Catalog overview / department filters                              */}
      {/* ================================================================== */}

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <CatalogOverview
          type="TOTAL"
          count={counts.total}
          active={dept === ''}
          onClick={() => setDept('')}
          t={t}
        />

        <CatalogOverview
          type="CAFE"
          count={counts.cafe}
          active={dept === 'CAFE'}
          onClick={() => setDept(dept === 'CAFE' ? '' : 'CAFE')}
          t={t}
        />

        <CatalogOverview
          type="WASH"
          count={counts.wash}
          active={dept === 'WASH'}
          onClick={() => setDept(dept === 'WASH' ? '' : 'WASH')}
          t={t}
        />
      </section>

      {/* ================================================================== */}
      {/* Filters                                                             */}
      {/* ================================================================== */}

      <section className="border border-border bg-surface">
        <div className="flex flex-col gap-3 p-3 xl:flex-row">
          {/* Search */}
          <div className="relative min-w-0 flex-1">
            <Search
              size={17}
              aria-hidden
              className="pointer-events-none absolute top-1/2 inset-s-3 -translate-y-1/2 text-foreground-subtle"
            />

            <Input
              aria-label={t('catalog.search')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('catalog.search')}
              className="h-11 ps-9"
            />
          </div>

          {/* Type + Status only */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:flex">
            <CatalogSelect
              aria-label={t('catalog.type')}
              value={type}
              onChange={(value) => setType(value as typeof type)}
            >
              <option value="">{t('catalog.type')}</option>

              {TYPES.map((itemType) => (
                <option key={itemType} value={itemType}>
                  {t(`catalog.${itemType}`)}
                </option>
              ))}
            </CatalogSelect>

            <CatalogSelect
              aria-label={t('app.status')}
              value={status}
              onChange={(value) => setStatus(value as typeof status)}
            >
              <option value="">{t('catalog.allStatuses')}</option>

              <option value="ACTIVE">{t('catalog.active')}</option>

              <option value="INACTIVE">{t('catalog.inactive')}</option>
            </CatalogSelect>
          </div>
        </div>

        {/* Category navigation sits directly above the results it filters, so
            the relationship between "this category" and "these cards" is
            obvious, and it is one tap away from the search box. */}
        <div className="border-t border-border-subtle px-3 py-3">
          <p className="text-caption mb-2 font-bold">{t('catalog.category')}</p>

          <CatalogCategoryFilter
            categories={categoryOptions}
            selectedId={effectiveCategoryId}
            onSelect={setCategoryId}
            allLabel={t('catalog.allCategories')}
            totalCount={counts.total}
          />
        </div>

        {hasFilters ? (
          <div className="flex items-center justify-between gap-3 border-t border-border-subtle px-3 py-2.5">
            <p className="text-caption">
              {filtered.length} {t('catalog.type')}
            </p>

            <Button variant="ghost" size="sm" onClick={clearFilters}>
              {t('catalog.clearFilters')}
            </Button>
          </div>
        ) : null}
      </section>

      {/* ================================================================== */}
      {/* Results                                                             */}
      {/* ================================================================== */}

      {items === null ? (
        loadError ? (
          <ErrorState message={loadError} onRetry={load} retryLabel={t('app.retry')} />
        ) : (
          <CardGridSkeleton cards={6} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" />
        )
      ) : filtered.length === 0 ? (
        <EmptyState
          title={hasFilters ? t('catalog.empty') : t('app.emptyTitle')}
          action={
            hasFilters ? (
              <Button variant="outline" size="sm" onClick={clearFilters}>
                {t('catalog.clearFilters')}
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {filtered.map((product) => (
            <CatalogCard
              key={product.id}
              product={product}
              canManage={canManageCatalog}
              onEdit={() => setEditing(product)}
              onToggle={() => setConfirming(product)}
            />
          ))}
        </div>
      )}

      {/* ================================================================== */}
      {/* Dialogs                                                             */}
      {/* ================================================================== */}

      {canManageCatalog && categoryCreateOpen ? (
        <CreateCategoryDialog
          existingCategories={categories}
          onClose={() => setCategoryCreateOpen(false)}
          onCreated={(name) => {
            setCategoryCreateOpen(false)
            toast(t('catalog.categoryCreated', { name }), 'success')
            loadCategories()
          }}
        />
      ) : null}

      {canManageCatalog && createOpen ? (
        <CreateProductDialog
          categories={categories}
          onClose={() => setCreateOpen(false)}
          onCreated={(name) => {
            setCreateOpen(false)
            toast(t('catalog.created', { name }), 'success')
            load()
          }}
        />
      ) : null}

      {canManageCatalog && editing ? (
        <EditProductDialog
          product={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            toast(t('staff.saved'), 'success')
            load()
          }}
        />
      ) : null}

      {canManageCatalog ? (
        <Dialog
          open={confirming !== null}
          onClose={() => setConfirming(null)}
          title={t('catalog.confirmToggle')}
        >
          <p className="text-body mb-4">
            {t('catalog.confirmToggleBody', {
              name: confirming?.name ?? '',
              next: confirming?.is_active ? t('catalog.inactive') : t('catalog.active'),
            })}
          </p>

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirming(null)}>
              {t('app.cancel')}
            </Button>

            <Button
              variant={confirming?.is_active ? 'destructive' : 'default'}
              onClick={() => {
                if (confirming) {
                  toggleActive(confirming)
                }
              }}
            >
              <Check size={16} aria-hidden />
              {t('app.confirm')}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

/* ========================================================================== */
/* Catalog overview                                                           */
/* ========================================================================== */

function CatalogOverview({
  type,
  count,
  active,
  onClick,
  t,
}: {
  type: 'TOTAL' | Department
  count: number
  active: boolean
  onClick: () => void
  t: (key: string) => string
}) {
  const isTotal = type === 'TOTAL'
  const department = isTotal ? null : type
  const style = department ? departmentStyles[department] : null

  const Icon = isTotal ? Package : department === 'CAFE' ? Coffee : Droplets

  const label = isTotal ? t('catalog.total') : t(`catalog.${department}`)

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'group relative overflow-hidden border bg-surface text-start',
        'transition-[transform,box-shadow,border-color] duration-200',
        'hover:-translate-y-0.5 hover:shadow-md',
        active
          ? isTotal
            ? 'border-border-strong shadow-md'
            : `${style?.border} shadow-md`
          : 'border-border',
      ].join(' ')}
    >
      {/* Accent */}
      <div
        className={[
          'absolute inset-y-0 inset-s-0 w-1',
          style?.accent ?? 'bg-foreground-muted',
        ].join(' ')}
      />

      <div className="flex min-h-28 items-center justify-between gap-5 p-5 ps-6">
        <div className="flex min-w-0 items-center gap-4">
          <div
            className={[
              'flex h-14 w-14 shrink-0 items-center justify-center border',
              isTotal
                ? 'border-border bg-surface-muted text-foreground-muted'
                : `${style?.soft} ${style?.border} ${style?.accentText}`,
            ].join(' ')}
          >
            <Icon size={25} strokeWidth={1.8} aria-hidden />
          </div>

          <div className="min-w-0">
            <p
              className={[
                'text-[11px] font-bold uppercase tracking-[0.18em]',
                style?.accentText ?? 'text-foreground-muted',
              ].join(' ')}
            >
              {label}
            </p>

            <h2 className="text-body mt-1 truncate font-bold">
              {isTotal ? t('nav.catalog') : t(`catalog.${department}`)}
            </h2>
          </div>
        </div>

        <div
          className={[
            'flex h-10 w-10 shrink-0 items-center justify-center border',
            isTotal
              ? 'border-border bg-surface-muted text-foreground-muted'
              : `${style?.mutedBorder} ${style?.accentText} ${
                  active ? style?.soft : 'bg-surface-muted'
                }`,
          ].join(' ')}
        >
          <span className="text-sm font-black">{count}</span>
        </div>
      </div>

      {/* Active indicator */}
      <div
        className={[
          'h-1 origin-start transition-transform duration-200',
          style?.accent ?? 'bg-foreground-muted',
          active ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100',
        ].join(' ')}
      />
    </button>
  )
}

/* ========================================================================== */
/* Select                                                                     */
/* ========================================================================== */

function CatalogSelect({
  value,
  onChange,
  children,
  ...props
}: {
  value: string
  onChange: (value: string) => void
  children: ReactNode
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>) {
  return (
    <select
      {...props}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={[
        'h-11 min-w-0 border border-border-strong bg-surface-input',
        'px-3 text-sm text-foreground',
        'outline-none transition-colors',
        'focus:border-primary focus:ring-1 focus:ring-primary',
      ].join(' ')}
    >
      {children}
    </select>
  )
}

function CreateCategoryDialog({
  existingCategories,
  onClose,
  onCreated,
}: {
  existingCategories: Category[]
  onClose: () => void
  onCreated: (name: string) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t('catalog.categoryNameRequired'))
      return
    }
    if (
      existingCategories.some(
        (category) => category.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
      )
    ) {
      setError(t('catalog.categoryNameTaken'))
      return
    }

    setBusy(true)
    try {
      await catalogApi.createCategory(trimmed)
      onCreated(trimmed)
    } catch (cause) {
      setError(errText(cause))
      toast(errText(cause), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={t('catalog.addCategory')}>
      <div className="flex flex-col gap-5">
        <Field label={t('catalog.categoryName')} error={error}>
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !busy) void save()
            }}
          />
        </Field>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={busy} loading={busy}>
            {!busy ? <Save size={16} aria-hidden /> : null}
            {t('app.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/* ========================================================================== */
/* New-item switch                                                            */
/* ========================================================================== */

/**
 * The "is this a new item?" control, shared by the Add and Edit dialogs so the
 * two can never drift apart.
 *
 * Accessibility: the visible label is associated with the switch via `htmlFor`,
 * so the control has a real accessible name in Arabic, and the switch itself is
 * a `role="switch"` button — reachable with Tab, toggled with Space or Enter,
 * and announcing its ON/OFF state. The hint spells out that this is a display
 * badge and does NOT affect availability, which is the question a manager
 * actually has when looking at this control.
 */
function NewItemSwitch({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (value: boolean) => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-surface-muted p-3">
      <div className="min-w-0">
        <Label
          htmlFor="catalog-is-new"
          className="block text-base font-bold text-foreground-strong"
        >
          {t('catalog.newItem')}
        </Label>
        <p className="text-caption mt-0.5">{t('catalog.newItemHint')}</p>
      </div>

      <Switch
        id="catalog-is-new"
        checked={checked}
        onCheckedChange={onChange}
        label={t('catalog.newItem')}
      />
    </div>
  )
}

/* ========================================================================== */
/* Create dialog                                                              */
/* ========================================================================== */

function CreateProductDialog({
  categories,
  onClose,
  onCreated,
}: {
  categories: Category[]
  onClose: () => void
  onCreated: (name: string) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)

  const [name, setName] = useState('')
  const [type, setType] = useState<ItemType>('PRODUCT')
  const [department, setDepartment] = useState<Department>('CAFE')
  const [price, setPrice] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [categoryError, setCategoryError] = useState<string | null>(null)
  const [tracked, setTracked] = useState(false)
  const [stockQuantity, setStockQuantity] = useState('0')
  const [stockError, setStockError] = useState<string | null>(null)
  // A brand-new catalog entry is the "new" case by default: the manager is
  // creating it right now, so badging it is what they almost always want.
  const [isNew, setIsNew] = useState(true)

  const [busy, setBusy] = useState(false)
  const [priceError, setPriceError] = useState<string | null>(null)

  const departmentStyle = departmentStyles[department]

  async function save() {
    const minor = parseMajor(price)

    if (!name.trim()) {
      return
    }

    if (minor === null) {
      setPriceError(t('catalog.invalidPrice'))
      return
    }

    if (!categoryId) {
      setCategoryError(t('catalog.categoryRequired'))
      return
    }

    const quantity = type === 'PRODUCT' && tracked ? parseStockQuantity(stockQuantity) : null
    if (type === 'PRODUCT' && tracked && quantity === null) {
      setStockError(t('catalog.invalidStock'))
      return
    }

    setBusy(true)

    try {
      const input: NewProductInput = {
        name: name.trim(),
        item_type: type,
        department,
        category_id: Number(categoryId),
        price_minor: minor,
        track_inventory: type === 'PRODUCT' && tracked,
        stock_quantity: quantity,
        is_new: isNew,
      }

      await catalogApi.create(input)

      onCreated(input.name)
    } catch (error) {
      toast(errText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={t('catalog.add')}>
      <div className="flex flex-col gap-5">
        {/* Identity preview */}
        <div
          className={[
            'relative overflow-hidden border p-4',
            departmentStyle.soft,
            departmentStyle.border,
          ].join(' ')}
        >
          <div className={['absolute inset-y-0 inset-s-0 w-1', departmentStyle.accent].join(' ')} />

          <div className="flex items-center gap-3 ps-2">
            <div
              className={[
                'flex h-11 w-11 items-center justify-center border bg-surface',
                departmentStyle.border,
                departmentStyle.accentText,
              ].join(' ')}
            >
              {department === 'CAFE' ? (
                <Coffee size={22} strokeWidth={1.8} aria-hidden />
              ) : (
                <Droplets size={22} strokeWidth={1.8} aria-hidden />
              )}
            </div>

            <div>
              <p
                className={[
                  'text-[10px] font-black uppercase tracking-[0.18em]',
                  departmentStyle.accentText,
                ].join(' ')}
              >
                {t(`catalog.${department}`)}
              </p>

              <p className="text-body mt-0.5 font-bold">{t(`catalog.${type}`)}</p>
            </div>
          </div>
        </div>

        <Field label={t('catalog.name')}>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('catalog.department')}>
            <select
              value={department}
              onChange={(event) => setDepartment(event.target.value as Department)}
              className="h-10 w-full border border-border-strong bg-surface-input px-3 text-base text-foreground outline-none focus:border-primary"
            >
              {DEPARTMENTS.map((value) => (
                <option key={value} value={value}>
                  {t(`catalog.${value}`)}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('catalog.type')}>
            <select
              value={type}
              onChange={(event) => {
                const value = event.target.value as ItemType
                setType(value)
                if (value === 'SERVICE') {
                  setTracked(false)
                  setStockError(null)
                }
              }}
              className="h-10 w-full border border-border-strong bg-surface-input px-3 text-base text-foreground outline-none focus:border-primary"
            >
              {TYPES.map((value) => (
                <option key={value} value={value}>
                  {t(`catalog.${value}`)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label={t('catalog.price')} error={priceError}>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={price}
            onChange={(event) => {
              setPrice(event.target.value)
              setPriceError(null)
            }}
            placeholder="0.00"
          />
        </Field>

        <Field label={t('catalog.category')} error={categoryError}>
          <select
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value)
              setCategoryError(null)
            }}
            className="h-10 w-full border border-border-strong bg-surface-input px-3 text-base text-foreground outline-none focus:border-primary"
          >
            <option value="">{t('catalog.selectCategory')}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </Field>
        {type === 'PRODUCT' ? (
          <label className="text-body flex items-center gap-2">
            <input
              type="checkbox"
              checked={tracked}
              onChange={(event) => {
                setTracked(event.target.checked)
                setStockError(null)
              }}
              className="h-4 w-4 accent-primary"
            />
            {t('inventory.trackItem')}
          </label>
        ) : null}

        <NewItemSwitch checked={isNew} onChange={setIsNew} />

        {type === 'PRODUCT' && tracked ? (
          <Field label={t('inventory.quantity')} error={stockError}>
            <Input
              dir="ltr"
              inputMode="numeric"
              value={stockQuantity}
              onChange={(event) => {
                setStockQuantity(event.target.value)
                setStockError(null)
              }}
              placeholder="0"
            />
            <p className="text-caption">{t('inventory.initialStockHint')}</p>
          </Field>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>

          <Button onClick={save} disabled={busy} loading={busy}>
            {!busy ? <Save size={16} aria-hidden /> : null}

            {t('app.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/* ========================================================================== */
/* Edit dialog                                                                */
/* ========================================================================== */

function EditProductDialog({
  product,
  categories,
  onClose,
  onSaved,
}: {
  product: Product
  categories: Category[]
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)

  const [name, setName] = useState(product.name)

  const [price, setPrice] = useState(formatMinorMoneyInput(product.price_minor))
  const [categoryId, setCategoryId] = useState(String(product.category_id))
  const [tracked, setTracked] = useState(product.track_inventory)
  const [stockQuantity, setStockQuantity] = useState(String(product.stock_quantity))
  // Seeded from the PERSISTED value, so editing never silently flips the flag.
  const [isNew, setIsNew] = useState(product.is_new)

  const [busy, setBusy] = useState(false)
  const [priceError, setPriceError] = useState<string | null>(null)
  const [categoryError, setCategoryError] = useState<string | null>(null)
  const [stockError, setStockError] = useState<string | null>(null)

  const department = product.department as Department
  const style = departmentStyles[department]

  async function save() {
    const minor = parseMajor(price)

    if (!name.trim()) {
      return
    }

    if (minor === null) {
      setPriceError(t('catalog.invalidPrice'))
      return
    }
    if (!categoryId) {
      setCategoryError(t('catalog.categoryRequired'))
      return
    }

    const quantity =
      product.item_type === 'PRODUCT' && tracked ? parseStockQuantity(stockQuantity) : null
    if (product.item_type === 'PRODUCT' && tracked && quantity === null) {
      setStockError(t('catalog.invalidStock'))
      return
    }

    setBusy(true)

    try {
      await catalogApi.update(product.id, {
        name: name.trim(),
        item_type: product.item_type,
        department: product.department,
        category_id: Number(categoryId),
        price_minor: minor,
        track_inventory: product.item_type === 'PRODUCT' && tracked,
        stock_quantity: quantity,
        is_new: isNew,
      })

      onSaved()
    } catch (error) {
      toast(errText(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={t('catalog.edit')}>
      <div className="flex flex-col gap-5">
        {/* Current identity */}
        <div
          className={['relative overflow-hidden border p-4', style.soft, style.border].join(' ')}
        >
          <div className={['absolute inset-y-0 inset-s-0 w-1', style.accent].join(' ')} />

          <div className="flex items-center gap-3 ps-2">
            <div
              className={[
                'flex h-11 w-11 items-center justify-center border bg-surface',
                style.border,
                style.accentText,
              ].join(' ')}
            >
              {department === 'CAFE' ? (
                <Coffee size={22} strokeWidth={1.8} aria-hidden />
              ) : (
                <Droplets size={22} strokeWidth={1.8} aria-hidden />
              )}
            </div>

            <div className="min-w-0">
              <p
                className={[
                  'text-[10px] font-black uppercase tracking-[0.18em]',
                  style.accentText,
                ].join(' ')}
              >
                {t(`catalog.${department}`)}
              </p>

              <p className="text-body mt-0.5 truncate font-bold">{product.name}</p>
            </div>
          </div>
        </div>

        <Field label={t('catalog.name')}>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        <Field label={t('catalog.category')} error={categoryError}>
          <select
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value)
              setCategoryError(null)
            }}
            className="h-10 w-full border border-border-strong bg-surface-input px-3 text-base text-foreground outline-none focus:border-primary"
          >
            <option value="">{t('catalog.selectCategory')}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </Field>
        {product.item_type === 'PRODUCT' ? (
          <label className="text-body flex items-center gap-2">
            <input
              type="checkbox"
              checked={tracked}
              onChange={(event) => {
                setTracked(event.target.checked)
                setStockError(null)
              }}
              className="h-4 w-4 accent-primary"
            />
            {t('inventory.trackItem')}
          </label>
        ) : null}

        <NewItemSwitch checked={isNew} onChange={setIsNew} />

        {product.item_type === 'PRODUCT' && tracked ? (
          <Field label={t('inventory.quantity')} error={stockError}>
            <Input
              dir="ltr"
              inputMode="numeric"
              value={stockQuantity}
              onChange={(event) => {
                setStockQuantity(event.target.value)
                setStockError(null)
              }}
              placeholder="0"
            />
            <p className="text-caption">{t('inventory.stockEditHint')}</p>
          </Field>
        ) : null}

        <Field label={t('catalog.price')} error={priceError}>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={price}
            onChange={(event) => {
              setPrice(event.target.value)
              setPriceError(null)
            }}
          />
        </Field>

        <p className="text-caption">{t('catalog.priceSnapshotHint')}</p>

        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>

          <Button onClick={save} disabled={busy} loading={busy}>
            {!busy ? <Save size={16} aria-hidden /> : null}

            {t('app.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
