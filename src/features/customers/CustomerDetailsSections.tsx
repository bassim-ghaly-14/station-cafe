/**
 * The customer drawer's sections and the small parts they share.
 *
 * Each section answers ONE question about the customer — who they are, what the
 * period cost, how the period splits across the two business axes, and what
 * actually happened recently — and each is a pure function of the payload the
 * backend already aggregated. Splitting them here keeps the drawer's own
 * lifecycle (load, retry, progress) readable on its own, and keeps the reading
 * order of the panel explicit in the file that draws it.
 */
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'

import { Badge, MoneyDisplay } from '@/components/ui'
import { DisplayDate, DisplayDateTime } from '@/components/ui/display-datetime'
import { CalendarClock, Car, Coffee, Droplets, Receipt, ShoppingBag } from '@/components/ui/icon'
import type { LucideIcon } from '@/components/ui/icon'
import { invoiceBadgeVariant } from '@/lib/status-badge'
import { cn } from '@/lib/utils'
import type { CustomerDetails } from '@/services/customersApi'

/** A compact premium stat block: a quiet label over a strong figure. */
function StatBlock({
  label,
  children,
  tone = 'default',
  className,
}: {
  readonly label: string
  readonly children: ReactNode
  readonly tone?: 'default' | 'warning'
  readonly className?: string
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-0.5 rounded-md bg-surface-muted px-3 py-2.5',
        className,
      )}
    >
      <span className="truncate text-caption">{label}</span>
      <span
        className={cn(
          'truncate text-body font-bold tabular-nums',
          tone === 'warning' ? 'text-destructive' : 'text-foreground-strong',
        )}
      >
        {children}
      </span>
    </div>
  )
}

/**
 * A titled band inside the drawer. Hierarchy comes from the label, the
 * whitespace and a hairline — there is deliberately no box drawn around it.
 */
function Section({ title, children }: Readonly<{ readonly title: string; children: ReactNode }>) {
  return (
    <section className="mt-5 border-t border-border-subtle pt-4">
      <h3 className="mb-2.5 text-caption font-bold text-foreground-muted">{title}</h3>
      {children}
    </section>
  )
}

/**
 * A one-line label/value pair for the quieter figures under the KPI blocks.
 * A `<dl>` row, so the pairing is announced as such.
 */
function LedgerRow({ label, children }: Readonly<{ readonly label: string; children: ReactNode }>) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border-subtle py-1.5 last:border-0">
      <dt className="min-w-0 truncate text-caption">{label}</dt>
      <dd className="shrink-0 text-body font-bold tabular-nums">{children}</dd>
    </div>
  )
}

/**
 * A row's share of the larger of its two real values, as 0–1.
 *
 * This is a comparison between two figures the backend actually sent, not a
 * percentage of an invented total, so it can never overstate or double-count
 * anything. A zero axis yields 0 for both rows (two empty bars) instead of
 * dividing by zero.
 */
function shareOf(value: number, other: number): number {
  const max = Math.max(value, other)
  if (max <= 0) return 0
  return Math.min(1, Math.max(0, value / max))
}

/**
 * One row of a proportional breakdown: label, a bar whose width is the row's
 * real share of the larger value, and the real figures beside it. The bar is
 * decorative; the numbers are the content, so nothing here depends on
 * perceiving a length.
 */
function BreakdownRow({
  icon: Icon,
  label,
  orders,
  amount,
  share,
}: {
  readonly icon: LucideIcon
  readonly label: string
  readonly orders: number
  /** Department rows carry a value; order-type rows do not. */
  readonly amount?: number
  /** 0–1, derived from the real values by the caller. */
  readonly share: number
}) {
  const { t } = useTranslation()
  return (
    <li className="flex flex-col gap-1.5 py-2">
      <div className="flex items-center gap-2">
        <Icon size={15} aria-hidden className="shrink-0 text-foreground-subtle" />
        <span className="min-w-0 flex-1 truncate text-body font-bold">{label}</span>
        <span className="shrink-0 text-caption tabular-nums">
          {t('customers.breakdown.ordersCount', { count: orders })}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-accent" aria-hidden="true">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </div>
      {typeof amount === 'number' ? (
        <span className="text-caption tabular-nums">
          <MoneyDisplay amount={amount} variant="auto" />
        </span>
      ) : null}
    </li>
  )
}

/**
 * Identity — the customer's own record, not period data. The header already
 * carries name/contact/vehicle, so this section holds only what does not fit
 * there: the notes and the plates themselves.
 */
export function CustomerProfileSection({ details }: { readonly details: CustomerDetails }) {
  const { t } = useTranslation()

  return (
    <Section title={t('customers.drawer.profile')}>
      {details.customer.notes ? (
        <Badge variant="neutral" size="sm">
          {details.customer.notes}
        </Badge>
      ) : null}
      {details.cars.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {details.cars.map((car) => (
            <li
              key={car.id}
              className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-caption"
            >
              <Car size={12} aria-hidden className="text-foreground-subtle" />
              <span dir="ltr" className="font-bold">
                {car.plate_no}
              </span>
              {car.car_model ? (
                <span className="text-foreground-subtle">{car.car_model}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-caption text-foreground-subtle">{t('customers.drawer.noCars')}</p>
      )}
    </Section>
  )
}

/**
 * Performance — the period's headline figures, as compact blocks.
 * Every value is the backend's aggregate; nothing is derived here.
 */
export function CustomerStatsSection({ details }: { readonly details: CustomerDetails }) {
  const { t } = useTranslation()

  return (
    <Section title={t('customers.drawer.performance')}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatBlock label={t('customers.stats.orders')}>
          <span className="tabular-nums">{details.stats.invoices_count}</span>
        </StatBlock>
        <StatBlock label={t('customers.stats.paid')}>
          <MoneyDisplay amount={details.stats.paid} variant="auto" />
        </StatBlock>
        <StatBlock label={t('customers.stats.average')}>
          <MoneyDisplay amount={details.stats.average_order} variant="auto" />
        </StatBlock>
        {/* The credit account is a standing balance, not a period
                  movement — it is coloured as one only when money is owed. */}
        <StatBlock
          label={t('customers.stats.credit')}
          tone={details.stats.credit_outstanding > 0 ? 'warning' : 'default'}
        >
          <MoneyDisplay amount={details.stats.credit_outstanding} variant="auto" />
        </StatBlock>
        <StatBlock label={t('customers.stats.discounts')}>
          <MoneyDisplay amount={details.stats.discounts} variant="auto" />
        </StatBlock>
        <StatBlock label={t('customers.stats.serviceCharges')}>
          <MoneyDisplay amount={details.stats.service_charges} variant="auto" />
        </StatBlock>
      </div>

      {/* The remaining aggregates stay as a quiet two-column ledger
                under the blocks, so the panel keeps every figure the backend
                sent without turning the top of it into a wall of tiles. */}
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
        <LedgerRow label={t('customers.stats.total')}>
          <MoneyDisplay amount={details.stats.total} variant="auto" />
        </LedgerRow>
        {details.stats.credit_original > 0 ? (
          <>
            <LedgerRow label={t('customers.stats.creditOriginal')}>
              <MoneyDisplay amount={details.stats.credit_original} variant="auto" />
            </LedgerRow>
            <LedgerRow label={t('customers.stats.creditPaid')}>
              <MoneyDisplay amount={details.stats.credit_paid} variant="auto" />
            </LedgerRow>
          </>
        ) : null}
        <LedgerRow label={t('customers.stats.firstOrder')}>
          {details.stats.first_at ? (
            <DisplayDate value={details.stats.first_at} />
          ) : (
            <span className="text-foreground-faint">—</span>
          )}
        </LedgerRow>
        <LedgerRow label={t('customers.stats.lastOrder')}>
          {details.stats.last_at ? (
            <DisplayDate value={details.stats.last_at} />
          ) : (
            <span className="text-foreground-faint">—</span>
          )}
        </LedgerRow>
      </dl>
    </Section>
  )
}

/**
 * The two axes the period splits across, kept deliberately SEPARATE.
 *
 *   Axis 1 — business (كافيه / مغسلة), from the invoice snapshot totals.
 *   Axis 2 — order type (طاولة / تيك اواي), from the invoice's own
 *            `order_type`.
 *
 * Each has its own hint, so nobody reads a hybrid order as two orders or adds
 * the two axes together. Bar widths are each row's share of the LARGER of its
 * two real values — a ratio of figures that both exist, never a percentage of a
 * total the backend did not send. An all-zero axis renders two empty bars
 * rather than dividing by zero.
 */
export function CustomerBreakdownSections({ details }: { readonly details: CustomerDetails }) {
  const { t } = useTranslation()
  const { stats } = details

  return (
    <>
      <Section title={t('customers.drawer.business')}>
        <ul className="divide-y divide-border-subtle">
          <BreakdownRow
            icon={Coffee}
            label={t('customers.breakdown.cafe')}
            orders={stats.cafe_orders}
            amount={stats.cafe_total}
            share={shareOf(stats.cafe_orders, stats.wash_orders)}
          />
          <BreakdownRow
            icon={Droplets}
            label={t('customers.breakdown.wash')}
            orders={stats.wash_orders}
            amount={stats.wash_total}
            share={shareOf(stats.wash_orders, stats.cafe_orders)}
          />
        </ul>
        <p className="mt-1 text-caption text-foreground-subtle">
          {t('customers.drawer.businessHint')}
        </p>
      </Section>

      <Section title={t('customers.drawer.orderType')}>
        <ul className="divide-y divide-border-subtle">
          <BreakdownRow
            icon={ShoppingBag}
            label={t('customers.breakdown.takeaway')}
            orders={stats.takeaway_orders}
            share={shareOf(stats.takeaway_orders, stats.table_orders)}
          />
          <BreakdownRow
            icon={Receipt}
            label={t('customers.breakdown.table')}
            orders={stats.table_orders}
            share={shareOf(stats.table_orders, stats.takeaway_orders)}
          />
        </ul>
        <p className="mt-1 text-caption text-foreground-subtle">
          {t('customers.drawer.orderTypeHint')}
        </p>
      </Section>
    </>
  )
}

/**
 * Recent activity — a compact timeline of the real invoices. The bullet is the
 * timeline spine; everything else is type and whitespace, so no row becomes its
 * own card.
 */
export function CustomerActivitySection({ details }: { readonly details: CustomerDetails }) {
  const { t } = useTranslation()

  return (
    <Section title={t('customers.drawer.history')}>
      {details.activity.length === 0 ? (
        <p className="text-caption text-foreground-subtle">{t('customers.drawer.noActivity')}</p>
      ) : (
        <ul>
          {details.activity.map((row) => (
            <li
              key={row.invoice_no}
              className="relative flex items-start gap-3 border-b border-border-subtle py-2.5 last:border-0"
            >
              <span
                aria-hidden="true"
                className="mt-1.5 size-2 shrink-0 rounded-full bg-border-accent ring-4 ring-surface-dialog"
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="flex items-center gap-1.5 text-body font-bold tabular-nums">
                    <CalendarClock size={14} aria-hidden className="text-foreground-subtle" />
                    <span dir="ltr">#{row.invoice_no}</span>
                  </span>
                  <Badge variant="neutral" size="sm">
                    {row.order_type === 'TAKEAWAY'
                      ? t('customers.breakdown.takeaway')
                      : (row.table_label ?? t('customers.breakdown.table'))}
                  </Badge>
                  <Badge variant={invoiceBadgeVariant(row.status)} size="sm" dot>
                    {t(`invoice.status.${row.status}`)}
                  </Badge>
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-foreground-subtle">
                  <DisplayDateTime value={row.created_at} />
                  <span className="tabular-nums">
                    {t('customers.drawer.paid')}{' '}
                    <MoneyDisplay amount={row.paid_amount} variant="auto" />
                  </span>
                </span>
              </span>
              <span className="shrink-0 text-body font-bold tabular-nums">
                <MoneyDisplay amount={row.total} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
