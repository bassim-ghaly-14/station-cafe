/**
 * Every dialog and confirmation the catalog page can open.
 *
 * They are gathered in ONE place because they share a single lifecycle: each is
 * mounted only while its own piece of state says it is open, and each closes by
 * clearing exactly that state. Keeping them together makes that pairing visible
 * — an "open" flag and the element it mounts are always the same decision.
 *
 * The page still OWNS the state and the mutations; this component only decides
 * what is mounted and forwards the intent upward.
 */
import { useTranslation } from 'react-i18next'

import { Button, ConfirmDialog, Dialog, DialogActions } from '@/components/ui'
import { Check, Trash2 } from '@/components/ui/icon'

import { CatalogCategoryManagerDrawer } from './CatalogCategoryManagerDrawer'
import type { CatalogCategoryOption } from './CatalogCategoryFilter'
import { CategoryDialog, CreateProductDialog, EditProductDialog } from './CatalogProductDialogs'
import type { Category } from '@/services/catalogApi'
import type { Product } from '@/services/posApi'

export interface CatalogDialogsProps {
  readonly canManageCatalog: boolean
  readonly canDeleteCatalog: boolean

  readonly categories: Category[]
  readonly categoryOptions: CatalogCategoryOption[]

  readonly categoryManagerOpen: boolean
  readonly onCloseCategoryManager: () => void
  readonly onEditCategory: (category: Category) => void
  readonly onRequestDeleteCategory: (category: Category) => void

  readonly categoryCreateOpen: boolean
  readonly editingCategory: Category | null
  readonly onCloseCategoryDialog: () => void
  readonly onCategorySaved: (name: string) => void

  readonly deletingCategory: Category | null
  readonly categoryDeleting: boolean
  readonly onCloseDeleteCategory: () => void
  /**
   * The page's own mutation: it awaits the backend command, toasts the outcome
   * and closes the confirmation. It is asynchronous, so the type says so and the
   * confirm handler simply hands the category over.
   */
  readonly onDeleteCategory: (category: Category) => Promise<void>

  readonly createOpen: boolean
  readonly onCloseCreate: () => void
  readonly onProductCreated: (name: string) => void

  readonly editing: Product | null
  readonly onCloseEditing: () => void
  readonly onProductSaved: () => void

  readonly confirming: Product | null
  readonly onCloseConfirming: () => void
  readonly onToggleActive: (product: Product) => void

  readonly deleting: Product | null
  readonly onCloseDeleting: () => void
  readonly onDeleteProduct: (product: Product) => void
}

export function CatalogDialogs({
  canManageCatalog,
  canDeleteCatalog,
  categories,
  categoryOptions,
  categoryManagerOpen,
  onCloseCategoryManager,
  onEditCategory,
  onRequestDeleteCategory,
  categoryCreateOpen,
  editingCategory,
  onCloseCategoryDialog,
  onCategorySaved,
  deletingCategory,
  categoryDeleting,
  onCloseDeleteCategory,
  onDeleteCategory,
  createOpen,
  onCloseCreate,
  onProductCreated,
  editing,
  onCloseEditing,
  onProductSaved,
  confirming,
  onCloseConfirming,
  onToggleActive,
  deleting,
  onCloseDeleting,
  onDeleteProduct,
}: CatalogDialogsProps) {
  const { t } = useTranslation()

  return (
    <>
      {/* Every role may arrange the catalog bar: it changes presentation only,
          never what can be filtered or sold, so it is not a manager action. The
          per-row category actions are passed ONLY to the roles that may perform
          them, so a MANAGER sees rename without delete and a STAFF sees neither. */}
      <CatalogCategoryManagerDrawer
        open={categoryManagerOpen}
        onClose={onCloseCategoryManager}
        categories={categoryOptions}
        onEditCategory={canManageCatalog ? onEditCategory : undefined}
        onDeleteCategory={canDeleteCatalog ? onRequestDeleteCategory : undefined}
      />

      {canManageCatalog && (categoryCreateOpen || editingCategory) ? (
        <CategoryDialog
          existingCategories={categories}
          category={editingCategory}
          onClose={onCloseCategoryDialog}
          onSaved={onCategorySaved}
        />
      ) : null}

      {/*
        The confirmation for the one irreversible category action. It is mounted
        only for a role that may have the delete, and it is an interaction
        affordance rather than the boundary: a caller that invokes
        `delete_category` directly bypasses it entirely and is refused by the
        service anyway.
      */}
      {canDeleteCatalog ? (
        <ConfirmDialog
          open={deletingCategory !== null}
          onClose={onCloseDeleteCategory}
          onConfirm={async () => {
            // The page owns the mutation and its outcome (toast, close, refresh),
            // so the confirmation only forwards the intent and awaits it.
            if (deletingCategory) {
              await onDeleteCategory(deletingCategory)
            }
          }}
          title={t('catalog.deleteCategoryTitle')}
          body={t('catalog.deleteCategoryConfirm', { name: deletingCategory?.name ?? '' })}
          detail={t('catalog.deleteCategoryHint')}
          confirmLabel={t('catalog.delete')}
          destructive
          busy={categoryDeleting}
        />
      ) : null}

      {canManageCatalog && createOpen ? (
        <CreateProductDialog
          categories={categories}
          onClose={onCloseCreate}
          onCreated={onProductCreated}
        />
      ) : null}

      {canManageCatalog && editing ? (
        <EditProductDialog
          product={editing}
          categories={categories}
          onClose={onCloseEditing}
          onSaved={onProductSaved}
        />
      ) : null}

      {canManageCatalog ? (
        <Dialog
          open={confirming !== null}
          onClose={onCloseConfirming}
          title={t('catalog.confirmToggle')}
        >
          <p className="text-body mb-4">
            {t('catalog.confirmToggleBody', {
              name: confirming?.name ?? '',
              next: confirming?.is_active ? t('catalog.inactive') : t('catalog.active'),
            })}
          </p>

          <DialogActions>
            <Button variant="outline" onClick={onCloseConfirming}>
              {t('app.cancel')}
            </Button>

            <Button
              variant={confirming?.is_active ? 'destructive' : 'default'}
              onClick={() => {
                if (confirming) {
                  onToggleActive(confirming)
                }
              }}
            >
              <Check size={16} aria-hidden />
              {t('app.confirm')}
            </Button>
          </DialogActions>
        </Dialog>
      ) : null}

      {canDeleteCatalog ? (
        <Dialog open={deleting !== null} onClose={onCloseDeleting} title={t('catalog.deleteTitle')}>
          <p className="text-body mb-4">
            {t('catalog.deleteConfirm', { name: deleting?.name ?? '' })}
          </p>

          <p className="text-caption mb-4">{t('catalog.deleteHistoryHint')}</p>

          <DialogActions>
            <Button variant="outline" onClick={onCloseDeleting}>
              {t('app.cancel')}
            </Button>

            <Button
              variant="destructive"
              onClick={() => {
                if (deleting) {
                  onDeleteProduct(deleting)
                }
              }}
            >
              <Trash2 size={16} aria-hidden />
              {t('catalog.delete')}
            </Button>
          </DialogActions>
        </Dialog>
      ) : null}
    </>
  )
}
