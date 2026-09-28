import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { MoneyDisplay } from '@/components/ui'
import { cn } from '@/lib/utils'
import type { CashReconciliation, ExpenseBreakdownRow } from '@/services/shiftApi'
import { STATUS_LABEL, STATUS_TONE } from './reconciliationStatus'

/**
 * Presentation of the ONE backend reconciliation.
 *
 * This component performs NO financial arithmetic. Every amount — and the
 * balanced / shortage / surplus verdict itself — arrives from the backend
 * (`CashReconciliation`); the UI only picks the label and a semantic colour.
 * If a rule about expected cash or a difference is ever needed here it belongs
 * in `services::reconciliation`: a second implementation in React would be
 * exactly the duplication this component exists to prevent.
 */

function AmountRow({
  label,
  amount,
  strong = false,
  emphasis = false,
  tone,
}: {
  readonly label: ReactNode
  readonly amount: number
  readonly strong?: boolean
  readonly emphasis?: boolean
  readonly tone?: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-4 py-1.5', strong && 'font-bold')}>
      <span className={strong ? 'text-foreground-strong' : 'text-foreground-muted'}>{label}</span>
      <MoneyDisplay amount={amount} className={cn(emphasis && 'font-bold', tone)} />
    </div>
  )
}

/** A count-only line: the value is a document count, never an amount. */
function CountRow({ label }: Readonly<{ readonly label: ReactNode }>) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-foreground-muted">{label}</span>
    </div>
  )
}

/** A titled block within a closing document. */
function Section({ title, children }: Readonly<{ readonly title: string; children: ReactNode }>) {
  return (
    <section className="border-t border-border-subtle pt-3">
      <h3 className="mb-1 text-caption font-bold text-foreground-strong">{title}</h3>
      {children}
    </section>
  )
}

export interface SalesArea {
  areas: { cafe_invoices: number; wash_invoices: number; hybrid_invoices: number }
  invoices_count: number
  cafe_sales: number
  wash_sales: number
  total_sales: number
  cash_sales: number
  card_sales: number
  credit_sales: number
}

/** 1. المبيعات — invoice counts and totals per business area. */
export function SalesSection({ data }: Readonly<{ readonly data: SalesArea }>) {
  const { t } = useTranslation()
  return (
    <Section title={t('shift.salesSection')}>
      <AmountRow
        label={`${t('shift.cafeInvoices')} (${data.areas.cafe_invoices})`}
        amount={data.cafe_sales}
      />
      <AmountRow
        label={`${t('shift.washInvoices')} (${data.areas.wash_invoices})`}
        amount={data.wash_sales}
      />
      {/* Hybrid invoices are counted ONCE by the backend and listed separately, so
          the document never implies a document was counted twice. Their money is
          already inside the cafe and wash lines above, so this row deliberately
          carries NO amount: printing 0.00 here would state that hybrid documents
          contributed no money, which is false. */}
      <CountRow label={`${t('shift.hybridInvoices')} (${data.areas.hybrid_invoices})`} />
      <p className="pb-1 text-caption text-foreground-subtle">{t('shift.hybridInvoicesHint')}</p>
      <AmountRow label={t('shift.invoiceCount')} amount={data.invoices_count} tone="tabular-nums" />
      <AmountRow label={t('shift.cashSales')} amount={data.cash_sales} />
      <AmountRow label={t('shift.cardSales')} amount={data.card_sales} />
      <AmountRow label={t('shift.creditSales')} amount={data.credit_sales} />
      <AmountRow label={t('shift.totalSales')} amount={data.total_sales} strong emphasis />
    </Section>
  )
}

/** 2. الخدمات والخصومات — the invoice-level service charge and discounts. */
export function ServicesSection({
  serviceCharges,
  discounts,
}: {
  readonly serviceCharges: number
  readonly discounts: number
}) {
  const { t } = useTranslation()
  return (
    <Section title={t('shift.servicesSection')}>
      <AmountRow label={t('shift.serviceTotal')} amount={serviceCharges} strong />
      <AmountRow label={t('shift.discountTotal')} amount={discounts} strong />
    </Section>
  )
}

/** 3. المصروفات — the total and its per-category breakdown from the backend. */
export function ExpensesSection({
  total,
  cashExpenses,
  breakdown,
}: {
  readonly total: number
  readonly cashExpenses: number
  readonly breakdown: ExpenseBreakdownRow[]
}) {
  const { t } = useTranslation()
  return (
    <Section title={t('shift.expensesSection')}>
      <AmountRow label={t('shift.expensesTotal')} amount={total} strong emphasis />
      {/* How much of that total physically left a drawer. This is stated as a
          PART of the total, not as the drawer's own outflow line, which the
          handover block below already shows as part of its formula. */}
      <AmountRow label={t('shift.expensesCashPart')} amount={cashExpenses} />
      {breakdown.length === 0 ? (
        <p className="py-1 text-caption text-foreground-subtle">{t('expenses.empty')}</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {breakdown.map((row) => (
            <li
              key={row.category}
              className="flex items-center justify-between gap-4 py-0.5 text-sm"
            >
              {/* The name is the backend's own Arabic category label. */}
              <span className="min-w-0 truncate text-foreground-muted">
                {row.category_name}
                {row.count > 1 ? (
                  <span className="text-foreground-subtle">
                    {' '}
                    · {t('shift.expenseCount', { count: row.count })}
                  </span>
                ) : null}
              </span>
              <MoneyDisplay amount={row.amount} className="text-destructive" />
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

/**
 * 4. تسوية العهدة / التسليم — the drawer handover, ending on the verdict.
 *
 * The status badge is the single most important figure on the document, so it
 * is rendered last, at the heaviest weight, with a semantic color.
 */
export function HandoverSection({ cash }: Readonly<{ readonly cash: CashReconciliation }>) {
  const { t } = useTranslation()
  return (
    <Section title={t('shift.handoverSection')}>
      <AmountRow label={t('shift.openingCash')} amount={cash.opening_cash} />
      <AmountRow label={t('shift.cashInflows')} amount={cash.cash_inflows} />
      <AmountRow label={t('shift.cashOutflows')} amount={cash.cash_outflows} />
      <AmountRow
        label={t('shift.expectedClosingCash')}
        amount={cash.expected_cash}
        strong
        emphasis
      />
      <AmountRow label={t('shift.actualHandover')} amount={cash.actual_cash} strong />
      <AmountRow label={t('shift.difference')} amount={cash.difference} />
      <div
        className={cn(
          'mt-2 flex items-center justify-between gap-3 rounded-md border px-3 py-2',
          STATUS_TONE[cash.status],
        )}
      >
        <span className="text-base font-bold">{t(STATUS_LABEL[cash.status])}</span>
        {/* The magnitude the backend already resolved — never a client |diff|. */}
        <MoneyDisplay
          amount={
            cash.status === 'SHORTAGE'
              ? cash.shortage
              : cash.status === 'SURPLUS'
                ? cash.surplus
                : 0
          }
          className="text-base font-bold"
        />
      </div>
    </Section>
  )
}

/**
 * The expected-cash block shown BEFORE a handover has been entered.
 *
 * There is no actual cash and therefore no difference or verdict yet, so only
 * the opening / inflow / outflow / expected lines are meaningful. The
 * difference and the status are the backend's, shown once the user submits.
 */
export function ExpectedCashSection({ cash }: Readonly<{ readonly cash: CashReconciliation }>) {
  const { t } = useTranslation()
  return (
    <Section title={t('shift.custodySection')}>
      <AmountRow label={t('shift.openingCash')} amount={cash.opening_cash} />
      <AmountRow label={t('shift.cashInflows')} amount={cash.cash_inflows} />
      <AmountRow label={t('shift.cashOutflows')} amount={cash.cash_outflows} />
      <AmountRow
        label={t('shift.expectedClosingCash')}
        amount={cash.expected_cash}
        strong
        emphasis
      />
    </Section>
  )
}
