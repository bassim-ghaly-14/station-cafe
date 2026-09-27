import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, MoneyDisplay, useToast } from '@/components/ui'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Plus, Save } from '@/components/ui/icon'
import { parseMajor } from '@/lib/utils'
import { opsApi, type Expense, type ExpenseCategory } from '@/services/opsApi'
import { useErrText } from '@/lib/err'

/**
 * Cashier expense entry, scoped to the caller's OPEN shift.
 *
 * The backend attaches the expense to the active shift and refuses a cashier
 * who has none, so this form never picks a shift and never decides whether a
 * spend affects the drawer — it only sends the amount, the category and
 * whether the money physically left the till. The category list, the Arabic
 * labels and the resulting totals all come from the backend.
 */
export function ShiftExpenseDialog({
  open,
  onClose,
  onCreated,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly onCreated: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [category, setCategory] = useState('')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [paidFromCash, setPaidFromCash] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    // Read from the backend category table, so a category can never be offered
    // here that the service would reject.
    opsApi
      .expenseCategories()
      .then((rows) => {
        setCategories(rows)
        setCategory((current) => current || (rows[0]?.code ?? ''))
      })
      .catch((e) => setError(errText(e)))
  }, [open, errText])

  async function save() {
    const minor = parseMajor(amount)
    if (minor === null || minor <= 0) {
      toast(t('errors.expenses.invalid_amount'), 'error')
      return
    }
    if (!category) {
      toast(t('errors.expenses.invalid_category'), 'error')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await opsApi.createExpense({
        category,
        amount: minor,
        description: description.trim() || null,
        is_recurring: false,
        paid_from_cash: paidFromCash,
      })
      toast(t('shift.expenseSaved'), 'success')
      setAmount('')
      setDescription('')
      onClose()
      await onCreated()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <Dialog open onClose={() => !busy && onClose()} title={t('shift.newExpense')}>
      <div className="flex flex-col gap-4">
        <Field label={t('expenses.category')} htmlFor="expense-category">
          <select
            id="expense-category"
            data-dialog-autofocus
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="h-10 w-full rounded-md border border-border-strong bg-surface-input px-3 text-base"
          >
            {categories.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name_ar}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('app.amount')} htmlFor="expense-amount">
          <Input
            id="expense-amount"
            dir="ltr"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </Field>

        <Field label={t('app.notes')} htmlFor="expense-note">
          <Textarea
            id="expense-note"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        {/* Only a CASH expense reduces the expected drawer. This checkbox states
            what physically happened; the backend decides the consequence. */}
        <label className="text-body flex items-center gap-2">
          <input
            type="checkbox"
            checked={paidFromCash}
            onChange={(e) => setPaidFromCash(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          {t('shift.paidFromCash')}
        </label>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
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

/** The expenses booked to the current shift, with the backend's own labels. */
export function ShiftExpenseList({ rows }: { rows: Expense[] | null }) {
  const { t } = useTranslation()
  if (rows === null) return null
  if (rows.length === 0) {
    return <p className="text-caption text-foreground-subtle">{t('shift.expenseEmpty')}</p>
  }
  return (
    <ul className="space-y-1">
      {rows.map((row) => (
        <li key={row.id} className="flex items-center justify-between gap-3 text-sm">
          <span className="min-w-0 truncate text-foreground-muted">{row.category_name}</span>
          <MoneyDisplay amount={row.amount} />
        </li>
      ))}
    </ul>
  )
}

export function AddExpenseButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <Plus size={16} aria-hidden />
      {t('shift.addExpense')}
    </Button>
  )
}
