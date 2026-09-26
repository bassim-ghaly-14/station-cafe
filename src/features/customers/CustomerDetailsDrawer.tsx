/**
 * Customer details drawer (MANAGER+) — a customer intelligence panel.
 *
 * It opens BESIDE the list instead of navigating away, so the manager keeps
 * their place in the customer table while reading one customer's history.
 *
 * The payload is a single manager-level read: identity, cars, the period
 * aggregate and the recent invoices. Nothing here is computed in the browser —
 * every figure arrives already aggregated, and a failed read is reported as a
 * failure rather than shown as zeroes.
 *
 * Information architecture
 * ------------------------
 * The panel reads top to bottom as a customer profile: header (identity),
 * KPI summary, the two business departments, the two order types, and the real
 * invoices behind those aggregates. Sections are separated by LABELS, spacing
 * and hairlines rather than by a bordered card around each one — no card
 * inside card inside card.
 *
 * Two axes are shown separately, exactly as the data is stored, so a hybrid
 * order is never read as two orders:
 *   - department (كافيه / مغسلة) — from the invoice snapshot totals;
 *   - order type (طاولات / تيك اواي) — from the invoice's own `order_type`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/states'
import {
  Badge,
  Button,
  Drawer,
  MoneyDisplay,
  ProgressBar,
  Skeleton,
  TableSkeleton,
} from '@/components/ui'
import { DisplayDate, DisplayDateTime } from '@/components/ui/display-datetime'
import { CalendarClock, Car, Coffee, Droplets, Receipt, ShoppingBag } from '@/components/ui/icon'
import type { LucideIcon } from '@/components/ui/icon'
import { CustomerAvatar } from '@/lib/customer-visual'
import { cn } from '@/lib/utils'
import { useErrText } from '@/lib/err'
import { formatDate } from '@/lib/date'
import { invoiceBadgeVariant } from '@/lib/status-badge'
import { customersApi } from '@/services/customersApi'
import type { CustomerDetails, CustomerPeriod } from '@/services/customersApi'
import { CustomerVehicleBadge } from './CustomerVehicleBadge'

/** A compact premium stat block: a quiet label over a strong figure. */
function StatBlock({
  label,
  children,
  tone = 'default',
  className,
}: {
  label: string
  children: React.ReactNode
  tone?: 'default' | 'warning'
  className?: string
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
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5 border-t border-border-subtle pt-4">
      <h3 className="mb-2.5 text-caption font-bold text-foreground-muted">{title}</h3>
      {children}
    </section>
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
  icon: LucideIcon
  label: string
  orders: number
  /** Department rows carry a value; order-type rows do not. */
  amount?: number
  /** 0–1, derived from the real values by the caller. */
  share: number
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

export function CustomerDetailsDrawer({
  customerId,
  customerName,
  period,
  onClose,
}: {
  customerId: number | null
  /** Shown in the header while the real record is still loading. */
  customerName: string
  period: CustomerPeriod
  onClose: () => void
}) {
  const { t } = useTranslation()
  const errText = useErrText(t)
  const [details, setDetails] = useState<CustomerDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Bumped by the retry action, so a failed read can actually be re-issued —
  // clearing the state alone would leave the same failed request in place.
  const [revision, setRevision] = useState(0)
  const retry = useCallback(() => setRevision((value) => value + 1), [])

  const open = customerId !== null
  // The bounds are the real inputs; the memo keeps the object identity stable
  // so the effect below is not re-issued on every render.
  const from = period.from
  const to = period.to
  const bounds = useMemo(() => ({ from, to }), [from, to])

  // The period note is the user's own words about their filter, so the money in
  // this panel is never ambiguous about which window it describes.
  const periodNote =
    from || to
      ? t('customers.drawer.periodNote', {
          from: from ? formatDate(from) : '…',
          to: to ? formatDate(to) : '…',
        })
      : t('customers.drawer.allTimeNote')

  useEffect(() => {
    if (customerId === null) {
      setDetails(null)
      setError(null)
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    customersApi
      .details(customerId, bounds)
      .then((result) => {
        if (!active) return
        setDetails(result)
        setError(null)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(errText(cause))
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [customerId, bounds, revision, errText])

  const close = useCallback(() => onClose(), [onClose])

  // Bar widths are the row's share of the LARGER of its two real values — a
  // ratio of figures that both exist, never a percentage of a total the
  // backend did not send. An all-zero axis renders two empty bars rather than
  // dividing by zero.
  const cafeShare = shareOf(details?.stats.cafe_orders ?? 0, details?.stats.wash_orders ?? 0)
  const washShare = shareOf(details?.stats.wash_orders ?? 0, details?.stats.cafe_orders ?? 0)
  const takeawayShare = shareOf(
    details?.stats.takeaway_orders ?? 0,
    details?.stats.table_orders ?? 0,
  )
  const tableShare = shareOf(details?.stats.table_orders ?? 0, details?.stats.takeaway_orders ?? 0)

  return (
    <Drawer
      open={open}
      onClose={close}
      title={details?.customer.name ?? customerName}
      subtitle={periodNote}
      // Wide enough for the KPI blocks, the breakdowns and the activity list
      // to sit side by side comfortably, still capped so it never becomes a
      // second page.
      width="lg"
      header={
        <ProfileHeader
          id={customerId ?? 0}
          name={details?.customer.name ?? customerName}
          phone={details?.customer.phone ?? null}
          notes={details?.customer.notes ?? null}
          carsCount={details?.cars.length ?? null}
          createdAt={details?.created_at ?? null}
          lastAt={details?.stats.last_at ?? null}
        />
      }
      footer={
        <Button variant="outline" onClick={close}>
          {t('app.close')}
        </Button>
      }
    >
      {/* Four genuinely different situations: loading, failure, an empty
          history, and the record itself. */}
      {error ? (
        <ErrorState message={error} onRetry={retry} retryLabel={t('app.retry')} />
      ) : loading && !details ? (
        <div className="flex flex-col gap-4">
          <TableSkeleton rows={4} columns={2} />
          <div className="space-y-2">
            <Skeleton variant="text" className="h-4 w-1/3" accessibilityLabel="" />
            <Skeleton variant="text" className="h-4 w-1/2" accessibilityLabel="" />
            <Skeleton variant="text" className="h-4 w-2/3" accessibilityLabel="" />
          </div>
        </div>
      ) : !details ? null : (
        <div className="flex flex-col gap-4">
          {loading ? <ProgressBar label={t('app.loading')} /> : null}

          {/* Identity — the customer's own record, not period data. The header
              already carries name/contact/vehicle, so this section holds only
              what does not fit there: the notes and the plates themselves. */}
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

          {/* Performance — the period's headline figures, as compact blocks.
              Every value is the backend's aggregate; nothing is derived here. */}
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

          {/* Axis 1 — business (كافيه / مغسلة), from the invoice snapshot
              totals. Proportional bars against the larger of the two. */}
          <Section title={t('customers.drawer.business')}>
            <ul className="divide-y divide-border-subtle">
              <BreakdownRow
                icon={Coffee}
                label={t('customers.breakdown.cafe')}
                orders={details.stats.cafe_orders}
                amount={details.stats.cafe_total}
                share={cafeShare}
              />
              <BreakdownRow
                icon={Droplets}
                label={t('customers.breakdown.wash')}
                orders={details.stats.wash_orders}
                amount={details.stats.wash_total}
                share={washShare}
              />
            </ul>
            <p className="mt-1 text-caption text-foreground-subtle">
              {t('customers.drawer.businessHint')}
            </p>
          </Section>

          {/* Axis 2 — order type (طاولة / تيك اواي), from the invoice's own
              `order_type`. Deliberately a SEPARATE section with its own hint,
              so nobody reads a hybrid order as two orders or adds the two axes
              together. */}
          <Section title={t('customers.drawer.orderType')}>
            <ul className="divide-y divide-border-subtle">
              <BreakdownRow
                icon={ShoppingBag}
                label={t('customers.breakdown.takeaway')}
                orders={details.stats.takeaway_orders}
                share={takeawayShare}
              />
              <BreakdownRow
                icon={Receipt}
                label={t('customers.breakdown.table')}
                orders={details.stats.table_orders}
                share={tableShare}
              />
            </ul>
            <p className="mt-1 text-caption text-foreground-subtle">
              {t('customers.drawer.orderTypeHint')}
            </p>
          </Section>

          {/* Recent activity — a compact timeline of the real invoices. The
              bullet is the timeline spine; everything else is type and
              whitespace, so no row becomes its own card. */}
          <Section title={t('customers.drawer.history')}>
            {details.activity.length === 0 ? (
              <p className="text-caption text-foreground-subtle">
                {t('customers.drawer.noActivity')}
              </p>
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
        </div>
      )}
    </Drawer>
  )
}

/**
 * A one-line label/value pair for the quieter figures under the KPI blocks.
 * A `<dl>` row, so the pairing is announced as such.
 */
function LedgerRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border-subtle py-1.5 last:border-0">
      <dt className="min-w-0 truncate text-caption">{label}</dt>
      <dd className="shrink-0 text-body font-bold tabular-nums">{children}</dd>
    </div>
  )
}

/**
 * The drawer's profile header: a large deterministic avatar, the customer's
 * name as the panel's identity, the contact line, the vehicle badge, and two
 * compact lifetime facts. It is deliberately not overloaded — anything that
 * did not fit here lives in a labelled section below.
 */
function ProfileHeader({
  id,
  name,
  phone,
  notes,
  carsCount,
  createdAt,
  lastAt,
}: {
  /** The real customer ID, so the avatar tone matches the table's row exactly. */
  id: number
  name: string
  phone: string | null
  notes: string | null
  /** `null` while the record is still loading — the badge waits rather than
      claiming "no cars" before the cars have been read. */
  carsCount: number | null
  createdAt: string | null
  lastAt: string | null
}) {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 items-start gap-3.5">
      <CustomerAvatar id={id} name={name} size="lg" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-heading">{name}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span dir="ltr" className="text-caption tabular-nums">
            {phone ?? t('customers.drawer.noPhone')}
          </span>
          {carsCount !== null ? <CustomerVehicleBadge carsCount={carsCount} /> : null}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-foreground-subtle">
          {createdAt ? (
            <span className="flex items-center gap-1">
              {t('customers.identity.since')} <DisplayDate value={createdAt} />
            </span>
          ) : null}
          {lastAt ? (
            <span className="flex items-center gap-1">
              {t('customers.identity.lastActivity')} <DisplayDateTime value={lastAt} />
            </span>
          ) : null}
        </div>
        {notes ? (
          <p className="mt-1.5 line-clamp-2 text-caption text-foreground-subtle">{notes}</p>
        ) : null}
      </div>
    </div>
  )
}
