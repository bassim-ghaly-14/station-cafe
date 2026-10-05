/**
 * Reconciliation presentation and the day-closing open-shift confirmation.
 *
 * These tests assert that the screen renders the BACKEND's figures and status
 * verbatim — they never recompute a total — and that the open-shift warning is
 * a confirmation the manager can cancel, not a blocking error.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import { SessionProvider } from '@/features/auth/useSession'
import { RouterProvider } from '@/app/router'
import '@/lib/i18n'
import i18n from '@/lib/i18n'
import { CurrentShiftPanel } from './CurrentShiftPanel'
import { DayClosingPanel } from './DayClosingPanel'
import {
  ExpensesSection,
  HandoverSection,
  SalesSection,
  ServicesSection,
  TablesSection,
} from './ReconciliationSections'
import { ShiftExpenseDialog, ShiftExpenseList } from './ShiftExpenses'
import type { Expense } from '@/services/opsApi'
import type { CashReconciliation, ShiftRow } from '@/services/shiftApi'

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  previewShiftClose: vi.fn(),
  closeShift: vi.fn(),
  previewDaySettlement: vi.fn(),
  settleDay: vi.fn(),
  daySettlementHistory: vi.fn(),
  dayReport: vi.fn(),
  previewDayClose: vi.fn(),
  closeDay: vi.fn(),
  // Typed as a real array so the mock keeps accepting expense rows.
  shiftExpenses: vi.fn<() => Promise<Expense[]>>(async () => []),
  expenseCategories: vi.fn(async () => [
    {
      code: 'UTILITY',
      name_ar: 'كهرباء ومياه',
      is_system: true,
      is_active: true,
      requires_employee: false,
    },
    {
      code: 'SUPPLIES',
      name_ar: 'مشتريات',
      is_system: true,
      is_active: true,
      requires_employee: false,
    },
  ]),
  createExpense: vi.fn(async () => 1),
  printShift: vi.fn(),
  printDay: vi.fn(),
}))

vi.mock('@/services/shiftApi', () => ({
  shiftApi: {
    state: mocks.state,
    previewShiftClose: mocks.previewShiftClose,
    closeShift: mocks.closeShift,
    previewDaySettlement: mocks.previewDaySettlement,
    settleDay: mocks.settleDay,
    daySettlementHistory: mocks.daySettlementHistory,
    dayReport: mocks.dayReport,
    previewDayClose: mocks.previewDayClose,
    closeDay: mocks.closeDay,
  },
}))

vi.mock('@/services/opsApi', () => ({
  opsApi: {
    shiftExpenses: mocks.shiftExpenses,
    expenseCategories: mocks.expenseCategories,
    createExpense: mocks.createExpense,
  },
}))

vi.mock('@/services/posApi', () => ({
  settingsApi: { serviceCharge: vi.fn(), discountOptions: vi.fn() },
  api: {
    printShift: mocks.printShift,
    printDay: mocks.printDay,
    previewShift: vi.fn(),
    previewDayReport: vi.fn(),
  },
}))

function cash(over: Partial<CashReconciliation> = {}): CashReconciliation {
  return {
    opening_cash: 10_000,
    cash_inflows: 25_000,
    cash_outflows: 5_000,
    expected_cash: 30_000,
    actual_cash: 30_000,
    difference: 0,
    shortage: 0,
    surplus: 0,
    status: 'BALANCED',
    ...over,
  }
}

const shift: ShiftRow = {
  id: 7,
  business_day_id: 1,
  user_id: 2,
  user_name: 'حسن',
  user_role: 'STAFF',
  status: 'ACTIVE',
  opened_at: '2026-09-25 08:00:00Z',
  opening_cash: 10_000,
  closed_at: null,
  cash_sales: 25_000,
  card_sales: 4_000,
  credit_sales: 1_000,
  service_charges: 2_000,
  discounts: 500,
  invoices_count: 4,
  expected_cash: 30_000,
  actual_cash: null,
  cash_difference: null,
  cafe_invoices: 2,
  wash_invoices: 1,
  hybrid_invoices: 1,
  subtotal: 33_000,
  total_sales: 34_500,
  cafe_sales: 20_000,
  wash_sales: 12_000,
  expenses: 7_000,
  cash_expenses: 5_000,
}

const shiftReport = {
  shift,
  areas: { cafe_invoices: 2, wash_invoices: 1, hybrid_invoices: 1 },
  invoices_count: 4,
  cafe_sales: 20_000,
  wash_sales: 12_000,
  subtotal: 33_000,
  discounts: 500,
  service_charges: 2_000,
  total_sales: 34_500,
  cash_sales: 25_000,
  card_sales: 4_000,
  credit_sales: 1_000,
  expenses: 7_000,
  cash_expenses: 5_000,
  expense_breakdown: [
    { category: 'UTILITY', category_name: 'كهرباء ومياه', count: 2, amount: 5_000 },
    { category: 'SUPPLIES', category_name: 'مشتريات', count: 1, amount: 2_000 },
  ],
  // The shift's OWN table lifecycle, as the backend reports it. Deliberately
  // different from the day's figure, because the two describe different periods.
  tables: { opens: 3, closed_empty: 2 },
  cash: cash(),
}

const closedShift = { ...shift, status: 'CLOSED' as const, closed_at: '2026-09-24 23:00:00Z' }

const dayTotals = {
  invoices_count: 4,
  cafe_sales: 20_000,
  wash_sales: 12_000,
  subtotal: 33_000,
  discounts: 500,
  service_charges: 2_000,
  total_sales: 34_500,
  cash: 25_000,
  card: 4_000,
  credit: 1_000,
  expenses: 7_000,
}

function dayReport(over: Record<string, unknown> = {}) {
  return {
    day: {
      id: 1,
      day_date: '2026-09-24',
      status: 'OPEN',
      opened_at: '2026-09-24 08:00:00Z',
      closed_at: null,
    },
    areas: { cafe_invoices: 2, wash_invoices: 1, hybrid_invoices: 1 },
    shift_count: 1,
    open_shift_count: 0,
    invoices_count: 4,
    cafe_sales: 20_000,
    wash_sales: 12_000,
    subtotal: 33_000,
    discounts: 500,
    service_charges: 2_000,
    total_sales: 34_500,
    cash_sales: 25_000,
    card_sales: 4_000,
    credit_sales: 1_000,
    expenses: 7_000,
    cash_expenses: 5_000,
    expense_breakdown: shiftReport.expense_breakdown,
    cash: cash(),
    included_shift_ids: [7],
    shifts: [closedShift],
    ...over,
  }
}

describe('reconciliation presentation has no missing Arabic text', () => {
  // Regression: the reconciliation sections were written against translation keys
  // that were never added to the Arabic catalogue, so the closing documents
  // rendered raw identifiers such as "shift.handoverSection" to the cashier
  // instead of Arabic. Every key a closing screen reads must exist and must be a
  // real Arabic label, never a fallback that echoes the key back.
  const KEYS = [
    'shift.salesSection',
    'shift.cafeInvoices',
    'shift.washInvoices',
    'shift.hybridInvoices',
    'shift.hybridInvoicesHint',
    'shift.totalSales',
    'shift.servicesSection',
    'shift.serviceTotal',
    'shift.discountTotal',
    'shift.expensesSection',
    'shift.expensesTotal',
    'shift.expensesCashPart',
    'shift.expenseCount',
    'shift.expenseEmpty',
    'shift.tablesSection',
    'shift.tablesOpened',
    'shift.tablesClosedEmpty',
    'shift.tablesSectionHint',
    'shift.handoverSection',
    'shift.custodySection',
    'shift.openingCash',
    'shift.cashInflows',
    'shift.cashOutflows',
    'shift.expectedClosingCash',
    'shift.actualHandover',
    'shift.difference',
    'shift.statusBalanced',
    'shift.statusShortage',
    'shift.statusSurplus',
    'settlement.settledShiftsCount',
    'settlement.openShiftsExcluded',
    'settlement.openShiftsTitle',
    'settlement.openShiftsBody',
    'settlement.openShiftsQuestion',
    'settlement.continueAnyway',
    'settlement.excludedMoneyHint',
    'settlement.openShiftsInReport',
    'settlement.expectedClosingCash',
    'errors.day.no_settled_shifts',
    'errors.expenses.no_open_shift',
    'errors.expenses.invalid_amount',
    'errors.expenses.invalid_category',
  ]

  it('resolves every closing-screen key to Arabic text', () => {
    const missing = KEYS.filter((key) => i18n.t(key) === key)
    expect(missing).toEqual([])
  })

  it('never leaks implementation identifiers to the operator', () => {
    for (const key of KEYS) {
      const value = i18n.t(key)
      expect(value).not.toMatch(/^[a-z_]+$/)
    }
  })
})

describe('reconciliation sections render the backend report', () => {
  it('shows invoice counts per business area, the service total and the discount total', () => {
    render(
      <SessionProvider>
        <RouterProvider>
          <SalesSection data={shiftReport} />
          <ServicesSection serviceCharges={2_000} discounts={500} />
        </RouterProvider>
      </SessionProvider>,
    )
    // Each area states its own count; hybrid is listed separately so the three
    // never read as a double-count.
    expect(screen.getByText(/فواتير الكافيه \(2\)/)).toBeInTheDocument()
    expect(screen.getByText(/فواتير المغسلة \(1\)/)).toBeInTheDocument()
    expect(screen.getByText(/الفواتير المختلطة \(1\)/)).toBeInTheDocument()
    // The hybrid row is a COUNT, not an amount. Its money already sits inside
    // the cafe and wash lines, so printing a 0.00 next to it would state that
    // hybrid documents contributed nothing — which is false.
    const hybrid = screen.getByText(/الفواتير المختلطة \(1\)/).parentElement!
    expect(hybrid.textContent).not.toMatch(/0\.00/)
    expect(hybrid.textContent).not.toMatch(/ج\.م/)
    // The invoice-level service charge and the discount are their own lines.
    expect(screen.getByText('إجمالي الخدمات').parentElement?.textContent).toContain('20.00')
    expect(screen.getByText('إجمالي الخصومات').parentElement?.textContent).toContain('5.00')
  })

  /**
   * REGRESSION — the invoice count was rendered through `AmountRow`, whose
   * `MoneyDisplay` reads its argument as PIASTERS. A count of 6 therefore
   * printed as `0.06 ج.م`. The count is a count from the backend all the way to
   * the screen, so this asserts the value itself, not the absence of a symbol.
   */
  it('renders the invoice count as an integer count, never as an amount', () => {
    render(
      <SessionProvider>
        <RouterProvider>
          <SalesSection data={{ ...shiftReport, invoices_count: 6 }} />
        </RouterProvider>
      </SessionProvider>,
    )

    const row = screen.getByText('عدد الفواتير').parentElement!
    expect(row.textContent).toContain('6')
    // The money formatter's signature output for a count of 6 read as piasters.
    expect(row.textContent).not.toContain('0.06')
    expect(row.textContent).not.toContain('ج.م')
  })

  it('renders a zero invoice count as a plain 0', () => {
    render(
      <SessionProvider>
        <RouterProvider>
          <SalesSection data={{ ...shiftReport, invoices_count: 0 }} />
        </RouterProvider>
      </SessionProvider>,
    )

    const row = screen.getByText('عدد الفواتير').parentElement!
    expect(row.textContent).toContain('0')
    expect(row.textContent).not.toContain('ج.م')
  })

  /**
   * The shift closing states the SHIFT's own table lifecycle: how many table
   * sessions this shift opened, and how many of them it closed without an order.
   *
   * Both figures arrive from the backend, already scoped to `shift_id`, and this
   * screen only presents them. The component therefore must never derive them —
   * and above all never route them through `AmountRow`, which would render six
   * closes as `0.06 ج.م`.
   */
  it('renders the shift table statistics as counts, verbatim from the backend', () => {
    render(
      <SessionProvider>
        <RouterProvider>
          <TablesSection tables={{ opens: 3, closed_empty: 2 }} />
        </RouterProvider>
      </SessionProvider>,
    )

    // The shift's own block, not the day's: two separate labelled lines.
    expect(screen.getByText('الطاولات خلال الوردية')).toBeInTheDocument()
    const opens = screen.getByText('طاولات تم فتحها').parentElement!
    const empty = screen.getByText('طاولات أُغلقت فارغة').parentElement!

    // The backend's exact integers — 3 opens and 2 empty closes.
    expect(opens.textContent).toContain('3')
    expect(empty.textContent).toContain('2')
    // Counts, never amounts: no piaster division, no currency symbol.
    expect(opens.textContent).not.toContain('ج.م')
    expect(empty.textContent).not.toContain('ج.م')
    expect(opens.textContent).not.toContain('0.03')
    expect(empty.textContent).not.toContain('0.02')

    // And the hint states the reset rule the cashier relies on, so the screen
    // never implies a figure that carries over into the next shift.
    expect(screen.getByText(/تبدأ من جديد مع الوردية التالية/)).toBeInTheDocument()
  })

  /**
   * A shift that has done nothing yet must state zero, not hide the lines. A
   * missing line would read as "not applicable" rather than "nothing happened",
   * which is exactly the ambiguity the shift boundary must not have.
   */
  it('states zero for both table statistics rather than omitting them', () => {
    render(
      <SessionProvider>
        <RouterProvider>
          <TablesSection tables={{ opens: 0, closed_empty: 0 }} />
        </RouterProvider>
      </SessionProvider>,
    )

    const opens = screen.getByText('طاولات تم فتحها').parentElement!
    const empty = screen.getByText('طاولات أُغلقت فارغة').parentElement!
    expect(opens.textContent).toContain('0')
    expect(empty.textContent).toContain('0')
    expect(opens.textContent).not.toContain('ج.م')
    expect(empty.textContent).not.toContain('ج.م')
  })

  /**
   * The monetary lines in the SAME block must keep their currency formatting.
   * Fixing the count may never quietly turn an amount into a bare number.
   */
  it('keeps the money lines beside the count formatted as EGP', () => {
    render(
      <SessionProvider>
        <RouterProvider>
          <SalesSection data={{ ...shiftReport, invoices_count: 6 }} />
        </RouterProvider>
      </SessionProvider>,
    )

    expect(screen.getByText('إجمالي المبيعات').parentElement?.textContent).toContain('345.00')
    expect(screen.getByText('إجمالي المبيعات').parentElement?.textContent).toContain('ج.م')
    expect(screen.getByText(/فواتير الكافيه \(2\)/).parentElement?.textContent).toContain('200.00')
  })

  it('lists the expense total and its per-category breakdown with counts', () => {
    render(
      <SessionProvider>
        <RouterProvider>
          <ExpensesSection
            total={7_000}
            cashExpenses={5_000}
            breakdown={shiftReport.expense_breakdown}
          />
        </RouterProvider>
      </SessionProvider>,
    )
    expect(screen.getByText('إجمالي المصروفات').parentElement?.textContent).toContain('70.00')
    // Category names come from the backend, never from a hardcoded UI string.
    expect(screen.getByText(/كهرباء ومياه/)).toBeInTheDocument()
    expect(screen.getByText(/مشتريات/)).toBeInTheDocument()
    // A repeated category states how many times it occurred.
    expect(screen.getByText(/2 مرة/)).toBeInTheDocument()
  })

  it('names a balanced, a shortage and a surplus distinctly', () => {
    const balanced = render(
      <SessionProvider>
        <RouterProvider>
          <HandoverSection cash={cash({ status: 'BALANCED' })} />
        </RouterProvider>
      </SessionProvider>,
    )
    expect(balanced.getByText('متوازن')).toBeInTheDocument()
    balanced.unmount()

    const short = render(
      <SessionProvider>
        <RouterProvider>
          <HandoverSection
            cash={cash({
              actual_cash: 28_000,
              difference: -2_000,
              shortage: 2_000,
              status: 'SHORTAGE',
            })}
          />
        </RouterProvider>
      </SessionProvider>,
    )
    // A non-zero difference is NOT always a shortage.
    expect(short.getByText('عجز')).toBeInTheDocument()
    expect(short.queryByText('زيادة')).not.toBeInTheDocument()
    short.unmount()

    const over = render(
      <SessionProvider>
        <RouterProvider>
          <HandoverSection
            cash={cash({
              actual_cash: 32_000,
              difference: 2_000,
              surplus: 2_000,
              status: 'SURPLUS',
            })}
          />
        </RouterProvider>
      </SessionProvider>,
    )
    expect(over.getByText('زيادة')).toBeInTheDocument()
    expect(over.queryByText('عجز')).not.toBeInTheDocument()
  })

  it('shows the full drawer handover from opening cash to the final status', () => {
    render(
      <SessionProvider>
        <RouterProvider>
          <HandoverSection cash={cash()} />
        </RouterProvider>
      </SessionProvider>,
    )
    expect(screen.getByText('رصيد افتتاح الوردية').parentElement?.textContent).toContain('100.00')
    expect(screen.getByText('إجمالي النقدية الداخلة').parentElement?.textContent).toContain(
      '250.00',
    )
    expect(screen.getByText('إجمالي المصروفات النقدية').parentElement?.textContent).toContain(
      '50.00',
    )
    expect(screen.getByText('رصيد الإقفال المتوقع').parentElement?.textContent).toContain('300.00')
    expect(screen.getByText('النقدية الفعلية المسلّمة').parentElement?.textContent).toContain(
      '300.00',
    )
    expect(screen.getByText('الفرق')).toBeInTheDocument()
    // The final line states the semantic verdict itself, not just a number.
    expect(screen.getByText('متوازن')).toBeInTheDocument()
  })
})

describe('cashier expense entry', () => {
  it('offers only the categories the backend returns, with its Arabic labels', async () => {
    render(
      <ToastProvider>
        <ShiftExpenseDialog open onClose={vi.fn()} onCreated={vi.fn()} />
      </ToastProvider>,
    )
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'كهرباء ومياه' })).toBeInTheDocument(),
    )
    expect(screen.getByRole('option', { name: 'مشتريات' })).toBeInTheDocument()
  })

  it('sends the amount, the chosen category and whether the drawer paid', async () => {
    const onCreated = vi.fn()
    render(
      <ToastProvider>
        <ShiftExpenseDialog open onClose={vi.fn()} onCreated={onCreated} />
      </ToastProvider>,
    )
    await waitFor(() => expect(screen.getByRole('option', { name: 'مشتريات' })).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '15' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))
    await waitFor(() => expect(mocks.createExpense).toHaveBeenCalledTimes(1))
    expect(mocks.createExpense).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'UTILITY', amount: 1_500, paid_from_cash: true }),
    )
    expect(onCreated).toHaveBeenCalled()
  })

  it('explains an empty shift expense list instead of showing nothing', () => {
    render(
      <SessionProvider>
        <RouterProvider>
          <ShiftExpenseList rows={[]} />
        </RouterProvider>
      </SessionProvider>,
    )
    expect(screen.getByText('لا توجد مصروفات مسجلة في هذه الوردية')).toBeInTheDocument()
  })
})

describe('shift closing screen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.shiftExpenses.mockResolvedValue([
      {
        id: 1,
        category: 'UTILITY',
        category_name: 'كهرباء ومياه',
        amount: 5_000,
        description: null,
        expense_date: '2026-09-25',
        is_recurring: false,
        recurrence: null,
        business_day_id: 1,
        shift_id: 7,
        paid_from_cash: true,
        user_name: 'حسن',
        user_role: 'STAFF',
        created_at: '2026-09-25 10:00:00Z',
      },
    ])
    mocks.previewShiftClose.mockResolvedValue({
      shift,
      closing_at: '2026-09-25 14:00:00Z',
      cash_sales: 25_000,
      card_sales: 4_000,
      credit_sales: 1_000,
      invoices_count: 4,
      expected_cash: 30_000,
      cash_expenses: 5_000,
      expenses: 7_000,
      report: shiftReport,
    })
  })

  it('renders the reconciliation the closing will record, from the backend', async () => {
    render(
      <SessionProvider>
        <RouterProvider>
          <ToastProvider>
            <CurrentShiftPanel shift={shift} onClosed={vi.fn()} />
          </ToastProvider>
        </RouterProvider>
      </SessionProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /تقفيل الوردية/ }))
    const dialog = await screen.findByRole('dialog')
    // The four closing sections, in order.
    expect(within(dialog).getByText('المبيعات')).toBeInTheDocument()
    expect(within(dialog).getByText('الخدمات والخصومات')).toBeInTheDocument()
    expect(within(dialog).getByText('المصروفات')).toBeInTheDocument()
    expect(within(dialog).getByText('تسوية العهدة')).toBeInTheDocument()
    // The backend's own figures, not anything recomputed here.
    expect(within(dialog).getByText('إجمالي الخدمات').parentElement?.textContent).toContain('20.00')
    expect(within(dialog).getByText('إجمالي المصروفات').parentElement?.textContent).toContain(
      '70.00',
    )
    expect(
      within(dialog).getByText('إجمالي المصروفات النقدية').parentElement?.textContent,
    ).toContain('50.00')
  })

  it('lists the shift expenses the cashier booked', async () => {
    render(
      <SessionProvider>
        <RouterProvider>
          <ToastProvider>
            <CurrentShiftPanel shift={shift} onClosed={vi.fn()} />
          </ToastProvider>
        </RouterProvider>
      </SessionProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /تقفيل الوردية/ }))
    const dialog = await screen.findByRole('dialog')
    const expenses = within(dialog).getByText('مصروفات الوردية').parentElement!
    // The expense rows carry the backend's own Arabic category name.
    expect(within(expenses).getByText(/كهرباء ومياه/)).toBeInTheDocument()
  })
})

describe('day closing with open shifts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dayReport.mockResolvedValue(dayReport())
    mocks.previewDaySettlement.mockResolvedValue({
      business_day_id: 1,
      pending_shifts: [],
      totals: dayTotals,
    })
    mocks.daySettlementHistory.mockResolvedValue([])
    mocks.closeDay.mockResolvedValue({ totals: dayTotals, report: dayReport() })
    mocks.printDay.mockResolvedValue({ duplicate_suppressed: false, job_id: 1 })
  })

  function openShiftPreview() {
    return {
      report: dayReport({ open_shift_count: 1, shift_count: 1 }),
      open_shifts: [
        {
          id: 9,
          user_name: 'حسن',
          opened_at: '2026-09-24 20:00:00Z',
          cash_sales: 4_000,
          expenses: 500,
        },
      ],
      open_orders: 0,
    }
  }

  function renderPanel() {
    return render(
      <SessionProvider>
        <RouterProvider>
          <ToastProvider>
            <DayClosingPanel dayId={1} revision={0} onDone={vi.fn()} />
          </ToastProvider>
        </RouterProvider>
      </SessionProvider>,
    )
  }

  it('shows the excluded amount from the backend preview, never a zero', async () => {
    mocks.previewDayClose.mockResolvedValue(openShiftPreview())
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /إغلاق يوم العمل/ }))
    const warning = await screen.findByRole('dialog')
    // The open shift's own live money is stated, so the manager sees what the
    // closing leaves out — these values come from `preview_day_close` itself.
    expect(within(warning).getByText(/حسن/)).toBeInTheDocument()
    const excluded = within(warning).getByText(/لن تُحتسب/)
    expect(excluded.parentElement?.textContent).toContain('40.00')
    expect(excluded.parentElement?.textContent).toContain('5.00')
  })

  it('warns that open shifts are excluded, and does not close on cancel', async () => {
    mocks.previewDayClose.mockResolvedValue(openShiftPreview())
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /إغلاق يوم العمل/ }))

    // The warning states the rule in Arabic before anything is closed.
    const warning = await screen.findByRole('dialog')
    expect(within(warning).getByText('يوجد ورديات مفتوحة لم تتم تسويتها')).toBeInTheDocument()
    expect(
      within(warning).getByText(
        'تقفيلة اليوم ستشمل الورديات التي تمت تسويتها فقط، ولن يتم احتساب أي حركة من الورديات المفتوحة ضمن تقفيلة اليوم.',
      ),
    ).toBeInTheDocument()
    expect(within(warning).getByText('هل تريد المتابعة؟')).toBeInTheDocument()

    // Cancelling closes nothing.
    fireEvent.click(within(warning).getByRole('button', { name: 'إلغاء' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mocks.closeDay).not.toHaveBeenCalled()
  })

  it('proceeds over the settled shifts only once the warning is confirmed', async () => {
    mocks.previewDayClose.mockResolvedValue(openShiftPreview())
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /إغلاق يوم العمل/ }))
    const warning = await screen.findByRole('dialog')
    fireEvent.click(within(warning).getByRole('button', { name: /متابعة تقفيل اليوم/ }))

    // The warning is dismissed and the closing review takes over.
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: /تأكيد إغلاق يوم العمل/ })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: /تأكيد تقفيل اليوم/ }))
    await waitFor(() => expect(mocks.closeDay).toHaveBeenCalledTimes(1))
  })

  it('closes without a warning when every shift is settled', async () => {
    mocks.previewDayClose.mockResolvedValue({
      report: dayReport(),
      open_shifts: [],
      open_orders: 0,
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /إغلاق يوم العمل/ }))
    // Straight to the review: no open-shift warning.
    expect(await screen.findByRole('dialog', { name: /تأكيد إغلاق يوم العمل/ })).toBeInTheDocument()
    expect(screen.queryByText('يوجد ورديات مفتوحة لم تتم تسويتها')).not.toBeInTheDocument()
  })

  it('shows the aggregated reconciliation of the included shifts in Arabic RTL', async () => {
    mocks.previewDayClose.mockResolvedValue({
      report: dayReport(),
      open_shifts: [],
      open_orders: 0,
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /إغلاق يوم العمل/ }))
    const dialog = await screen.findByRole('dialog', { name: /تأكيد إغلاق يوم العمل/ })

    // The document is Arabic and the app is RTL.
    expect(dialog.closest('[dir]')).toHaveAttribute('dir', 'rtl')
    expect(within(dialog).getByText('المبيعات')).toBeInTheDocument()
    expect(within(dialog).getByText('الخدمات والخصومات')).toBeInTheDocument()
    expect(within(dialog).getByText('المصروفات')).toBeInTheDocument()
    expect(within(dialog).getByText('التسليم / الإقفال')).toBeInTheDocument()
    // The backend's aggregated figures.
    expect(within(dialog).getByText('إجمالي الخدمات').parentElement?.textContent).toContain('20.00')
    expect(within(dialog).getByText('إجمالي الخصومات').parentElement?.textContent).toContain('5.00')
    expect(within(dialog).getByText('إجمالي المصروفات').parentElement?.textContent).toContain(
      '70.00',
    )
    expect(within(dialog).getByText('رصيد الإقفال المتوقع').parentElement?.textContent).toContain(
      '300.00',
    )
    // The category breakdown is data-driven.
    expect(within(dialog).getByText(/كهرباء ومياه/)).toBeInTheDocument()
  })
})
