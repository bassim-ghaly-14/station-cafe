/** Manager expenses UI — list, filter by date, create. Backend authoritative. */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState, LoadingState } from '@/components/states'
import { Badge, Button, Card, Dialog, MoneyDisplay } from '@/components/ui'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Plus, Receipt } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { parseMajor, sumAmounts } from '@/lib/utils'
import { EXPENSE_CATEGORIES, opsApi, type Expense } from '@/services/opsApi'
import { useErrText } from '@/lib/err'

export default function ExpensesPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [rows, setRows] = useState<Expense[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [createOpen, setCreateOpen] = useState(false)

  const load = useCallback(() => {
    setLoadError(null)
    opsApi
      .expenses(from || undefined, to || undefined)
      .then(setRows)
      .catch((e) => {
        setLoadError(errText(e))
        toast(errText(e), 'error')
      })
  }, [from, to, toast, errText])

  useEffect(() => {
    load()
  }, [load])

  const total = useMemo(() => sumAmounts((rows ?? []).map((r) => r.amount)), [rows])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-heading flex items-center gap-2">
          <Receipt size={22} aria-hidden />
          {t('nav.expenses')}
        </h1>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus size={16} aria-hidden />
          {t('expenses.add')}
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('expenses.from')}>
          <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={t('expenses.to')}>
          <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <div className="ms-auto text-right">
          <p className="text-caption">{t('expenses.total')}</p>
          <MoneyDisplay amount={total} className="text-money text-brand-800" />
        </div>
      </div>

      {rows === null ? (
        loadError ? (
          <ErrorState message={loadError} onRetry={load} retryLabel={t('app.retry')} />
        ) : (
          <LoadingState label={t('app.loading')} />
        )
      ) : rows.length === 0 ? (
        <EmptyState title={t('expenses.empty')} />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <Card key={r.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-40 flex-1">
                <p className="text-body font-bold">{t(`expenses.cat.${r.category}`)}</p>
                <p className="text-caption" dir="ltr">
                  {r.expense_date}
                  {r.is_recurring ? ` · ${t(`expenses.rec.${r.recurrence}`)}` : ''}
                  {r.user_name ? ` · ${r.user_name}` : ''}
                </p>
                {r.description ? <p className="text-caption mt-1">{r.description}</p> : null}
              </div>
              {r.is_recurring ? <Badge tone="info">{t('expenses.recurring')}</Badge> : null}
              <MoneyDisplay amount={r.amount} className="text-money min-w-24" />
            </Card>
          ))}
        </div>
      )}
      {createOpen ? (
        <CreateExpenseDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false)
            toast(t('expenses.created'), 'success')
            load()
          }}
        />
      ) : null}
    </div>
  )
}

function CreateExpenseDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [category, setCategory] = useState<(typeof EXPENSE_CATEGORIES)[number]>('SUPPLIES')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [recurring, setRecurring] = useState(false)
  const [recurrence, setRecurrence] = useState<'WEEKLY' | 'MONTHLY'>('MONTHLY')
  const [busy, setBusy] = useState(false)

  async function save() {
    const minor = parseMajor(amount)
    if (minor === null || minor <= 0) {
      toast(t('errors.expenses.invalid_amount'), 'error')
      return
    }
    setBusy(true)
    try {
      await opsApi.createExpense({
        category,
        amount: minor,
        description: description.trim() || null,
        expense_date: date || null,
        is_recurring: recurring,
        recurrence: recurring ? recurrence : null,
      })
      onCreated()
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={t('expenses.add')}>
      <div className="flex flex-col gap-4">
        <Field label={t('expenses.category')}>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as typeof category)}
            className="h-10 w-full rounded-md border border-brand-300 bg-surface-raised px-3 text-base"
          >
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`expenses.cat.${c}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('app.amount')}>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </Field>
        <Field label={t('app.date')}>
          <Input type="date" dir="ltr" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label={t('app.notes')}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <label className="text-body flex items-center gap-2">
          <input
            type="checkbox"
            checked={recurring}
            onChange={(e) => setRecurring(e.target.checked)}
            className="h-4 w-4 accent-brand-700"
          />
          {t('expenses.recurring')}
        </label>
        {recurring ? (
          <Field label={t('expenses.recurrence')}>
            <select
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value as typeof recurrence)}
              className="h-10 w-full rounded-md border border-brand-300 bg-surface-raised px-3 text-base"
            >
              <option value="WEEKLY">{t('expenses.rec.WEEKLY')}</option>
              <option value="MONTHLY">{t('expenses.rec.MONTHLY')}</option>
            </select>
          </Field>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button onClick={save} disabled={busy}>
            {t('app.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
