/**
 * المصروفات — the expenses workspace.
 *
 * Structured like the sales page, because it is the same application and a
 * manager should not have to learn the layout twice:
 *
 *  - ONE period control at the top scopes the whole page. There is no second
 *    date filter hiding inside a section, so the headline, the chart, the
 *    category ranking and the records underneath always describe the same days;
 *  - every number is an aggregate the backend computed in SQL
 *    (`expenses_overview`). The list is page-capped, so nothing on this page is
 *    ever summed in React;
 *  - the plot is the SHARED `DailyBarChart` and the ranking is the SHARED
 *    `ProportionCard` — the same components the sales page uses, so the two
 *    pages cannot drift apart on axes, tooltips, colours, fullscreen or exports;
 *
 * Reading order: what the period cost, how it moved over time, where it went,
 * then the individual records behind it. Money, movement, composition, evidence.
 *
 * It is also honest about what expenses are NOT: there is no margin and no
 * comparison against revenue here, because Station stores no cost of goods. A
 * profit figure would be a fabrication, so none is offered.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState } from '@/components/states'
import { ChartEmptyState } from '@/features/reports/charts/ChartEmptyState'
import {
  Badge,
  Button,
  Card,
  DatePicker,
  DateRangePicker,
  Dialog,
  DisplayDate,
  EmployeeAvatar,
  ListRowsSkeleton,
  MoneyDisplay,
  ProgressBar,
} from '@/components/ui'
import { Field, Input, Switch, Textarea } from '@/components/ui/input'
import { Plus, Receipt, Save } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useErrText } from '@/lib/err'
import { formatDate, todayIso } from '@/lib/date'
import { parseMajor } from '@/lib/utils'
import { atLeast, useOptionalSession } from '@/features/auth/useSession'
import { opsApi, type Expense, type ExpenseCategory } from '@/services/opsApi'
import { ExpensesCategoryCard, ExpensesKpiBand } from './ExpensesKpiBand'
import { ExpenseCategoriesDialog } from './ExpenseCategoriesDialog'
import { ExpensesDailyChart } from './ExpensesDailyChart'
import { useExpensesData } from './useExpensesData'

const RANGE_KEY = 'station.expenses.dateRange'

/**
 * The default period. Management opens this page to answer "what are we
 * spending", so it opens on the current month — a wider window than the sales
 * page's single day, because a spend is not a daily event — and remembers the
 * last explicit choice, exactly like the sales page does.
 */
function initialRange(): { from: string; to: string } {
  const today = todayIso()
  const monthStart = `${today.slice(0, 7)}-01`
  try {
    const stored = localStorage.getItem(RANGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as { from?: unknown; to?: unknown }
      if (typeof parsed.from === 'string' && typeof parsed.to === 'string') {
        return { from: parsed.from, to: parsed.to }
      }
    }
  } catch {
    /* fall back to the current month */
  }
  return { from: monthStart, to: today }
}

export default function ExpensesPage() {
  const { t } = useTranslation()
  const toast = useToast()
  // The session is read here, and HERE only, so the role behind every
  // affordance on this page is decided in one place instead of being re-derived
  // per component.
  const session = useOptionalSession()
  const [range, setRange] = useState(initialRange)
  const [createOpen, setCreateOpen] = useState(false)
  const [categoriesOpen, setCategoriesOpen] = useState(false)

  /**
   * The expense vocabulary is a MANAGER's to maintain: creating and renaming a
   * category are ordinary edits, so the manager owns them. Permanent removal is
   * narrower — only an ADMIN may delete — so the destructive action is not
   * rendered for anyone else rather than rendered disabled.
   *
   * Neither flag is the security boundary: the backend command AND the service
   * behind it refuse anything unauthorized whatever the user was shown.
   */
  const canManageCategories = atLeast(session?.user?.role, 'MANAGER')
  const canDeleteCategories = session?.user?.role === 'ADMIN'

  // Only the PERIOD is remembered; the records themselves are never persisted.
  useEffect(() => {
    localStorage.setItem(RANGE_KEY, JSON.stringify(range))
  }, [range])

  const data = useExpensesData(range.from, range.to)
  const overview = data.overview
  const empty = overview !== null && overview.expenses_count === 0
  // The window the daily chart states on its card and prints in its export: the
  // SAME `from`/`to` `useExpensesData` read the overview with, so the chart can
  // never describe a different period than the KPIs and the list beside it.
  const period = `${formatDate(range.from)} — ${formatDate(range.to)}`

  const refresh = useCallback(() => data.reload(), [data])

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-heading flex items-center gap-2">
            <Receipt size={22} aria-hidden />
            {t('nav.expenses')}
          </h1>
          <p className="mt-0.5 text-caption text-foreground-subtle">{t('expenses.subtitle')}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {/* Category management is a MANAGER affordance; the dialog it opens
              carries the narrower, ADMIN-only delete for the row. */}
          {canManageCategories ? (
            <Button variant="outline" onClick={() => setCategoriesOpen(true)}>
              {t('expenses.manageCategories')}
            </Button>
          ) : null}

          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={16} aria-hidden />
            {t('expenses.add')}
          </Button>
        </div>
      </header>

      {/* THE period control of this page. Everything below reads it. */}
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker
          from={range.from}
          to={range.to}
          onChange={({ from, to }) => setRange({ from, to })}
        />
        {data.refreshing ? <ProgressBar label={t('app.loading')} className="w-24" /> : null}
      </div>

      {data.initialLoading ? (
        <ListRowsSkeleton rows={5} />
      ) : data.error && !overview ? (
        <ErrorState message={data.error} onRetry={refresh} retryLabel={t('app.retry')} />
      ) : empty ? (
        /* A period with no spending is a real, calm answer — not an error, and
           not a chart drawn around an empty dataset. */
        <ChartEmptyState
          title={t('expenses.states.noExpensesTitle')}
          body={t('expenses.states.noExpensesBody')}
          hint={t('expenses.states.noExpensesHint')}
          scope={t('expenses.states.scope', { from: range.from, to: range.to })}
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={16} aria-hidden />
              {t('expenses.add')}
            </Button>
          }
        />
      ) : (
        <>
          <ExpensesKpiBand overview={overview} loading={data.refreshing} />

          {/* A re-fetch keeps the previous numbers on screen and marks the
              surfaces busy, so changing the period is not a full-page flash. */}
          {data.refreshing ? <ProgressBar label={t('app.loading')} /> : null}

          {overview ? (
            <>
              <ExpensesDailyChart overview={overview} period={period} />
              <ExpensesCategoryCard overview={overview} />
            </>
          ) : null}

          {/* The evidence behind the numbers, always reachable. */}
          <Card className="overflow-hidden p-0">
            <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
              <div>
                <h2 className="text-section text-foreground-strong">{t('expenses.list.title')}</h2>
                <p className="mt-0.5 text-caption text-foreground-subtle">
                  {t('expenses.list.hint')}
                </p>
              </div>
              {data.refreshing ? <ProgressBar label={t('app.loading')} className="w-24" /> : null}
            </div>
            <ExpenseList rows={data.rows} />
          </Card>
        </>
      )}

      {createOpen ? (
        <CreateExpenseDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false)
            toast(t('expenses.created'), 'success')
            refresh()
          }}
        />
      ) : null}

      {categoriesOpen ? (
        <ExpenseCategoriesDialog
          open
          onClose={() => setCategoriesOpen(false)}
          onChanged={refresh}
          canDelete={canDeleteCategories}
        />
      ) : null}
    </div>
  )
}

/** The records themselves. Purely presentational — no total is derived here. */
function ExpenseList({ rows }: { rows: Expense[] }) {
  const { t } = useTranslation()

  if (rows.length === 0) {
    return (
      <div className="p-4">
        <EmptyState title={t('expenses.list.empty')} />
      </div>
    )
  }

  return (
    <ul className="divide-y divide-border-subtle">
      {rows.map((row) => (
        <li key={row.id}>
          <Card className="flex flex-wrap items-center gap-3 rounded-none border-0 py-3 shadow-none">
            <div className="min-w-40 flex-1">
              {/* The Arabic category name is resolved by the backend. */}
              <p className="text-body font-bold">{row.category_name}</p>

              <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption">
                <DisplayDate value={row.expense_date} />
                {row.is_recurring ? <span>· {t(`expenses.rec.${row.recurrence}`)}</span> : null}
                {row.user_name ? (
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <span aria-hidden>·</span>
                    <EmployeeAvatar role={row.user_role} size="sm" />
                    <span className="truncate">{row.user_name}</span>
                  </span>
                ) : null}
              </p>

              {row.description ? <p className="text-caption mt-1">{row.description}</p> : null}
            </div>

            {row.is_recurring ? (
              <Badge variant="info" size="sm" dot>
                {t('expenses.recurring')}
              </Badge>
            ) : null}

            <MoneyDisplay amount={row.amount} className="text-money min-w-24" />
          </Card>
        </li>
      ))}
    </ul>
  )
}

function CreateExpenseDialog({
  onClose,
  onCreated,
}: {
  readonly onClose: () => void
  readonly onCreated: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)

  // Categories are DATA, read from the backend `expense_categories` table —
  // never a hardcoded list, so the UI can never offer a category the service
  // would reject, and a new category appears without a frontend change.
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [category, setCategory] = useState('')

  useEffect(() => {
    opsApi
      .expenseCategories()
      .then((rows) => {
        setCategories(rows)
        setCategory((current) => current || (rows[0]?.code ?? ''))
      })
      .catch((e) => toast(errText(e), 'error'))
  }, [errText, toast])

  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')

  // A new expense owns ONE business date — the user's local today, not a UTC day.
  const [date, setDate] = useState<string>(todayIso)

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
        {/* Business date comes first */}
        <Field label={t('app.date')}>
          <DatePicker value={date} onChange={setDate} />
        </Field>

        <Field label={t('expenses.category')}>
          <select
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

        <Field label={t('app.amount')}>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </Field>

        <Field label={t('app.notes')}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        {/* The shared Switch, so this boolean reads exactly like every other
            toggle in the app. The visible Arabic text stays the control's
            name; the switch carries the same label for assistive tech, so the
            state is never conveyed by position or color alone. */}
        <div className="text-body flex items-center gap-2">
          <Switch
            tone="state"
            checked={recurring}
            onCheckedChange={setRecurring}
            label={t('expenses.recurring')}
          />
          <span>{t('expenses.recurring')}</span>
        </div>

        {recurring ? (
          <Field label={t('expenses.recurrence')}>
            <select
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value as typeof recurrence)}
              className="h-10 w-full rounded-md border border-border-strong bg-surface-input px-3 text-base"
            >
              <option value="WEEKLY">{t('expenses.rec.WEEKLY')}</option>
              <option value="MONTHLY">{t('expenses.rec.MONTHLY')}</option>
            </select>
          </Field>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
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
