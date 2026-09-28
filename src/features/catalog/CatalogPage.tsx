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
 *
 * Structure
 * ---------
 * This component is the page's ORCHESTRATOR: it owns the data, the dialog
 * lifecycle and the mutations, and it renders four cohesive sections. The
 * reasoning each section needs lives next to that section:
 *
 *   `catalogModel.ts`            the pure filtering / counting / category rules
 *   `useCatalogFilters.ts`       the five filter values and "clear them all"
 *   `CatalogHeader.tsx`          identity, counts and the management actions
 *   `CatalogFilterPanel.tsx`     search, narrowing selects, category navigation
 *   `CatalogResults.tsx`         the grid and its loading / error / empty states
 *   `CatalogDialogs.tsx`         every dialog, mounted by its own open flag
 *   `CatalogProductDialogs.tsx`  the category and product forms
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useToast } from '@/components/ui/toast'

import { useErrText } from '@/lib/err'
import { resolveVisibleCategories, useCategoryVisibility } from '@/lib/category-visibility'

import { catalogApi, type Category } from '@/services/catalogApi'
import type { Product } from '@/services/posApi'

import { useSession } from '@/features/auth/useSession'

import { CatalogDialogs } from './CatalogDialogs'
import { CatalogFilterPanel } from './CatalogFilterPanel'
import { CatalogHeader, CatalogOverview } from './CatalogHeader'
import { CatalogResults } from './CatalogResults'
import type { CatalogCategoryOption } from './CatalogCategoryFilter'
import {
  buildBarCategories,
  buildCategoryOptions,
  countCatalog,
  filterCatalogItems,
  resolveEffectiveCategoryId,
} from './catalogModel'
import { useCatalogFilters } from './useCatalogFilters'

export default function CatalogPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const { user } = useSession()

  const [items, setItems] = useState<Product[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const filters = useCatalogFilters()
  const { query, dept, setDept, type, status, categoryId, hasFilters, clearFilters } = filters

  const [createOpen, setCreateOpen] = useState(false)
  const [categoryCreateOpen, setCategoryCreateOpen] = useState(false)
  /** The category being renamed; `null` when no rename dialog is open. */
  const [editingCategory, setEditingCategory] = useState<Category | null>(null)
  /** The category awaiting delete confirmation. */
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null)
  const [categoryDeleting, setCategoryDeleting] = useState(false)
  const [categories, setCategories] = useState<Category[]>([])
  const [editing, setEditing] = useState<Product | null>(null)
  const [confirming, setConfirming] = useState<Product | null>(null)
  const [deleting, setDeleting] = useState<Product | null>(null)

  const canManageCatalog = user?.role === 'MANAGER' || user?.role === 'ADMIN'
  /**
   * Delete is narrower than manage: only an ADMIN may remove an item from the
   * catalog. This hides the affordance; the REAL boundary is the backend
   * command + service, which reject a MANAGER/STAFF call with an
   * authorization error even if the button were somehow triggered.
   */
  const canDeleteCatalog = user?.role === 'ADMIN'

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
  const categoryOptions = useMemo<CatalogCategoryOption[]>(
    () => buildCategoryOptions(items, categories),
    [categories, items],
  )

  const effectiveCategoryId = useMemo(
    () => resolveEffectiveCategoryId(categoryId, categoryOptions),
    [categoryId, categoryOptions],
  )

  /* ========================================================================== */
  /* Category bar visibility                                                     */
  /* ========================================================================== */

  /**
   * Which categories the primary bar shows. The preference is persisted (see
   * `lib/category-visibility.ts`), so it survives navigation, a refresh and an
   * application restart; until the cashier customizes it, the default keeps the
   * catalog's own order capped to the primary categories.
   */
  const categoryVisibility = useCategoryVisibility()

  /**
   * COMPACT (the default) shows only the pinned categories; EXPANDED shows them
   * all. Expansion is deliberately per-visit state: it is a temporary way to
   * reach a category, not a configuration the cashier chose to keep.
   */
  const [categoriesExpanded, setCategoriesExpanded] = useState(false)
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false)

  const pinnedCategories = useMemo(
    () => resolveVisibleCategories(categoryOptions, categoryVisibility),
    [categoryOptions, categoryVisibility],
  )

  const hiddenCategoryCount = categoryOptions.length - pinnedCategories.length

  const barCategories = useMemo(
    () =>
      buildBarCategories(
        categoriesExpanded ? categoryOptions : pinnedCategories,
        categoryOptions,
        effectiveCategoryId,
      ),
    [categoriesExpanded, categoryOptions, pinnedCategories, effectiveCategoryId],
  )

  const counts = useMemo(() => countCatalog(items), [items])

  const filtered = useMemo(
    () => filterCatalogItems(items, { query, effectiveCategoryId, dept, type, status }),
    [items, query, effectiveCategoryId, dept, type, status],
  )

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

  /**
   * The backend archives the item instead of removing its row, so historical
   * invoices, reports and stock movements keep showing the original name and
   * price. The confirmation states exactly that, so the ADMIN is never afraid
   * of destroying history.
   */
  async function deleteProduct(product: Product) {
    if (!canDeleteCatalog) {
      return
    }

    try {
      await catalogApi.remove(product.id)

      toast(t('catalog.deleted', { name: product.name }), 'success')

      setDeleting(null)
      load()
    } catch (error) {
      toast(errText(error), 'error')
    }
  }

  /**
   * Deleting a category is a real deletion, not the archive a product goes
   * through, so the domain rule lives in the backend: a category that still
   * holds products — or the built-in system category — is refused there, and
   * that Arabic business error is what the ADMIN reads here. The dialog only
   * records the intent; the service is the boundary.
   */
  async function deleteCategory(category: Category) {
    if (!canDeleteCatalog) {
      return
    }

    setCategoryDeleting(true)
    try {
      await catalogApi.removeCategory(category.id)

      toast(t('catalog.categoryDeleted', { name: category.name }), 'success')

      setDeletingCategory(null)
      // The category list feeds the selectors, the bar and the card badges, so
      // both reads are refreshed to keep the page self-consistent.
      loadCategories()
      load()
    } catch (error) {
      toast(errText(error), 'error')
    } finally {
      setCategoryDeleting(false)
    }
  }

  function closeCategoryDialog() {
    setCategoryCreateOpen(false)
    setEditingCategory(null)
  }

  function handleCategorySaved(name: string) {
    const wasEditing = editingCategory

    closeCategoryDialog()
    toast(
      t(wasEditing ? 'catalog.categoryUpdated' : 'catalog.categoryCreated', { name }),
      'success',
    )
    // The bar, the selectors and the card badges all read categories, so
    // both lists are refreshed; the grid is too, because a rename changes
    // the category name every card shows.
    loadCategories()
    if (wasEditing) {
      load()
    }
  }

  function handleProductCreated(name: string) {
    setCreateOpen(false)
    toast(t('catalog.created', { name }), 'success')
    load()
  }

  function handleProductSaved() {
    setEditing(null)
    toast(t('catalog.saved'), 'success')
    load()
  }

  return (
    <div className="flex flex-col gap-6">
      <CatalogHeader
        resultCount={filtered.length}
        activeCount={counts.active}
        canManageCatalog={canManageCatalog}
        onAddProduct={() => setCreateOpen(true)}
        onAddCategory={() => setCategoryCreateOpen(true)}
      />

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

      <CatalogFilterPanel
        filters={filters}
        barCategories={barCategories}
        effectiveCategoryId={effectiveCategoryId}
        resultCount={filtered.length}
        totalCount={counts.total}
        hiddenCategoryCount={hiddenCategoryCount}
        categoriesExpanded={categoriesExpanded}
        onToggleExpanded={() => setCategoriesExpanded((current) => !current)}
        onOpenCategoryManager={() => setCategoryManagerOpen(true)}
      />

      <CatalogResults
        items={items}
        loadError={loadError}
        filtered={filtered}
        hasFilters={hasFilters}
        canManageCatalog={canManageCatalog}
        canDeleteCatalog={canDeleteCatalog}
        onRetry={load}
        onClearFilters={clearFilters}
        onEdit={setEditing}
        onToggle={setConfirming}
        onDelete={setDeleting}
      />

      <CatalogDialogs
        canManageCatalog={canManageCatalog}
        canDeleteCatalog={canDeleteCatalog}
        categories={categories}
        categoryOptions={categoryOptions}
        categoryManagerOpen={categoryManagerOpen}
        onCloseCategoryManager={() => setCategoryManagerOpen(false)}
        onEditCategory={setEditingCategory}
        onRequestDeleteCategory={setDeletingCategory}
        categoryCreateOpen={categoryCreateOpen}
        editingCategory={editingCategory}
        onCloseCategoryDialog={closeCategoryDialog}
        onCategorySaved={handleCategorySaved}
        deletingCategory={deletingCategory}
        categoryDeleting={categoryDeleting}
        onCloseDeleteCategory={() => setDeletingCategory(null)}
        onDeleteCategory={deleteCategory}
        createOpen={createOpen}
        onCloseCreate={() => setCreateOpen(false)}
        onProductCreated={handleProductCreated}
        editing={editing}
        onCloseEditing={() => setEditing(null)}
        onProductSaved={handleProductSaved}
        confirming={confirming}
        onCloseConfirming={() => setConfirming(null)}
        onToggleActive={toggleActive}
        deleting={deleting}
        onCloseDeleting={() => setDeleting(null)}
        onDeleteProduct={deleteProduct}
      />
    </div>
  )
}
