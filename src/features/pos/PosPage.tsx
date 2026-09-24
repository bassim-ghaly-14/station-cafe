/** The main POS screen: safe table grid + live order panel + payment + takeaway.
 * Card click NEVER mutates table state — only explicit action buttons call the backend.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Card, CardHeader, Dialog, MoneyDisplay } from '@/components/ui'
import { ClipboardList, DoorClosed, DoorOpen, Receipt, ShoppingBag } from '@/components/ui/icon'
import { ErrorState } from '@/components/states'
import { useToast } from '@/components/ui'
import {
  api,
  type DiscountSel,
  type OrderPreview,
  type PosOrder,
  type TableView,
  type TakeawayView,
} from '@/services/posApi'
import { shiftApi, type DayShiftState } from '@/services/shiftApi'
import { atLeast, useSession } from '@/features/auth/useSession'
import { CurrentShiftPanel } from './CurrentShiftPanel'
import { DayClosingPanel } from './DayClosingPanel'
import { OrderPanel } from './OrderPanel'
import { PaymentDialog } from './PaymentDialog'
import { ShiftGate } from './ShiftGate'
import { TodayInvoices } from './TodayInvoices'

/**
 * Shared visual treatment for explicit "start/open" actions.
 *
 * These actions mutate POS state and therefore intentionally use the
 * success identity with white content.
 */
const startActionClassName = 'bg-success text-white hover:bg-success/90 active:bg-success/80'

export default function PosPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const { user } = useSession()
  const [shiftState, setShiftState] = useState<DayShiftState | null>(null)
  const [tables, setTables] = useState<TableView[] | null>(null)
  const [takeaways, setTakeaways] = useState<TakeawayView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null)
  const [activeOrder, setActiveOrder] = useState<PosOrder | null>(null)
  const [payOpen, setPayOpen] = useState(false)
  const [preview, setPreview] = useState<OrderPreview | null>(null)
  const [discount, setDiscount] = useState<DiscountSel>({ mode: null, value: null })
  const [invoicesOpen, setInvoicesOpen] = useState(false)
  const [closeTarget, setCloseTarget] = useState<TableView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [tv, tk, st] = await Promise.all([api.tables(), api.openTakeaways(), shiftApi.state()])

      setTables(tv)
      setTakeaways(tk)
      setShiftState(st)
      setError(null)
    } catch (e) {
      setError(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']))
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (activeOrder) {
      api
        .preview(activeOrder.id, discount.mode, discount.value)
        .then(setPreview)
        .catch(() => setPreview(null))
    } else {
      setPreview(null)
    }
  }, [activeOrder, discount.mode, discount.value])

  if (error) {
    return <ErrorState message={error} onRetry={() => void refresh()} retryLabel={t('app.retry')} />
  }

  if (!tables) return <p>{t('app.loading')}</p>

  if (!shiftState) return <p>{t('app.loading')}</p>

  if (!shiftState.day || !shiftState.my_shift) {
    return (
      <div className="space-y-4">
        {atLeast(user?.role, 'MANAGER') && shiftState.day ? (
          <DayClosingPanel dayId={shiftState.day.id} onDone={refresh} />
        ) : null}

        <ShiftGate state={shiftState} onReady={() => void refresh()} />
      </div>
    )
  }

  const report = (e: unknown) => {
    void refresh()

    toast(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']), 'error')
  }

  // Card click is SAFE: selection/inspection only — never a backend mutation.
  const selectTable = (tv: TableView) => setSelectedTableId(tv.id)

  const openSelectedTable = async (tv: TableView) => {
    setBusy(`open-${tv.id}`)

    try {
      await api.openTable(tv.id)

      toast(t('pos.openedMessage', { label: tv.label }), 'success')

      await refresh()
    } catch (e) {
      report(e)
    } finally {
      setBusy(null)
    }
  }

  const confirmCloseEmpty = async () => {
    if (!closeTarget) return

    setBusy(`close-${closeTarget.id}`)

    try {
      await api.closeEmptyTable(closeTarget.id)

      toast(t('pos.closedEmptyMessage', { label: closeTarget.label }), 'success')

      setCloseTarget(null)

      await refresh()
    } catch (e) {
      setCloseTarget(null)
      report(e)
    } finally {
      setBusy(null)
    }
  }

  // Single order-loading path shared by EVERY entry point (table card,
  // takeaway chip, start order, start takeaway): one authoritative snapshot,
  // one discount resync — never a second source of truth for any of them.
  const loadOrder = async (orderId: number) => {
    const order = await api.getOrder(orderId)

    setActiveOrder(order)

    // Re-sync the shared discount from the PERSISTED order row — the backend
    // is authoritative, so refresh / reopen / restart never loses the discount.
    setDiscount({
      mode: order.discount_mode ?? null,
      value: order.discount_value ?? null,
    })

    setPayOpen(false)
  }

  const startOrderFor = async (tv: TableView) => {
    setBusy(`order-${tv.id}`)

    try {
      const orderId = await api.startOrder(tv.id)

      await loadOrder(orderId)
      await refresh()
    } catch (e) {
      report(e)
    } finally {
      setBusy(null)
    }
  }

  const openOrderFor = async (tv: TableView) => {
    if (!tv.order_id) return

    try {
      await loadOrder(tv.order_id)
    } catch (e) {
      report(e)
    }
  }

  // Reopen a still-open takeaway from the discoverable list: the backend
  // order is loaded with ALL persisted data (lines, prices, totals, type).
  const reopenTakeaway = async (orderId: number) => {
    try {
      await loadOrder(orderId)
    } catch (e) {
      report(e)
    }
  }

  const startTakeaway = async () => {
    setBusy('takeaway')

    try {
      const orderId = await api.startTakeaway()

      await loadOrder(orderId)

      toast(t('pos.takeawayStarted'), 'success')

      await refresh()
    } catch (e) {
      report(e)
    } finally {
      setBusy(null)
    }
  }

  const discardActiveOrder = async () => {
    if (!activeOrder || activeOrder.lines.length > 0) return

    setBusy('discard')

    try {
      await api.discardOrder(activeOrder.id)

      setActiveOrder(null)

      toast(t('pos.discardedMessage'), 'success')

      await refresh()
    } catch (e) {
      report(e)
    } finally {
      setBusy(null)
    }
  }

  const selected = tables.find((x) => x.id === selectedTableId) ?? null
  const takeawayActive = activeOrder?.order_type === 'TAKEAWAY'

  /*
   * Progressive workspace:
   *
   * No active order:
   *   tables use the available width.
   *
   * Active order:
   *   tables remain the dominant area.
   *   The order panel is intentionally capped around 460px so it does not
   *   consume the table workspace.
   */
  const hasWorkspace = activeOrder !== null || selected !== null

  return (
    <div className="flex flex-col gap-4">
      {/* Shift + Day closing */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CurrentShiftPanel
          shift={shiftState.my_shift}
          onClosed={async () => {
            toast(t('shift.closedSuccess'), 'success')
            await refresh()
          }}
        />

        {atLeast(user?.role, 'MANAGER') && shiftState.day ? (
          <DayClosingPanel dayId={shiftState.day.id} onDone={refresh} />
        ) : null}
      </div>

      <div
        className={
          hasWorkspace ? 'grid gap-4 xl:grid-cols-[minmax(0,1fr)_460px]' : 'flex flex-col gap-4'
        }
      >
        <Card className={hasWorkspace ? 'min-w-0' : 'w-full'}>
          <CardHeader
            title={t('pos.tables')}
            actions={
              <Button variant="outline" size="sm" onClick={() => setInvoicesOpen(true)}>
                <Receipt size={16} aria-hidden />
                {t('pos.todayInvoices')}
              </Button>
            }
          />

          {takeaways && takeaways.length > 0 ? (
            <OpenTakeaways
              items={takeaways}
              activeOrderId={activeOrder?.id ?? null}
              onOpen={(orderId) => void reopenTakeaway(orderId)}
            />
          ) : null}

          <div
            className={
              hasWorkspace
                ? 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-3 2xl:grid-cols-4'
                : 'grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5'
            }
          >
            {/* Takeaway action card — always first */}
            <TakeawayCard busy={busy === 'takeaway'} onStart={() => void startTakeaway()} />

            {tables.map((tv) => (
              <TableCard
                key={tv.id}
                tv={tv}
                selected={selectedTableId === tv.id}
                active={activeOrder?.id === tv.order_id && !!tv.order_id}
                busy={busy}
                onSelect={() => selectTable(tv)}
                onOpen={() => void openSelectedTable(tv)}
                onStartOrder={() => void startOrderFor(tv)}
                onOpenOrder={() => void openOrderFor(tv)}
                onCloseEmpty={() => setCloseTarget(tv)}
              />
            ))}
          </div>

          <p className="mt-3 text-xs text-foreground-subtle">{t('pos.emptyTablesHint')}</p>
        </Card>

        <div className={hasWorkspace ? 'min-w-0' : ''}>
          {activeOrder ? (
            <>
              {takeawayActive ? (
                <p className="mb-2 flex flex-wrap items-center gap-2 text-sm font-bold text-foreground-strong">
                  <Badge tone="info">
                    <ShoppingBag size={14} aria-hidden />
                    {t('pos.takeawayActive')}
                  </Badge>

                  {typeof activeOrder.takeaway_no === 'number' ? (
                    <span>
                      {t('pos.takeawayNo')}: <span dir="ltr">#{activeOrder.takeaway_no}</span>
                    </span>
                  ) : (
                    <span className="font-medium text-foreground-subtle">
                      {t('pos.takeawayHint')}
                    </span>
                  )}
                </p>
              ) : null}

              <OrderPanel
                order={activeOrder}
                preview={preview}
                discount={discount}
                onDiscountChange={(d: DiscountSel) => setDiscount(d)}
                onChange={setActiveOrder}
                onRefreshTables={() => void refresh()}
                onPay={() => setPayOpen(true)}
                onDiscard={
                  activeOrder.lines.length === 0 ? () => void discardActiveOrder() : undefined
                }
                discarding={busy === 'discard'}
              />
            </>
          ) : selected ? (
            <Card>
              <CardHeader title={selected.label} subtitle={t(`pos.state.${selected.status}`)} />

              <SelectedTableActions
                tv={selected}
                busy={busy}
                onOpen={() => void openSelectedTable(selected)}
                onStartOrder={() => void startOrderFor(selected)}
                onOpenOrder={() => void openOrderFor(selected)}
                onCloseEmpty={() => setCloseTarget(selected)}
              />
            </Card>
          ) : (
            <p className="text-sm text-foreground-subtle">{t('pos.selectTableHint')}</p>
          )}
        </div>
      </div>

      {activeOrder && payOpen ? (
        <PaymentDialog
          orderId={activeOrder.id}
          discount={discount}
          order={activeOrder}
          onClose={() => setPayOpen(false)}
          onDone={(invoiceId, outcome) => {
            setPayOpen(false)
            setActiveOrder(null)
            setDiscount({ mode: null, value: null })
            void refresh()

            if (outcome?.duplicate_suppressed) {
              toast(t('print.duplicateSuppressed'), 'info')
            } else {
              toast(t('pos.paidMessage', { no: invoiceId }), 'success')
            }
          }}
        />
      ) : null}

      {closeTarget ? (
        <Dialog open onClose={() => setCloseTarget(null)} title={t('pos.closeEmptyTitle')}>
          <p className="mb-4 text-sm text-foreground-muted">
            {t('pos.closeEmptyBody', { label: closeTarget.label })}
          </p>

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setCloseTarget(null)}>
              {t('app.cancel')}
            </Button>

            <Button
              variant="destructive"
              onClick={() => void confirmCloseEmpty()}
              loading={busy === `close-${closeTarget.id}`}
            >
              <DoorClosed size={16} aria-hidden />
              {t('pos.closeEmpty')}
            </Button>
          </div>
        </Dialog>
      ) : null}

      {invoicesOpen ? <TodayInvoices onClose={() => setInvoicesOpen(false)} /> : null}
    </div>
  )
}

/**
 * Dedicated action card for starting a new takeaway order.
 *
 * It intentionally matches the table-card geometry so takeaway becomes
 * a first-class POS destination instead of looking like a toolbar action.
 */
export function TakeawayCard({ busy, onStart }: { busy: boolean; onStart: () => void }) {
  const { t } = useTranslation()

  return (
    <article
      aria-label={t('pos.startTakeaway')}
      data-testid="takeaway-card"
      className={[
        'group relative flex min-h-56 flex-col overflow-hidden',
        'rounded-lg border border-info/30',
        'bg-info/10 p-4 text-start',
        'transition-[border-color,background-color,box-shadow]',
        'duration-200',
        'hover:border-info/50 hover:bg-info/15',
        'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus',
      ].join(' ')}
    >
      {/* Takeaway identity stripe */}
      <span aria-hidden className="absolute inset-y-0 inset-s-0 w-1 bg-info" />

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-info">
            {t('pos.takeaway')}
          </p>

          <p className="mt-1 truncate text-lg font-bold leading-tight text-foreground-strong">
            {t('pos.startTakeaway')}
          </p>
        </div>

        {/* Takeaway visual identity */}
        <div
          aria-hidden
          className={[
            'flex size-11 shrink-0 items-center justify-center',
            'rounded-md border border-info/30',
            'bg-info/10 text-info',
            'transition-transform duration-200',
            'group-hover:scale-105',
          ].join(' ')}
        >
          <ShoppingBag size={22} strokeWidth={2.2} />
        </div>
      </div>

      {/* Order ticket surface */}
      <div
        className={[
          'relative mt-4 flex flex-1 flex-col justify-center',
          'overflow-hidden rounded-md',
          'border border-border/80',
          'bg-background/50',
          'px-3 py-3',
        ].join(' ')}
      >
        {/* Decorative ticket perforation */}
        <span
          aria-hidden
          className="absolute -inset-s-1.5 top-1/2 size-3 -translate-y-1/2 rounded-full border border-border bg-surface"
        />

        <span
          aria-hidden
          className="absolute -inset-e-1.5 top-1/2 size-3 -translate-y-1/2 rounded-full border border-border bg-surface"
        />

        <div className="flex items-center gap-3 px-1">
          <div
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-md bg-info/10 text-info"
          >
            <ShoppingBag size={18} />
          </div>

          <div className="min-w-0">
            <p className="text-xs font-semibold text-foreground-subtle">{t('pos.takeawayHint')}</p>

            <p className="mt-0.5 truncate text-sm font-bold text-foreground-strong">
              {t('pos.takeaway')}
            </p>
          </div>
        </div>

        <div aria-hidden className="mt-3 border-t border-dashed border-border/80" />
      </div>

      {/* Action */}
      <div className="mt-3">
        <Button
          className={`w-full ${startActionClassName}`}
          size="sm"
          onClick={onStart}
          loading={busy}
          aria-label={t('pos.startTakeaway')}
        >
          <ShoppingBag size={16} aria-hidden />
          {t('pos.startTakeaway')}
        </Button>
      </div>
    </article>
  )
}

/**
 * Compact list of OPEN takeaway orders inside the existing POS workspace.
 * The backend is the source of truth: clicking a row reopens the persisted
 * order with all its data. Rows disappear once the order is paid.
 */
export function OpenTakeaways({
  items,
  activeOrderId,
  onOpen,
}: {
  items: TakeawayView[]
  activeOrderId: number | null
  onOpen: (orderId: number) => void
}) {
  const { t } = useTranslation()

  return (
    <section
      aria-label={t('pos.openTakeaways')}
      className={['mb-3 rounded-md border border-info/30', 'bg-info/4', 'px-3 py-2.5'].join(' ')}
    >
      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-info">
        <ShoppingBag size={14} aria-hidden />
        {t('pos.openTakeaways')}
      </p>

      <ul className="flex flex-wrap gap-2">
        {items.map((tk) => {
          const active = activeOrderId === tk.id

          return (
            <li key={tk.id}>
              <Button
                variant="outline"
                className={[
                  'border-info/30',
                  'transition-colors duration-150',

                  active
                    ? [
                        'border-info',
                        'bg-info text-white',
                        'shadow-sm',
                        'hover:border-info',
                        'hover:bg-info/90',
                        'active:bg-info/80',
                      ].join(' ')
                    : [
                        'bg-info/3',
                        'text-info',
                        'hover:border-info/50',
                        'hover:bg-info/10',
                        'hover:text-info',
                        'active:bg-info/16',
                      ].join(' '),
                ].join(' ')}
                size="sm"
                onClick={() => onOpen(tk.id)}
                aria-label={`${t('pos.openOrder')} — ${t('pos.takeaway')} ${tk.id}`}
                data-testid={`open-takeaway-${tk.id}`}
              >
                <ShoppingBag size={15} aria-hidden />

                <span className="font-bold">
                  {t('pos.takeaway')} · {t('pos.order')} {tk.id}
                </span>

                {tk.opened_at ? (
                  <span className={active ? 'text-white/70' : 'text-info/70'} dir="ltr">
                    {tk.opened_at.slice(11, 16)}
                  </span>
                ) : null}

                <span className={active ? 'text-white/70' : 'text-info/70'}>
                  {tk.items_count} {t('pos.items')}
                </span>

                <span className={active ? 'text-white' : 'text-info'}>
                  <MoneyDisplay amount={tk.total_minor} />
                </span>
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function TableCard({
  tv,
  selected,
  active,
  busy,
  onSelect,
  onOpen,
  onStartOrder,
  onOpenOrder,
  onCloseEmpty,
}: {
  tv: TableView
  selected: boolean
  active: boolean
  busy: string | null
  onSelect: () => void
  onOpen: () => void
  onStartOrder: () => void
  onOpenOrder: () => void
  onCloseEmpty: () => void
}) {
  const { t } = useTranslation()

  const tone =
    tv.status === 'EMPTY'
      ? 'danger'
      : tv.status === 'OPEN'
        ? 'info'
        : tv.status === 'OCCUPIED'
          ? 'success'
          : 'warning'

  const isEmpty = tv.status === 'EMPTY'
  const isOpen = tv.status === 'OPEN'

  const statusLabel = t(`pos.state.${tv.status}`)

  return (
    <article
      aria-label={`${tv.label} — ${statusLabel}`}
      aria-current={selected ? true : undefined}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      tabIndex={0}
      data-testid={`table-card-${tv.id}`}
      className={[
        'group relative flex min-h-56 cursor-pointer flex-col overflow-hidden',
        'rounded-lg border p-4 text-start',
        'transition-[border-color,background-color,box-shadow]',
        'duration-200',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        selected
          ? 'border-primary bg-accent shadow-sm'
          : active
            ? 'border-success-soft bg-success-soft/20'
            : 'border-border-strong bg-transparent hover:border-border-accent-hover hover:bg-accent/60',
      ].join(' ')}
    >
      {/* Status accent */}
      <span
        aria-hidden
        className={[
          'absolute inset-y-0 inset-s-0 w-1',
          tone === 'danger'
            ? 'bg-danger'
            : tone === 'info'
              ? 'bg-info'
              : tone === 'success'
                ? 'bg-success'
                : 'bg-warning',
        ].join(' ')}
      />

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 truncate text-lg font-bold leading-tight text-foreground-strong">
          {tv.label}
        </p>

        <Badge tone={tone}>{statusLabel}</Badge>
      </div>

      {/* Main information */}
      <div className="mt-4 flex min-h-16 flex-1 flex-col justify-center">
        {isEmpty ? (
          <>
            <p className="text-xs font-medium text-foreground-subtle">{t('pos.items')}</p>

            <p className="mt-1 text-base font-bold tabular-nums text-foreground-strong">0</p>

            <p className="mt-2 text-xs text-foreground-subtle">{t('pos.emptyTableHint')}</p>
          </>
        ) : (
          <>
            <p className="text-xs font-medium text-foreground-subtle">{t('pos.items')}</p>

            <div className="mt-1 flex items-end justify-between gap-3">
              <span className="text-base font-bold tabular-nums text-foreground-strong">
                {tv.items_count}
              </span>

              <span className="text-xl font-bold leading-none tabular-nums text-foreground-strong">
                <MoneyDisplay amount={tv.total_minor} />
              </span>
            </div>
          </>
        )}
      </div>

      {/* Daily counters */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="min-w-0 rounded-md border border-border bg-background/40 px-2.5 py-2">
          <p className="truncate text-[10px] font-medium leading-tight text-foreground-subtle">
            {t('pos.opensToday')}
          </p>

          <p className="mt-0.5 text-sm font-bold leading-tight tabular-nums text-foreground-strong">
            {tv.opens_today}
          </p>
        </div>

        <div className="min-w-0 rounded-md border border-border bg-background/40 px-2.5 py-2">
          <p className="truncate text-[10px] font-medium leading-tight text-foreground-subtle">
            {t('pos.closedEmptyToday')}
          </p>

          <p className="mt-0.5 text-sm font-bold leading-tight tabular-nums text-foreground-strong">
            {tv.closed_empty_today}
          </p>
        </div>
      </div>

      {/* State-dependent actions */}
      <div className="mt-3 flex min-h-9 items-center gap-2">
        {isEmpty ? (
          <Button
            size="sm"
            className={`w-full ${startActionClassName}`}
            onClick={(e) => {
              e.stopPropagation()
              onOpen()
            }}
            loading={busy === `open-${tv.id}`}
            aria-label={`${t('pos.openTable')} — ${tv.label}`}
          >
            <DoorOpen size={16} aria-hidden />
            {t('pos.openTable')}
          </Button>
        ) : isOpen ? (
          <>
            <Button
              className={`min-w-0 flex-1 ${startActionClassName}`}
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                onStartOrder()
              }}
              loading={busy === `order-${tv.id}`}
              aria-label={`${t('pos.startOrder')} — ${tv.label}`}
            >
              <ClipboardList size={16} aria-hidden />
              {t('pos.startOrder')}
            </Button>

            <Button
              className="min-w-0 flex-1"
              size="sm"
              variant="destructiveGhost"
              onClick={(e) => {
                e.stopPropagation()
                onCloseEmpty()
              }}
              loading={busy === `close-${tv.id}`}
              aria-label={`${t('pos.closeEmpty')} — ${tv.label}`}
            >
              <DoorClosed size={16} aria-hidden />
              {t('pos.closeEmpty')}
            </Button>
          </>
        ) : (
          <Button
            className="w-full"
            size="sm"
            variant="secondary"
            onClick={(e) => {
              e.stopPropagation()
              onOpenOrder()
            }}
            aria-label={`${t('pos.openOrder')} — ${tv.label}`}
          >
            <ClipboardList size={16} aria-hidden />
            {t('pos.openOrder')}
          </Button>
        )}
      </div>
    </article>
  )
}

function SelectedTableActions({
  tv,
  busy,
  onOpen,
  onStartOrder,
  onOpenOrder,
  onCloseEmpty,
}: {
  tv: TableView
  busy: string | null
  onOpen: () => void
  onStartOrder: () => void
  onOpenOrder: () => void
  onCloseEmpty: () => void
}) {
  const { t } = useTranslation()

  if (tv.status === 'EMPTY') {
    return (
      <Button className={startActionClassName} onClick={onOpen} loading={busy === `open-${tv.id}`}>
        <DoorOpen size={16} aria-hidden />
        {t('pos.openTable')}
      </Button>
    )
  }

  if (tv.status === 'OPEN') {
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          className={startActionClassName}
          onClick={onStartOrder}
          loading={busy === `order-${tv.id}`}
        >
          <ClipboardList size={16} aria-hidden />
          {t('pos.startOrder')}
        </Button>

        <Button variant="outline" onClick={onCloseEmpty}>
          <DoorClosed size={16} aria-hidden />
          {t('pos.closeEmpty')}
        </Button>
      </div>
    )
  }

  return (
    <Button variant="secondary" onClick={onOpenOrder}>
      <ClipboardList size={16} aria-hidden />
      {t('pos.openOrder')}
    </Button>
  )
}
