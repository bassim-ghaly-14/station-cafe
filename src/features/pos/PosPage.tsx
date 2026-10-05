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
  KpiGrid,
  KpiTile,
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
  Inbox,
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
  type TableCounters,
  type TableView,
  type TakeawayView,
} from '@/services/posApi'
import { shiftApi, type DayShiftState } from '@/services/shiftApi'
import { tableBadgeVariant } from '@/lib/status-badge'
import { atLeast, useSession } from '@/features/auth/useSession'
import type { UserRole } from '@/lib/roles'
import { useRouter, type View } from '@/app/router'
import { CurrentShiftPanel } from './CurrentShiftPanel'
import { DayClosingPanel } from './DayClosingPanel'
import { OrderPanel } from './OrderPanel'
import { PaymentDialog } from './PaymentDialog'
import { ShiftGate } from './ShiftGate'
import { canOpenDailyRecords } from './posAccess'

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
  /**
   * The CURRENT SHIFT's lifecycle counters, straight from the backend.
   *
   * This is the SAME shift-scoped `table_sessions` read the close-shift dialog
   * reports (`shift_id`), so the band and the dialog can never disagree. It is
   * held only to render: it is re-read on every `refresh()`, so the empty-close
   * figure always comes from the database rather than from anything this screen
   * tallies. Opening a table never writes to it — only a completed operation
   * followed by a refresh can change what it shows. A newly opened shift owns
   * no sessions yet, so it naturally reports zero without deleting history.
   */
  const [counters, setCounters] = useState<TableCounters | null>(null)
  const [takeaways, setTakeaways] = useState<TakeawayView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null)
  const [activeOrder, setActiveOrder] = useState<PosOrder | null>(null)
  /**
   * Whether the POS is showing the FULL-SCREEN order workspace.
   *
   * This is VIEW state, not order state. It is turned on by `loadOrder` — the
   * single path every entry point (start order, open order, start takeaway,
   * reopen takeaway) already goes through — and turned off by the workspace's
   * own Back action. Nothing else writes it, and no backend call reads it.
   *
   * Crucially it is SEPARATE from `activeOrder`: pressing Back hides the
   * workspace without discarding, cancelling or closing anything, so the order
   * stays loaded and persisted and reopening it restores it exactly. That is
   * what lets a cashier step out to the tables mid-sale and come straight back.
   */
  const [orderWorkspace, setOrderWorkspace] = useState(false)
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
      const [tv, tk, st, counters] = await Promise.all([
        api.tables(),
        api.openTakeaways(),
        shiftApi.state(),
        api.shiftCounters(),
      ])

      setTables(tv)
      setTakeaways(tk)
      setShiftState(st)
      setCounters(counters)
      setError(null)
    } catch (e) {
      setError(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']))
    } finally {
      setRevision((value) => value + 1)
    }
  }, [t])

  useEffect(() => {
    // The screen's initial read of tables, takeaways and the open shift. This is an
    // external system (Tauri IPC): the request starts only after the first commit.
    // oxlint-disable-next-line react/set-state-in-effect -- external async init.
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
      // With no active order there is nothing to preview. The read above is
      // external; this branch only CLEARS a stale preview left by the previous
      // order, which by definition can only be known after that order left.
      // oxlint-disable-next-line react/set-state-in-effect -- stale-preview reset.
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
        showDailyRecords={canOpenDailyRecords(user?.role)}
        state={shiftState}
        revision={revision}
        onDone={refresh}
        onReady={() => void refresh()}
        onNavigate={navigate}
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

    // Every entry point lands in the workspace, so "open an order" always means
    // the same thing visually — there is no second, cramped way into an order.
    setOrderWorkspace(true)

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

  /*
   * ONE selling workspace, TWO modes — and never a split.
   *
   * Tables mode (no order open, or Back pressed):
   *   the tables card owns the whole content area, at full width. It used to sit
   *   beside a second column that repeated the very actions each table card
   *   already carries (open / start order / close empty / open order) and
   *   rendered an empty "pick a table" placeholder when nothing was selected.
   *   That column duplicated the cards, reserved a fixed 22rem beside the grid
   *   and made the cashier choose between two views of the same decision — and
   *   it became pure dead weight the moment orders moved into the dedicated
   *   Order Workspace. It is gone, not hidden.
   *
   * Order mode (workspace open):
   *   the OrderPanel replaces the tables outright. The tables are UNMOUNTED
   *   rather than hidden, so they cost no width and no screen-reader noise
   *   while a sale is in progress.
   *
   * Back is navigation only: `activeOrder` stays loaded and persisted, so the
   * tables come back at full width with the order still one tap away.
   */
  const inOrderWorkspace = orderWorkspace && activeOrder !== null

  const counts = tableCounts(tables, counters)

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

      {/* The selling workspace: ONE block, never a split. Tables mode is the
          full-width tables card; order mode is the full-screen Order
          Workspace. Nothing sits beside the grid, so the grid gets every pixel
          and there is no second, competing order view. */}
      {inOrderWorkspace && activeOrder ? (
        // The takeaway identity (type badge + external number) lives in the
        // workspace header, where it costs no vertical space and cannot be
        // separated from the order it describes.
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
          onBack={() => setOrderWorkspace(false)}
          onDiscard={
            // The SERVICE rejects cancelling a ticketed order, so the UI must
            // not offer it either. `waiting_no` is written in the same
            // transaction as the ticket row, so it is the same fact the backend
            // reads — this hides a dead action, it is not the enforcement.
            activeOrder.lines.length === 0 && activeOrder.waiting_no === null
              ? () => void discardActiveOrder()
              : undefined
          }
          discarding={busy === 'discard'}
        />
      ) : (
        <TablesCard
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
      )}

      {/* Shift/day closing is OPERATIONAL work, not order work. It stays out of
          the workspace so the order panel can own the viewport height without
          the page growing a scrollbar underneath it — and it returns in full
          the moment the cashier steps back to the tables. */}
      {inOrderWorkspace ? null : (
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
      )}

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

/**
 * The legend numbers under the tables card title.
 *
 * The four states are the ones the cards themselves show, so the header can
 * never claim a state the grid does not have:
 *
 *  - `empty`     — EMPTY: no session, no order.
 *  - `open`      — OPEN: a session is open, nothing ordered yet.
 *  - `occupied`  — OCCUPIED + READY_TO_PAY: the table has an order on it. The
 *                  two order states are ONE state here, exactly as they were
 *                  before, because "بها طلب" is what a cashier needs to know.
 *  - `closed`    — the empty closes of the CURRENT SHIFT. It comes from
 *                  the backend's own `shift_lifecycle_counters` command — the SAME `shift_id`-scoped read the close-shift dialog reports —
 *                  reads the persisted `table_sessions` rows. It is deliberately
 *                  NOT a sum of the cards below: summing over the active grid
 *                  would drop every close belonging to a table that has since
 *                  been retired, and it would be a second definition of a number
 *                  the database already states. No table row is ever "closed",
 *                  a session is, so this is a presentation of a backend fact,
 *                  not a fifth table status.
 */
type TableCounts = {
  empty: number
  open: number
  occupied: number
  closed: number
}

function tableCounts(tables: TableView[], counters: TableCounters | null): TableCounts {
  return {
    empty: tables.filter((tv) => tv.status === 'EMPTY').length,
    open: tables.filter((tv) => tv.status === 'OPEN').length,
    occupied: tables.filter((tv) => tv.status === 'OCCUPIED' || tv.status === 'READY_TO_PAY')
      .length,
    // The backend is the source of truth. `null` only means the counters have
    // not arrived yet, and it renders as a truthful 0 rather than a guess.
    closed: counters?.closed_empty ?? 0,
  }
}

/**
 * The tables grid's responsive class set.
 *
 * The grid uses the FULL width the page gives it in every mode: there is no
 * sibling column left to make room for, so the widest step (`lg:grid-cols-4`,
 * then `2xl:grid-cols-5`) is always the one in force rather than being reserved
 * for a context pane that no longer exists.
 *
 * The phone step is ONE table per row. The grid used to start at `grid-cols-2`,
 * which put two table cards side by side on a 360px phone: each card was then
 * ~150px wide, and a card carries a label, a status badge, a figure, two daily
 * counters and an action — so the two-up layout truncated all of it and made the
 * action buttons a cramped target. `grid-cols-1` below `sm` gives each card the
 * full row it needs, and the columns from `sm` up keep the existing
 * tablet/desktop density. No fixed width and no horizontal scroll is involved:
 * the grid simply has one column until there is room for another.
 */
const TABLES_GRID_CLASS =
  'grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5'

/**
 * The tables KPI header: the four states the grid can be in, as four tiles.
 *
 * It renders through the SHARED KPI rule (`KpiGrid`), so it behaves like every
 * other band in the app: four tiles in one row on a desktop, ONE tile per row
 * on a phone. That is the same contract the sales/expenses/customers/employees
 * bands now follow, so the tables section is not a special case.
 *
 * The tiles are the compact ones rather than the banded `Card` tiles: this sits
 * inside the tables card itself, directly above the grid, and must not compete
 * with the cards it summarises.
 */
function TablesKpiBand({ counts }: { readonly counts: TableCounts }) {
  const { t } = useTranslation()

  return (
    <section aria-label={t('pos.tablesKpi.label')} className="mb-3">
      {/* Four states, four tiles: `lg={4}` keeps them on ONE row from a
          1024px desktop, so the band never reads as three tiles and a stray
          fourth. */}
      <KpiGrid lg={4}>
        <KpiTile icon={<Inbox size={13} aria-hidden />} label={t('pos.tablesKpi.empty')}>
          {counts.empty}
        </KpiTile>
        <KpiTile icon={<DoorOpen size={13} aria-hidden />} label={t('pos.tablesKpi.open')}>
          {counts.open}
        </KpiTile>
        <KpiTile icon={<ClipboardList size={13} aria-hidden />} label={t('pos.tablesKpi.occupied')}>
          {counts.occupied}
        </KpiTile>
        <KpiTile
          icon={<DoorClosed size={13} aria-hidden />}
          label={t('pos.tablesKpi.closed')}
          hint={t('pos.tablesKpi.closedHint')}
        >
          {counts.closed}
        </KpiTile>
      </KpiGrid>
    </section>
  )
}

/**
 * The tables side of the selling workspace: open takeaways, the takeaway
 * action card and every table card.
 *
 * It is the WHOLE tables mode — there is no sibling panel beside it, so it
 * always renders full width. Every table action lives on its own card, which is
 * why the removed context column added nothing the grid did not already offer.
 *
 * It only reads what the page owns — selection, the active order id and the busy
 * label — and hands every mutation back to the page's own commands, so no
 * table/takeaway rule lives in here.
 */
function TablesCard({
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
  readonly tables: TableView[]
  readonly counts: TableCounts
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
    <Card aria-label={t('pos.tables')} className="w-full">
      <CardHeader title={t('pos.tables')} />
      <TablesKpiBand counts={counts} />

      {takeaways && takeaways.length > 0 ? (
        <OpenTakeaways items={takeaways} activeOrderId={activeOrderId} onOpen={onReopenTakeaway} />
      ) : null}

      <div className={TABLES_GRID_CLASS}>
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

      <DailyRecordsActions onNavigate={onNavigate} />
    </header>
  )
}

/**
 * The two daily records: فواتير اليوم and تذاكر المغسلة اليوم.
 *
 * History is its own page now, not a dialog stacked over the POS, and the two
 * are siblings: the day's invoices and the day's wash tickets, reachable from
 * the same place.
 *
 * It is ONE component with two call sites on purpose. It used to live only in
 * the selling workspace's header, which meant it existed only once the shift
 * gate had been passed — so a manager who had not opened a till, and therefore
 * never sees the workspace at all, had no way into either page. Rendering the
 * same component on the gate screen is what makes a manager's access depend on
 * their ROLE rather than on their SHIFT; see `canOpenDailyRecords`.
 */
function DailyRecordsActions({ onNavigate }: { readonly onNavigate: (view: View) => void }) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => onNavigate('today-invoices')}>
        <Receipt size={16} aria-hidden />
        {t('pos.todayInvoices')}
      </Button>
      <Button variant="outline" size="sm" onClick={() => onNavigate('today-wash-tickets')}>
        <Ticket size={16} aria-hidden />
        {t('pos.todayWashTickets')}
      </Button>
    </div>
  )
}

/**
 * Everything the POS shows before a day and a shift are both open.
 *
 * A manager who has to open the day also gets the closing card — closing is the
 * other half of that decision, and hiding it would mean a manager opening the
 * day in one place and closing it somewhere else.
 *
 * The day's two records belong here too, and are gated by ROLE only: reading
 * the day's invoices or wash tickets is not selling, so it must not disappear
 * for a manager who has no open till. The shift gate below is about opening a
 * till, and stays exactly as strict as it was.
 */
function PosShiftGateView({
  canCloseDay,
  showDailyRecords,
  state,
  revision,
  onDone,
  onReady,
  onNavigate,
}: {
  readonly canCloseDay: boolean
  readonly showDailyRecords: boolean
  readonly state: DayShiftState
  readonly revision: number
  readonly onDone: () => Promise<void>
  readonly onReady: () => void
  readonly onNavigate: (view: View) => void
}) {
  const { t } = useTranslation()

  /*
   * The gate is a STARTING STATE, so it is settled in the viewport rather than
   * pinned to the top of it.
   *
   * `min-h-[60vh]` with `sm:justify-center` centres the block vertically once
   * there is room for it, while staying top-aligned on a short window or a phone
   * where centring would push the primary action below the fold. 60vh rather than
   * a full height is deliberate: the day's records and the closing panel may also
   * be on this screen, and the gate must never claim the whole workspace away
   * from them or make the page scroll to reach the button.
   *
   * `justify-center` is directional-agnostic, so it behaves identically in RTL.
   */
  return (
    <div className="flex min-h-[60vh] flex-col gap-4 sm:justify-center">
      {showDailyRecords ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-heading">{t('nav.pos')}</h1>
            <p className="mt-1 text-caption text-foreground-muted">{t('pos.noShiftOpen')}</p>
          </div>

          <DailyRecordsActions onNavigate={onNavigate} />
        </div>
      ) : null}

      {canCloseDay && state.day ? (
        <DayClosingPanel dayId={state.day.id} revision={revision} onDone={onDone} />
      ) : null}

      <ShiftGate state={state} onReady={onReady} onShiftClosed={onDone} />
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
        // One full-width row on a phone (see `TABLES_GRID_CLASS`), where a card
        // needs no extra height to sit beside another one — so the phone step
        // is the compact one and the multi-column steps keep the roomier
        // desktop card.
        'group relative flex min-h-48 cursor-pointer flex-col overflow-hidden sm:min-h-56',
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
