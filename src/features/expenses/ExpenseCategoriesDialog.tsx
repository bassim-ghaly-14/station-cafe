/**
 * فئات المصروف — the expense-category vocabulary the manager maintains.
 *
 * Who sees what is decided by the PAGE, which passes the current role's
 * capability in, and by the backend, which refuses anything unauthorized
 * regardless. A role that may not perform an action never sees its button,
 * rather than seeing a disabled one it cannot use.
 *
 * Behavior
 * --------
 * - Every category is listed, exactly as the backend orders it. This is the
 *   same list the create-expense dialog offers, so a category added here is
 *   immediately selectable there.
 * - Creation and renaming are ordinary edits. Renaming relabels the category
 *   from today onwards: past expenses keep their link because the backend keys
 *   them by the category CODE, never by its name.
 * - Deletion is a different, narrower act, so it is a separate affordance and
 *   it goes through the SHARED confirmation dialog, like every other permanent
 *   removal in the app. A refusal from the backend — a category that still
 *   holds expenses, or a system one — is surfaced in Arabic and costs the admin
 *   nothing.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, ConfirmDialog, Dialog, useToast } from '@/components/ui'
import { Input } from '@/components/ui/input'
import { Check, Pencil, Plus, Trash2, X } from '@/components/ui/icon'
import { useErrText } from '@/lib/err'
import { opsApi, type ExpenseCategory } from '@/services/opsApi'

export function ExpenseCategoriesDialog({
  open,
  onClose,
  onChanged,
  /**
   * ADMIN-only removal, decided by the PAGE so the role lives in one place.
   * When it is false the destructive action is NOT RENDERED at all — it is not
   * disabled — and the backend refuses the call regardless.
   */
  canDelete,
}: {
  open: boolean
  onClose: () => void
  /** Called after any accepted change, so the page can refresh its own reads. */
  onChanged: () => void
  canDelete: boolean
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)

  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  /** The category being renamed, or `null` when no row is in edit mode. */
  const [editing, setEditing] = useState<ExpenseCategory | null>(null)
  const [editName, setEditName] = useState('')
  /** The category awaiting delete confirmation. */
  const [deleting, setDeleting] = useState<ExpenseCategory | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setCategories(await opsApi.expenseCategories())
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setLoading(false)
    }
  }, [errText, toast])

  useEffect(() => {
    if (!open) return
    setDraft('')
    setEditing(null)
    setDeleting(null)
    void load()
  }, [open, load])

  async function add() {
    const name = draft.trim()
    if (!name) return
    setBusy(true)
    try {
      await opsApi.createExpenseCategory(name)
      toast(t('expenses.categoryCreated', { name }), 'success')
      setDraft('')
      await load()
      onChanged()
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function saveRename() {
    if (!editing) return
    const name = editName.trim()
    if (!name) return
    setBusy(true)
    try {
      await opsApi.renameExpenseCategory(editing.code, name)
      toast(t('expenses.categoryUpdated', { name }), 'success')
      setEditing(null)
      await load()
      onChanged()
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    setBusy(true)
    try {
      await opsApi.deleteExpenseCategory(deleting.code)
      toast(t('expenses.categoryDeleted', { name: deleting.name_ar }), 'success')
      setDeleting(null)
      await load()
      onChanged()
    } catch (e) {
      // The dialog stays open with the category still named, so a refused
      // deletion never costs the admin their place.
      toast(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('expenses.manageCategories')}>
      <div className="flex flex-col gap-4">
        <p className="text-caption text-foreground-subtle">{t('expenses.manageCategoriesHint')}</p>

        {/* Creation: a MANAGER action, and the whole form is one line. */}
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="text-caption mb-1 block" htmlFor="expense-category-name">
              {t('expenses.categoryName')}
            </label>
            <Input
              id="expense-category-name"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add()
              }}
              placeholder={t('expenses.categoryNamePlaceholder')}
            />
          </div>
          <Button onClick={() => void add()} disabled={busy || !draft.trim()} loading={busy}>
            {!busy ? <Plus size={16} aria-hidden /> : null}
            {t('expenses.addCategory')}
          </Button>
        </div>

        {categories.length === 0 && !loading ? (
          <p className="text-caption">{t('expenses.noCategories')}</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {categories.map((category) => {
              const isEditing = editing?.code === category.code
              return (
                <li key={category.code} className="flex items-center gap-2 py-2">
                  {isEditing ? (
                    <>
                      <Input
                        className="flex-1"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        aria-label={t('expenses.editCategory')}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => void saveRename()}
                        disabled={busy || !editName.trim()}
                        aria-label={t('app.save')}
                        data-testid="expense-category-save"
                      >
                        <Check size={16} aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setEditing(null)}
                        aria-label={t('app.cancel')}
                      >
                        <X size={16} aria-hidden />
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 truncate font-bold">{category.name_ar}</span>

                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                          setEditing(category)
                          setEditName(category.name_ar)
                        }}
                        aria-label={t('expenses.editCategoryAction', { name: category.name_ar })}
                        data-testid="expense-category-edit"
                      >
                        <Pencil size={16} aria-hidden />
                      </Button>

                      {/* The destructive action is rendered only for the role
                          that may perform it, and opens the shared confirmation
                          rather than deleting on a single click. */}
                      {canDelete ? (
                        <Button
                          variant="destructiveGhost"
                          size="icon-sm"
                          onClick={() => setDeleting(category)}
                          aria-label={t('expenses.deleteCategoryAction', {
                            name: category.name_ar,
                          })}
                          data-testid="expense-category-delete"
                        >
                          <Trash2 size={16} aria-hidden />
                        </Button>
                      ) : null}
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            {t('app.close')}
          </Button>
        </div>
      </div>

      {deleting ? (
        <ConfirmDialog
          open
          onClose={() => setDeleting(null)}
          onConfirm={() => void confirmDelete()}
          title={t('expenses.deleteCategory')}
          body={t('expenses.deleteCategoryConfirm', { name: deleting.name_ar })}
          detail={t('expenses.deleteCategoryHint')}
          confirmLabel={t('expenses.deleteCategory')}
          destructive
          busy={busy}
        />
      ) : null}
    </Dialog>
  )
}
