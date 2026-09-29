/** The main POS screen: safe table grid + live order panel + payment + takeaway.
 * Card click NEVER mutates table state — only explicit action buttons call the backend.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogActions,
  DisplayTime,
  Loader,
  MoneyDisplay,
  useToast,
} from '@/components/ui'
import {
  ClipboardList,
  CalendarDays,
  Clock,
  DoorClosed,
  DoorOpen,
  Receipt,
  ShoppingBag,
  Ticket,
} from '@/components/ui/icon'
import { ErrorState } from '@/components/states'
import { formatDate, formatDateTime } from '@/lib/date'
import {
  api,
  settingsApi,
  type DiscountSel,
  type OrderPreview,
  type PosOrder,
  type PrintOutcome,
  type TableView,
  type TakeawayView,
} from '@/services/posApi'
import { shiftApi, type DayShiftState } from '@/services/shiftApi'
import { tableBadgeVariant } from '@/lib/status-badge'
import { cn } from '@/lib/utils'
import { atLeast, useSession } from '@/features/auth/useSession'
import type { UserRole } from '@/lib/roles'
import { useRouter, type View } from '@/app/router'
import { CurrentShiftPanel } from './CurrentShiftPanel'
import { DayClosingPanel } from './DayClosingPanel'
import { OrderPanel } from './OrderPanel'
import { PaymentDialog } from './PaymentDialog'
import { ShiftGate } from './ShiftGate'

/**
 * Shared visual treatment for explicit "start/open" actions.
 *
 * These actions mutate POS state and therefore intentionally use the
 * success identity with white content.
 */
const startActionClassName =
  'bg-success-solid text-success-solid-foreground hover:bg-success-solid-hover active:bg-success-solid-active'

export default function PosPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const { user } = useSession()
  const { navigate } = useRouter()
  const [shiftState, setShiftState] = useState<DayShiftState | null>(null)
  const [tables, setTables] = useState<TableView[] | null>(null)
  const [takeaways, setTakeaways] = useState<TakeawayView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null)
  const [activeOrder, setActiveOrder] = useState<PosOrder | null>(null)
  const [payOpen, setPayOpen] = useState(false)
  const [preview, setPreview] = useState<OrderPreview | null>(null)
  const [discount, setDiscount] = useState<DiscountSel>({ mode: null, value: null })
  const [serviceCharge, setServiceCharge] = useState(0)
  const [serviceChargeOptions, setServiceChargeOptions] = useState<number[]>([])
  const [closeTarget, setCloseTarget] = useState<TableView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /**
   * Single POS data-revision signal.
   *
   * `refresh()` is the screen's one invalidation point — it already re-reads
   * every POS source after a sale, a table change or a closing. Bumping this
   * counter there lets dependent panels (the day-closing card) reload from
   * their own commands without polling, without a timer, and without a second
   * copy of the shared data.
   */
  const [revision, setRevision] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const [tv, tk, st] = await Promise.all([api.tables(), api.openTakeaways(), shiftApi.state()])

      setTables(tv)
      setTakeaways(tk)
      setShiftState(st)
      setError(null)
    } catch (e) {
      setError(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']))
    } finally {
      setRevision((value) => value + 1)
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    // The service-charge quick-picks are an OPTION list, not part of opening the
    // POS. A failure here must never take the whole screen down with it, but it
    // must also not become an unhandled rejection: the sibling preview effect
    // below degrades to "no preview" rather than leaving a rejection dangling.
    void settingsApi
      .serviceCharge()
      .then((config) => setServiceChargeOptions(config.amounts))
      .catch(() => setServiceChargeOptions([]))
  }, [])

  useEffect(() => {
    if (activeOrder) {
      api
        .preview(activeOrder.id, discount.mode, discount.value, serviceCharge)
        .then(setPreview)
        .catch(() => setPreview(null))
    } else {
      setPreview(null)
    }
  }, [activeOrder, discount.mode, discount.value, serviceCharge])

  if (error) {
    return <ErrorState message={error} onRetry={() => void refresh()} retryLabel={t('app.retry')} />
  }

  if (!tables || !shiftState) {
    return (
      <output aria-label={t('app.loading')} className="flex min-h-64 justify-center py-16">
        <Loader size="lg" />
      </output>
    )
  }

  if (!shiftState.day || !shiftState.my_shift) {
    return (
      <PosShiftGateView
        canCloseDay={dayClosingDay(user?.role, shiftState.day) !== null}
        state={shiftState}
        revision={revision}
        onDone={refresh}
        onReady={() => void refresh()}
      />
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

    // A service charge is a CHECKOUT selection, never order state: it is not
    // persisted on the order (the invoice is its only snapshot). So it MUST be
    // cleared at every order-context change, or it silently follows the cashier
    // onto the next order and charges a customer who never selected it.
    setServiceCharge(0)

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

  const layout = workspaceLayout(hasWorkspace)
  const counts = tableCounts(tables)

  return (
    /*
     * `gap-5` steps down to `gap-4` on a phone. Horizontal width is the scarce
     * resource on a phone, but a stack of cards separated by five 20px gaps is
     * a lot of scrolling past nothing, and it pushes the product pad below the
     * fold.
     */
    <div className="flex flex-col gap-4 sm:gap-5">
      {/*
        Page header: shift/session state is the first thing a cashier must read,
        and history ("فواتير اليوم") belongs with operations — never next to the
        new-order actions it would compete with.
      */}
      <PosHeader state={shiftState} onNavigate={navigate} />

      {/* The selling workspace: its responsive class set is described on
          `workspaceLayout`, and the DOM order below is deliberately tables
          first. */}
      <div className={layout.grid}>
        <TablesCard
          layout={layout}
          tables={tables}
          counts={counts}
          takeaways={takeaways}
          activeOrderId={activeOrder?.id ?? null}
          selectedTableId={selectedTableId}
          busy={busy}
          onStartTakeaway={() => void startTakeaway()}
          onReopenTakeaway={(orderId) => void reopenTakeaway(orderId)}
          onSelectTable={selectTable}
          onOpenTable={openSelectedTable}
          onStartOrder={startOrderFor}
          onOpenOrder={openOrderFor}
          onCloseEmpty={setCloseTarget}
        />

        {/* The counterpart to the tables card's `order-2`: first on a phone. */}
        <div className={layout.orderColumn}>
          {activeOrder ? (
            <>
              {takeawayActive ? <TakeawayActiveBanner order={activeOrder} /> : null}

              <OrderPanel
                order={activeOrder}
                preview={preview}
                discount={discount}
                serviceCharge={serviceCharge}
                serviceChargeOptions={serviceChargeOptions}
                onServiceChargeChange={setServiceCharge}
                onDiscountChange={(d: DiscountSel) => setDiscount(d)}
                onChange={setActiveOrder}
                onRefreshTables={() => void refresh()}
                onPay={() => setPayOpen(true)}
                onDiscard={
                  // The SERVICE rejects cancelling a ticketed order, so the UI
                  // must not offer it either. `waiting_no` is written in the
                  // same transaction as the ticket row, so it is the same fact
                  // the backend reads — this hides a dead action, it is not the
                  // enforcement.
                  activeOrder.lines.length === 0 && activeOrder.waiting_no === null
                    ? () => void discardActiveOrder()
                    : undefined
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

      <OperationalControls
        shift={shiftState.my_shift}
        day={dayClosingDay(user?.role, shiftState.day)}
        revision={revision}
        onShiftClosed={async () => {
          toast(t('shift.closedSuccess'), 'success')
          await refresh()
        }}
        onShiftRefresh={refresh}
        onDayDone={refresh}
      />

      <PosDialogs
        activeOrder={activeOrder}
        payOpen={payOpen}
        discount={discount}
        serviceCharge={serviceCharge}
        closeTarget={closeTarget}
        busy={busy}
        onPayClose={() => setPayOpen(false)}
        onPaid={(invoiceId, outcome) => {
          setPayOpen(false)
          setActiveOrder(null)
          setDiscount({ mode: null, value: null })
          // The charge was snapshotted onto the invoice; the checkout
          // selection is now spent and must not leak into the next order.
          setServiceCharge(0)
          void refresh()

          if (outcome?.duplicate_suppressed) {
            toast(t('print.duplicateSuppressed'), 'info')
          } else {
            toast(t('pos.paidMessage', { no: invoiceId }), 'success')
          }
        }}
        onCloseEmptyCancel={() => setCloseTarget(null)}
        onCloseEmptyConfirm={() => void confirmCloseEmpty()}
      />
    </div>
  )
}

/**
 * The open day, but only for a manager.
 *
 * Day closing is a manager action, so a cashier never sees the closing card and
 * the shift gate below it is the whole screen. `null` means "no closing card",
 * which is what both the gate and the operational-controls row ask for.
 */
function dayClosingDay(
  role: UserRole | undefined,
  day: DayShiftState['day'],
): DayShiftState['day'] | null {
  return atLeast(role, 'MANAGER') && day ? day : null
}

/** The legend numbers under the tables card title. */
function tableCounts(tables: TableView[]): { empty: number; open: number; occupied: number } {
  return {
    empty: tables.filter((tv) => tv.status === 'EMPTY').length,
    open: tables.filter((tv) => tv.status === 'OPEN').length,
    occupied: tables.filter((tv) => tv.status === 'OCCUPIED' || tv.status === 'READY_TO_PAY')
      .length,
  }
}

/**
 * The selling workspace's responsive class set.
 *
 * Desktop: tables on the inline-start, the order panel in a 460px column at the
 * inline-end. Unchanged.
 *
 * Phone: the SAME two elements in the OPPOSITE order. With an order open the
 * order panel is what the cashier is working on — it holds the product pad, the
 * running total and the pay action — so putting it first means the products and
 * the pay button are reachable without scrolling past every table card first.
 * Before this, adding an item to an order on a phone meant: scroll down past
 * the whole table grid, scroll back up to the order panel, repeat on every
 * single item.
 *
 * The switch is `order-*` classes rather than a reordered DOM, so the reading
 * order and the desktop layout are both untouched — and the grid gets denser as
 * it grows, which is why a workspace with five open tables fits without
 * scrolling while the idle grid stays comfortable.
 */
function workspaceLayout(hasWorkspace: boolean): WorkspaceLayout {
  return {
    grid: hasWorkspace ? 'grid gap-4 xl:grid-cols-[minmax(0,1fr)_460px]' : 'flex flex-col gap-4',
    tablesCard: hasWorkspace ? 'min-w-0' : 'w-full',
    tablesOrder: hasWorkspace ? 'order-2 xl:order-1' : undefined,
    tablesGrid: hasWorkspace
      ? 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-3 2xl:grid-cols-4'
      : 'grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5',
    orderColumn: hasWorkspace ? 'order-1 min-w-0 xl:order-2' : '',
  }
}

interface WorkspaceLayout {
  readonly grid: string
  readonly tablesCard: string
  readonly tablesOrder: string | undefined
  readonly tablesGrid: string
  readonly orderColumn: string
}

/**
 * The tables side of the selling workspace: open takeaways, the takeaway
 * action card and every table card.
 *
 * It only reads what the page owns — selection, the active order id and the busy
 * label — and hands every mutation back to the page's own commands, so no
 * table/takeaway rule lives in here.
 */
function TablesCard({
  layout,
  tables,
  counts,
  takeaways,
  activeOrderId,
  selectedTableId,
  busy,
  onStartTakeaway,
  onReopenTakeaway,
  onSelectTable,
  onOpenTable,
  onStartOrder,
  onOpenOrder,
  onCloseEmpty,
}: {
  readonly layout: WorkspaceLayout
  readonly tables: TableView[]
  readonly counts: { empty: number; open: number; occupied: number }
  readonly takeaways: TakeawayView[] | null
  readonly activeOrderId: number | null
  readonly selectedTableId: number | null
  readonly busy: string | null
  readonly onStartTakeaway: () => void
  readonly onReopenTakeaway: (orderId: number) => void
  readonly onSelectTable: (tv: TableView) => void
  readonly onOpenTable: (tv: TableView) => void
  readonly onStartOrder: (tv: TableView) => void
  readonly onOpenOrder: (tv: TableView) => void
  readonly onCloseEmpty: (tv: TableView) => void
}) {
  const { t } = useTranslation()

  return (
    <Card aria-label={t('pos.tables')} className={cn(layout.tablesCard, layout.tablesOrder)}>
      <CardHeader title={t('pos.tables')} subtitle={t('pos.tablesLegend', counts)} />

      {takeaways && takeaways.length > 0 ? (
        <OpenTakeaways items={takeaways} activeOrderId={activeOrderId} onOpen={onReopenTakeaway} />
      ) : null}

      <div className={layout.tablesGrid}>
        {/* Takeaway action card — always first */}
        <TakeawayCard busy={busy === 'takeaway'} onStart={onStartTakeaway} />

        {tables.map((tv) => (
          <TableCard
            key={tv.id}
            tv={tv}
            selected={selectedTableId === tv.id}
            active={activeOrderId === tv.order_id && !!tv.order_id}
            busy={busy}
            onSelect={() => onSelectTable(tv)}
            onOpen={() => onOpenTable(tv)}
            onStartOrder={() => onStartOrder(tv)}
            onOpenOrder={() => onOpenOrder(tv)}
            onCloseEmpty={() => onCloseEmpty(tv)}
          />
        ))}
      </div>

      <p className="mt-3 text-xs text-foreground-subtle">{t('pos.emptyTablesHint')}</p>
    </Card>
  )
}

/**
 * The page header: shift/session state and the two daily records.
 *
 * Shift state is the first thing a cashier must read, and history belongs with
 * operations — never next to the new-order actions it would compete with.
 */
function PosHeader({
  state,
  onNavigate,
}: {
  readonly state: DayShiftState
  readonly onNavigate: (view: View) => void
}) {
  const { t } = useTranslation()

  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-heading">{t('nav.pos')}</h1>

        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-foreground-muted">
          <span className="inline-flex items-center gap-1.5">
            <Clock size={14} aria-hidden />
            {state.my_shift
              ? `${t('pos.shiftRunning')} · ${t('pos.openedAt')} ${formatDateTime(state.my_shift.opened_at)}`
              : t('pos.noShiftOpen')}
          </span>

          {state.day ? (
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays size={14} aria-hidden />
              {t('pos.businessDay')} {formatDate(state.day.day_date)}
            </span>
          ) : null}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* History is its own page now, not a dialog stacked over the POS.
            The two daily records are siblings: the day's invoices and the
            day's wash tickets, reachable from the same place. */}
        <Button variant="outline" size="sm" onClick={() => onNavigate('today-invoices')}>
          <Receipt size={16} aria-hidden />
          {t('pos.todayInvoices')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => onNavigate('today-wash-tickets')}>
          <Ticket size={16} aria-hidden />
          {t('pos.todayWashTickets')}
        </Button>
      </div>
    </header>
  )
}

/**
 * Everything the POS shows before a day and a shift are both open.
 *
 * A manager who has to open the day also gets the closing card — closing is the
 * other half of that decision, and hiding it would mean a manager opening the
 * day in one place and closing it somewhere else.
 */
function PosShiftGateView({
  canCloseDay,
  state,
  revision,
  onDone,
  onReady,
}: {
  readonly canCloseDay: boolean
  readonly state: DayShiftState
  readonly revision: number
  readonly onDone: () => Promise<void>
  readonly onReady: () => void
}) {
  return (
    <div className="space-y-4">
      {canCloseDay && state.day ? (
        <DayClosingPanel dayId={state.day.id} revision={revision} onDone={onDone} />
      ) : null}

      <ShiftGate state={state} onReady={onReady} />
    </div>
  )
}

/**
 * Operational controls last. Shift/day closing are end-of-period actions: they
 * keep the polished closing cards untouched, but sit BELOW the selling
 * workspace so they inform the shift state without competing with taking an
 * order.
 */
function OperationalControls({
  shift,
  day,
  revision,
  onShiftClosed,
  onShiftRefresh,
  onDayDone,
}: {
  readonly shift: NonNullable<DayShiftState['my_shift']>
  readonly day: DayShiftState['day'] | null
  readonly revision: number
  readonly onShiftClosed: () => Promise<void>
  readonly onShiftRefresh: () => Promise<void>
  readonly onDayDone: () => Promise<void>
}) {
  const { t } = useTranslation()

  return (
    <section aria-label={t('pos.operationalControls')} className="flex flex-col gap-3">
      <div>
        <h2 className="text-section">{t('pos.operationalControls')}</h2>

        <p className="mt-0.5 text-caption text-foreground-subtle">
          {t('pos.operationalControlsHint')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CurrentShiftPanel shift={shift} onClosed={onShiftClosed} onRefresh={onShiftRefresh} />

        {day ? <DayClosingPanel dayId={day.id} revision={revision} onDone={onDayDone} /> : null}
      </div>
    </section>
  )
}

/**
 * The banner above the order panel while a takeaway order is open.
 *
 * A takeaway is called by its external number, so that number is what the
 * banner leads with; when the backend has not issued one yet the cashier gets
 * the hint instead.
 */
function TakeawayActiveBanner({ order }: { readonly order: PosOrder }) {
  const { t } = useTranslation()

  return (
    <p className="mb-2 flex flex-wrap items-center gap-2 text-sm font-bold text-foreground-strong">
      <Badge variant="info" size="sm" icon={ShoppingBag} dot>
        {t('pos.takeawayActive')}
      </Badge>

      {typeof order.takeaway_no === 'number' ? (
        <span>
          {t('pos.takeawayNo')}: <span dir="ltr">#{order.takeaway_no}</span>
        </span>
      ) : (
        <span className="font-medium text-foreground-subtle">{t('pos.takeawayHint')}</span>
      )}
    </p>
  )
}

/** The POS's two modal commands: payment for the active order, close-empty. */
function PosDialogs({
  activeOrder,
  payOpen,
  discount,
  serviceCharge,
  closeTarget,
  busy,
  onPayClose,
  onPaid,
  onCloseEmptyCancel,
  onCloseEmptyConfirm,
}: {
  readonly activeOrder: PosOrder | null
  readonly payOpen: boolean
  readonly discount: DiscountSel
  readonly serviceCharge: number
  readonly closeTarget: TableView | null
  readonly busy: string | null
  readonly onPayClose: () => void
  readonly onPaid: (invoiceId: number, outcome: PrintOutcome | null) => void
  readonly onCloseEmptyCancel: () => void
  readonly onCloseEmptyConfirm: () => void
}) {
  const { t } = useTranslation()

  return (
    <>
      {activeOrder && payOpen ? (
        <PaymentDialog
          orderId={activeOrder.id}
          discount={discount}
          serviceCharge={serviceCharge}
          order={activeOrder}
          onClose={onPayClose}
          onDone={onPaid}
        />
      ) : null}

      {closeTarget ? (
        <Dialog open onClose={onCloseEmptyCancel} title={t('pos.closeEmptyTitle')}>
          <p className="mb-4 text-sm text-foreground-muted">
            {t('pos.closeEmptyBody', { label: closeTarget.label })}
          </p>

          <DialogActions>
            <Button variant="outline" onClick={onCloseEmptyCancel}>
              {t('app.cancel')}
            </Button>

            <Button
              variant="destructive"
              onClick={onCloseEmptyConfirm}
              loading={busy === `close-${closeTarget.id}`}
            >
              <DoorClosed size={16} aria-hidden />
              {t('pos.closeEmpty')}
            </Button>
          </DialogActions>
        </Dialog>
      ) : null}
    </>
  )
}

/**
 * Dedicated action card for starting a new takeaway order.
 *
 * It intentionally matches the table-card geometry so takeaway becomes
 * a first-class POS destination instead of looking like a toolbar action.
 */
export function TakeawayCard({
  busy,
  onStart,
}: Readonly<{ readonly busy: boolean; onStart: () => void }>) {
  const { t } = useTranslation()

  return (
    <article
      aria-label={t('pos.startTakeaway')}
      data-testid="takeaway-card"
      className={[
        'group relative flex min-h-56 flex-col overflow-hidden',
        'rounded-lg border border-info-border',
        'bg-info-soft p-4 text-start',
        'transition-[border-color,background-color,box-shadow]',
        'duration-200',
        'hover:border-info hover:bg-info-soft-hover',
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
            'rounded-md border border-info-border',
            'bg-info-soft text-info',
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
          'border border-border',
          'bg-surface-muted',
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
            className="flex size-9 shrink-0 items-center justify-center rounded-md bg-info-soft text-info"
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

        <div aria-hidden className="mt-3 border-t border-dashed border-border" />
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
  readonly items: TakeawayView[]
  readonly activeOrderId: number | null
  readonly onOpen: (orderId: number) => void
}) {
  const { t } = useTranslation()

  return (
    <section
      aria-label={t('pos.openTakeaways')}
      className={['mb-3 rounded-md border border-info-border', 'bg-info-soft px-3 py-2.5'].join(
        ' ',
      )}
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
                  'border-info-border',
                  'transition-colors duration-150',

                  active
                    ? [
                        'border-info-solid',
                        'bg-info-solid text-info-solid-foreground',
                        'shadow-sm',
                        'hover:border-info-solid-hover',
                        'hover:bg-info-solid-hover',
                        'active:bg-info-solid-active',
                      ].join(' ')
                    : [
                        'bg-info-soft',
                        'text-info-foreground',
                        'hover:border-info',
                        'hover:bg-info-soft-hover',
                        'hover:text-info',
                        'active:bg-info-soft-hover',
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
                  <span
                    className={
                      active
                        ? 'flex items-center text-foreground'
                        : 'flex items-center text-info-foreground'
                    }
                  >
                    <DisplayTime value={tk.opened_at} />
                  </span>
                ) : null}

                <span className={active ? 'text-foreground' : 'text-info-foreground'}>
                  {tk.items_count} {t('pos.items')}
                </span>

                <span className={active ? 'text-foreground' : 'text-info'}>
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
  readonly tv: TableView
  readonly selected: boolean
  readonly active: boolean
  readonly busy: string | null
  readonly onSelect: () => void
  readonly onOpen: () => void
  readonly onStartOrder: () => void
  readonly onOpenOrder: () => void
  readonly onCloseEmpty: () => void
}) {
  const { t } = useTranslation()

  const variant = tableBadgeVariant(tv.status)

  const isEmpty = tv.status === 'EMPTY'
  const isOpen = tv.status === 'OPEN'

  const statusLabel = t(`pos.state.${tv.status}`)

  return (
    <article
      aria-current={selected ? true : undefined}
      data-testid={`table-card-${tv.id}`}
      className={[
        'group relative flex min-h-56 cursor-pointer flex-col overflow-hidden',
        'rounded-lg border p-4 text-start',
        'transition-[border-color,background-color,box-shadow]',
        'duration-200',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        selected
          ? 'border-primary bg-surface-selected shadow-sm'
          : active
            ? 'border-success-border bg-success-soft'
            : 'border-border-strong bg-transparent hover:border-border-accent-hover hover:bg-surface-hover',
      ].join(' ')}
    >
      {/* Selecting the table is a real <button> stretched across the whole card
          surface. The card itself cannot be a button: it contains other buttons,
          which HTML forbids inside a <button>. The informational blocks below are
          pointer-transparent so a click anywhere on the card lands on this
          button, and the action row sits above it in the stacking order. */}
      <button
        type="button"
        aria-label={`${tv.label} — ${statusLabel}`}
        onClick={onSelect}
        data-testid={`table-card-select-${tv.id}`}
        className="absolute inset-0 z-0 cursor-pointer"
      />

      {/* Status accent */}
      <span
        aria-hidden
        className={[
          'absolute inset-y-0 inset-s-0 w-1',
          variant === 'danger'
            ? 'bg-destructive'
            : variant === 'info'
              ? 'bg-info'
              : variant === 'success'
                ? 'bg-success'
                : 'bg-warning',
        ].join(' ')}
      />

      {/* Header */}
      <div className="pointer-events-none flex items-start justify-between gap-3">
        <p className="min-w-0 truncate text-lg font-bold leading-tight text-foreground-strong">
          {tv.label}
        </p>

        <Badge variant={variant} size="sm" dot>
          {statusLabel}
        </Badge>
      </div>

      {/* Main information */}
      <div className="pointer-events-none mt-4 flex min-h-16 flex-1 flex-col justify-center">
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
      <div className="pointer-events-none mt-3 grid grid-cols-2 gap-2">
        <div className="min-w-0 rounded-md border border-border bg-surface-muted px-2.5 py-2">
          <p className="truncate text-[10px] font-medium leading-tight text-foreground-subtle">
            {t('pos.opensToday')}
          </p>

          <p className="mt-0.5 text-sm font-bold leading-tight tabular-nums text-foreground-strong">
            {tv.opens_today}
          </p>
        </div>

        <div className="min-w-0 rounded-md border border-border bg-surface-muted px-2.5 py-2">
          <p className="truncate text-[10px] font-medium leading-tight text-foreground-subtle">
            {t('pos.closedEmptyToday')}
          </p>

          <p className="mt-0.5 text-sm font-bold leading-tight tabular-nums text-foreground-strong">
            {tv.closed_empty_today}
          </p>
        </div>
      </div>

      {/* State-dependent actions */}
      <div className="relative z-10 mt-3 flex min-h-9 items-center gap-2">
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
  readonly tv: TableView
  readonly busy: string | null
  readonly onOpen: () => void
  readonly onStartOrder: () => void
  readonly onOpenOrder: () => void
  readonly onCloseEmpty: () => void
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
