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
 *   - order type (طاولات / طلب خارجي) — from the invoice's own `order_type`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/states'
import { Button, Drawer, ProgressBar, Skeleton, TableSkeleton } from '@/components/ui'
import { DisplayDate, DisplayDateTime } from '@/components/ui/display-datetime'
import { CustomerAvatar } from '@/lib/customer-visual'
import { useErrText } from '@/lib/err'
import { formatDate } from '@/lib/date'
import { customersApi } from '@/services/customersApi'
import type { CustomerDetails, CustomerPeriod } from '@/services/customersApi'
import { CustomerVehicleBadge } from './CustomerVehicleBadge'
import {
  CustomerActivitySection,
  CustomerBreakdownSections,
  CustomerProfileSection,
  CustomerStatsSection,
} from './CustomerDetailsSections'

/**
 * The drawer's body: the four genuinely different situations it can be in.
 *
 *   error          — the read failed; offer the retry, show nothing partial.
 *   loading        — first load; reserve the geometry of the real record.
 *   record         — the payload, with a progress bar while a background
 *                    re-read (a changed period) is still in flight.
 *   nothing yet    — no record and no read in flight; render nothing.
 *
 * The ordering matters: an error outranks a still-pending re-read, because a
 * failed request is the only state the reader must act on.
 */
function CustomerDetailsBody({
  details,
  loading,
  error,
  onRetry,
}: {
  readonly details: CustomerDetails | null
  readonly loading: boolean
  readonly error: string | null
  readonly onRetry: () => void
}) {
  const { t } = useTranslation()

  if (error) {
    return <ErrorState message={error} onRetry={onRetry} retryLabel={t('app.retry')} />
  }

  if (loading && !details) {
    return <CustomerDetailsSkeleton />
  }

  if (!details) {
    return null
  }

  return (
    <div className="flex flex-col gap-4">
      {loading ? <ProgressBar label={t('app.loading')} /> : null}

      <CustomerProfileSection details={details} />

      <CustomerStatsSection details={details} />

      <CustomerBreakdownSections details={details} />

      <CustomerActivitySection details={details} />
    </div>
  )
}

export function CustomerDetailsDrawer({
  customerId,
  customerName,
  period,
  onClose,
}: {
  readonly customerId: number | null
  /** Shown in the header while the real record is still loading. */
  readonly customerName: string
  readonly period: CustomerPeriod
  readonly onClose: () => void
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

  // With no customer the drawer must show nothing at all: the KPI is manager-level
  // and a closed drawer must never keep a customer's financial figures on
  // screen. Clearing on close is a privacy/permission reset, not a reload.
  useEffect(() => {
    if (customerId === null) {
      // oxlint-disable-next-line react/set-state-in-effect -- closed-drawer reset.
      setDetails(null)
      setError(null)
      setLoading(false)
      return
    }
    let active = true
    // The drawer's read of the customer KPI. External async read; `loading` is
    // raised before the request so the drawer shows its skeleton instead of the
    // previous customer's numbers.
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
      <CustomerDetailsBody details={details} loading={loading} error={error} onRetry={retry} />
    </Drawer>
  )
}

/**
 * The drawer's first-load placeholder.
 *
 * It reserves the geometry of the real record — a table of figures over a short
 * block of notes — so the drawer does not jump when the customer resolves, and
 * it is one announced region rather than a screen reader full of empty boxes.
 */
function CustomerDetailsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <TableSkeleton rows={4} columns={2} />
      <div className="space-y-2">
        <Skeleton variant="text" className="h-4 w-1/3" accessibilityLabel="" />
        <Skeleton variant="text" className="h-4 w-1/2" accessibilityLabel="" />
        <Skeleton variant="text" className="h-4 w-2/3" accessibilityLabel="" />
      </div>
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
  readonly id: number
  readonly name: string
  readonly phone: string | null
  readonly notes: string | null
  /** `null` while the record is still loading — the badge waits rather than
      claiming "no cars" before the cars have been read. */
  readonly carsCount: number | null
  readonly createdAt: string | null
  readonly lastAt: string | null
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
