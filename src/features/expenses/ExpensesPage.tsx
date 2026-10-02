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
import type { TFunction } from 'i18next'
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
  DialogActions,
  DisplayDate,
  EmployeeAvatar,
  ListRowsSkeleton,
  MoneyDisplay,
  ProgressBar,
} from '@/components/ui'
import { Field, Input, Switch, Textarea } from '@/components/ui/input'
import type { DateRange } from '@/components/ui/date-range-picker'
import { Plus, Receipt, Save } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useErrText } from '@/lib/err'
import { formatDate, todayIso } from '@/lib/date'
import { parseMajor } from '@/lib/utils'
import { atLeast, useOptionalSession } from '@/features/auth/useSession'
import { opsApi, type Expense, type ExpenseCategory, type ExpenseOverview } from '@/services/opsApi'
import { ExpensesCategoryCard, ExpensesKpiBand } from './ExpensesKpiBand'
import { ExpenseCategoriesDialog } from './ExpenseCategoriesDialog'
import { ExpenseEmployeeField } from './ExpenseEmployeeField'
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

/**
 * The body below the period control: the loading, failure, empty and loaded
 * presentations, in that order. Extracted so the chain is stated once and the
 * page reads as header + filters + body.
 */
function ExpensesBody({
  t,
  initialLoading,
  error,
  empty,
  overview,
  refreshing,
  rows,
  range,
  period,
  onRetry,
  onAdd,
}: Readonly<{
  readonly t: TFunction
  readonly initialLoading: boolean
  readonly error: string | null
  readonly empty: boolean
  readonly overview: ExpenseOverview | null
  readonly refreshing: boolean
  readonly rows: Expense[]
  readonly range: DateRange
  readonly period: string
  readonly onRetry: () => void
  readonly onAdd: () => void
}>) {
  if (initialLoading) {
    return <ListRowsSkeleton rows={5} />
  }

  if (error && !overview) {
    return <ErrorState message={error} onRetry={onRetry} retryLabel={t('app.retry')} />
  }

  if (empty) {
    /* A period with no spending is a real, calm answer — not an error, and
       not a chart drawn around an empty dataset. */
    return (
      <ChartEmptyState
        title={t('expenses.states.noExpensesTitle')}
        /* The body names the window it is talking about, so it takes the SAME two
           dates the scope line under it does — without them the sentence would
           read "no expense was recorded between {{from}} and {{to}}". */
        body={t('expenses.states.noExpensesBody', { from: range.from, to: range.to })}
        hint={t('expenses.states.noExpensesHint')}
        scope={t('expenses.states.scope', { from: range.from, to: range.to })}
        action={
          <Button onClick={onAdd}>
            <Plus size={16} aria-hidden />
            {t('expenses.add')}
          </Button>
        }
      />
    )
  }

  return (
    <>
      <ExpensesKpiBand overview={overview} loading={refreshing} />

      {/* A re-fetch keeps the previous numbers on screen and marks the
          surfaces busy, so changing the period is not a full-page flash. */}
      {refreshing ? <ProgressBar label={t('app.loading')} /> : null}

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
            <p className="mt-0.5 text-caption text-foreground-subtle">{t('expenses.list.hint')}</p>
          </div>
          {refreshing ? <ProgressBar label={t('app.loading')} className="w-24" /> : null}
        </div>
        <ExpenseList rows={rows} />
      </Card>
    </>
  )
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

      <ExpensesBody
        t={t}
        initialLoading={data.initialLoading}
        error={data.error}
        empty={empty}
        overview={overview}
        refreshing={data.refreshing}
        rows={data.rows}
        range={range}
        period={period}
        onRetry={refresh}
        onAdd={() => setCreateOpen(true)}
      />

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
function ExpenseList({ rows }: Readonly<{ readonly rows: Expense[] }>) {
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
          {/*
            One record per expense.

            `flex-col` below `sm` gives the amount its OWN LINE on a phone
            instead of leaving it to share a wrapped 296px row with the category,
            the date, the recorder and the recurring badge — which is what
            produced rows of two ragged lines where the figure landed on
            whichever line happened to have room. `sm:flex-row` restores the
            original single line exactly, so the desktop column of amounts at the
            trailing edge is untouched and still scans vertically.

            The ORDER is unchanged at both widths, because it is correct: what the
            row is, then when it happened and who recorded it, then what it cost.
            Nothing is hidden and no font is shrunk; the row is simply allowed to
            be two lines tall on a screen that has the height to spend on it.
          */}
          <Card className="flex flex-col gap-2 rounded-none border-0 py-3 shadow-none sm:flex-row sm:items-center sm:gap-3">
            <div className="min-w-0 flex-1">
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

            {/* The figure, and the badge that qualifies it, on their own line on
                a phone. `ms-auto` keeps the pair at the trailing edge from `sm`
                up, so the desktop column of amounts is unchanged. */}
            <div className="flex items-center justify-between gap-2 sm:ms-auto sm:justify-end">
              {row.is_recurring ? (
                <Badge variant="info" size="sm" dot>
                  {t('expenses.recurring')}
                </Badge>
              ) : null}
              <MoneyDisplay amount={row.amount} className="text-money min-w-24" />
            </div>
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
  /**
   * The employee an employee-linked category (the advance) is FOR.
   *
   * The STABLE id — never a typed name — so the salary figures always resolve to
   * a real person. It is sent only when the chosen category asks for one; the
   * backend enforces that independently, so this is feedback, not the rule.
   */
  const [employeeId, setEmployeeId] = useState<number | null>(null)
  /** The field-level error, shown next to the selector rather than as a toast. */
  const [employeeError, setEmployeeError] = useState<string | null>(null)

  // A new expense owns ONE business date — the user's local today, not a UTC day.
  const [date, setDate] = useState<string>(todayIso)

  const [recurring, setRecurring] = useState(false)
  const [recurrence, setRecurrence] = useState<'WEEKLY' | 'MONTHLY'>('MONTHLY')

  const [busy, setBusy] = useState(false)

  // Whether the CHOSEN category demands an employee — read from the category data,
  // never from a hardcoded code.
  const requiresEmployee = categories.find((c) => c.code === category)?.requires_employee ?? false

  async function save() {
    const minor = parseMajor(amount)

    if (minor === null || minor <= 0) {
      toast(t('errors.expenses.invalid_amount'), 'error')
      return
    }

    // Checked before the request so an incomplete form never leaves the screen.
    // The backend refuses the same thing authoritatively.
    if (requiresEmployee && employeeId === null) {
      setEmployeeError(t('errors.expenses.employee_required'))
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
        // Sent only for a category that asks for one; the backend ignores it
        // otherwise, so a normal expense can never be employee-linked by accident.
        employee_id: requiresEmployee ? employeeId : null,
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
            onChange={(e) => {
              setCategory(e.target.value)
              // A category change invalidates any earlier employee complaint:
              // the next category may not need an employee at all.
              setEmployeeError(null)
            }}
            className="h-10 w-full rounded-md border border-border-strong bg-surface-input px-3 text-base"
          >
            {categories.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name_ar}
              </option>
            ))}
          </select>
        </Field>

        {/* The employee selector, mounted only for a category whose data says it
            requires one. Same shared component the cashier's dialog uses. */}
        <ExpenseEmployeeField
          category={category}
          categories={categories}
          employeeId={employeeId}
          onChange={(value) => {
            setEmployeeId(value)
            if (value !== null) setEmployeeError(null)
          }}
          invalid={employeeError}
        />

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

        <DialogActions>
          <Button variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>

          <Button onClick={save} disabled={busy} loading={busy}>
            {!busy ? <Save size={16} aria-hidden /> : null}
            {t('app.save')}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  )
}
