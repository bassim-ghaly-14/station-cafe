/**
 * المخزون — the inventory workspace.
 *
 * # The job of this page
 *
 * Catalog answers "what does the business sell": identity, category, price,
 * product configuration, active state. THIS page answers the operational
 * question only: what is in stock right now, what has moved, what has reached
 * its minimum, and what should I do about it.
 *
 * That separation is why nothing here edits, prices, categorises or configures
 * a product. The only mutation this page owns is a stock adjustment, which is an
 * inventory fact and belongs to the row it happened on. Every piece of product
 * master data that arrived on the payload — department, category, item type — is
 * deliberately not printed, because Catalog already presents it properly and
 * repeating it here is what would turn this into a second catalog.
 *
 * # Reading order
 *
 *   header → summary counts → what needs attention → the current stock →
 *   recent movement.
 *
 * "What needs attention" sits above the list because that is the question a
 * manager opens the page with; it is the same rows as the list, derived from the
 * same payload, and it renders nothing at all when nothing is low.
 *
 * Structure:
 * -----------
 *   `inventoryModel.ts`      the pure status / summary / filter logic
 *   `InventoryHeader.tsx`    the page identity and the summary band
 *   `StockAttention.tsx`     the low rows, promoted
 *   `StockList.tsx`          the stock table ⇄ record list and its toolbar
 *   `MovementList.tsx`       the movement table ⇄ record list
 *   `AdjustStockDialog.tsx`  the one mutation this page owns
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState } from '@/components/states'
import { ListRowsSkeleton } from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { useErrText } from '@/lib/err'
import {
  opsApi,
  type InventoryNotification,
  type MovementRow,
  type StockRow,
} from '@/services/opsApi'
import { AdjustStockDialog } from './AdjustStockDialog'
import { InventoryHeader, InventorySummary } from './InventoryHeader'
import { InventoryNotifications } from './InventoryNotifications'
import { MovementList } from './MovementList'
import { StockAttention } from './StockAttention'
import { StockList } from './StockList'
import {
  NO_STOCK_QUERY,
  attentionRows,
  filterStock,
  summarizeStock,
  type StockQuery,
} from './inventoryModel'

/**
 * How many movements the page requests.
 *
 * Unchanged from before this redesign, and stated as a constant so the header
 * strip can print the same number that was requested rather than a second,
 * possibly-drifting copy of it.
 */
const MOVEMENT_WINDOW = 30

/**
 * The states every independently-loaded list on this page can be in: not loaded
 * yet (failed, or still loading), loaded and empty, and loaded with rows.
 *
 * The stock list and the movement list differ only in their copy, their
 * skeleton size and what they render, so the precedence is stated once here
 * instead of written twice — and a failed load is never presented as an empty
 * list. `children` is a function so the loaded branch can hand the rows to
 * whichever presentation the caller chose.
 */
function LoadedList<T>({
  rows,
  error,
  onRetry,
  skeletonRows,
  emptyTitle,
  children,
}: Readonly<{
  readonly rows: readonly T[] | null
  readonly error: string | null
  readonly onRetry: () => void
  readonly skeletonRows: number
  readonly emptyTitle: string
  readonly children: (rows: readonly T[]) => ReactNode
}>) {
  const { t } = useTranslation()
  if (rows === null) {
    if (error) {
      return <ErrorState message={error} onRetry={onRetry} retryLabel={t('app.retry')} />
    }
    return <ListRowsSkeleton rows={skeletonRows} />
  }
  if (rows.length === 0) return <EmptyState title={emptyTitle} />
  return <>{children(rows)}</>
}

/**
 * The stock read and everything derived from it.
 *
 * It is its own component so the page reads as header → summary → attention →
 * stock → movement, and so the four states of the ONE load that produces the
 * summary, the attention area and the list are stated once instead of being
 * re-derived by each consumer. In particular the summary band is rendered ONLY
 * when there is either a summary or a read still in flight — a FAILED read
 * shows the error state and no figures at all, never a band of zeroes.
 *
 * `refreshing` exists for the same reason the other pages carry it: a reload
 * keeps the rows already on screen and marks the surfaces busy, so an adjustment
 * is not a full-page flash. This page's only reload trigger is an adjustment,
 * which closes the dialog first, so the values are re-rendered rather than
 * being held stale — the flag is passed through so the busy treatment is the
 * application's and not a one-off here.
 */
function StockSection({
  stock,
  error,
  refreshing,
  onRetry,
  onAdjust,
  notifications,
  unread,
  marking,
  onMarkRead,
  onMarkAllRead,
}: Readonly<{
  readonly stock: StockRow[] | null
  readonly error: string | null
  readonly refreshing: boolean
  readonly onRetry: () => void
  readonly onAdjust: (row: StockRow) => void
  readonly notifications: readonly InventoryNotification[]
  readonly unread: number
  readonly marking: boolean
  readonly onMarkRead: (id: number) => void
  readonly onMarkAllRead: () => void
}>) {
  const { t } = useTranslation()
  const [query, setQuery] = useState<StockQuery>(NO_STOCK_QUERY)

  // One pass over the complete loaded set produces every figure below, so the
  // band, the attention area and the list can never disagree about which items
  // are low or how many there are.
  const summary = useMemo(() => (stock === null ? null : summarizeStock(stock)), [stock])
  const low = useMemo(() => (stock === null ? [] : attentionRows(stock)), [stock])
  const visible = useMemo(() => (stock === null ? [] : filterStock(stock, query)), [stock, query])

  return (
    <>
      {summary !== null || error === null ? (
        <InventorySummary summary={summary} loading={refreshing} />
      ) : null}

      {/* The manager alert queue is independent of whether the stock list has
          rows yet — a fresh install with no tracked items can still hold a
          resolved/re-armed alert history the manager must see — so it sits
          OUTSIDE the LoadedList empty-state branch, exactly like the summary. */}
      <InventoryNotifications
        notifications={notifications}
        unread={unread}
        onMarkRead={onMarkRead}
        onMarkAllRead={onMarkAllRead}
        marking={marking}
      />

      <LoadedList
        rows={stock}
        error={error}
        onRetry={onRetry}
        skeletonRows={5}
        emptyTitle={t('inventory.empty')}
      >
        {() => (
          <>
            <StockAttention rows={low} onAdjust={onAdjust} />

            <StockList
              rows={visible}
              total={stock?.length ?? 0}
              query={query}
              onQueryChange={setQuery}
              onReset={() => setQuery(NO_STOCK_QUERY)}
              onAdjust={onAdjust}
              refreshing={refreshing}
            />
          </>
        )}
      </LoadedList>
    </>
  )
}

export default function InventoryPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [stock, setStock] = useState<StockRow[] | null>(null)
  const [movements, setMovements] = useState<MovementRow[] | null>(null)
  const [stockErr, setStockErr] = useState<string | null>(null)
  const [movErr, setMovErr] = useState<string | null>(null)
  const [adjusting, setAdjusting] = useState<StockRow | null>(null)
  const [notifications, setNotifications] = useState<InventoryNotification[]>([])
  const [marking, setMarking] = useState(false)

  /**
   * Reads only: stock + bounded movements + the persisted alert queue.
   * The notification read NEVER creates or mutates alerts — sync happens
   * solely on backend inventory writes — so refetch is idempotent by design.
   */
  const load = useCallback(() => {
    setStockErr(null)
    setMovErr(null)
    opsApi
      .stock()
      .then(setStock)
      .catch((e) => {
        setStockErr(errText(e))
        toast(errText(e), 'error')
      })
    opsApi
      .movements(MOVEMENT_WINDOW)
      .then(setMovements)
      .catch((e) => {
        setMovErr(errText(e))
        toast(errText(e), 'error')
      })
    opsApi
      .notifications()
      .then(setNotifications)
      .catch((e) => {
        toast(errText(e), 'error')
      })
  }, [toast, errText])

  useEffect(() => {
    // The page's initial read of the stock rows and the recent movements.
    // External async init, started after the first commit.
    // oxlint-disable-next-line react/set-state-in-effect -- external async init.
    load()
  }, [load])

  const unread = notifications.filter((n) => n.read_at === null).length

  const markRead = useCallback(
    (id: number) => {
      setMarking(true)
      opsApi
        .markNotificationRead(id)
        .then(() => opsApi.notifications().then(setNotifications))
        .catch((e) => toast(errText(e), 'error'))
        .finally(() => setMarking(false))
    },
    [toast, errText],
  )

  const markAllRead = useCallback(() => {
    setMarking(true)
    opsApi
      .markAllNotificationsRead()
      .then(() => opsApi.notifications().then(setNotifications))
      .catch((e) => toast(errText(e), 'error'))
      .finally(() => setMarking(false))
  }, [toast, errText])

  return (
    <div className="flex flex-col gap-4">
      <InventoryHeader />

      <StockSection
        stock={stock}
        error={stockErr}
        refreshing={false}
        onRetry={load}
        onAdjust={setAdjusting}
        notifications={notifications}
        unread={unread}
        marking={marking}
        onMarkRead={markRead}
        onMarkAllRead={markAllRead}
      />

      <LoadedList
        rows={movements}
        error={movErr}
        onRetry={load}
        skeletonRows={4}
        emptyTitle={t('inventory.noMovements')}
      >
        {(loaded) => <MovementList rows={loaded} window={MOVEMENT_WINDOW} refreshing={false} />}
      </LoadedList>

      {adjusting ? (
        <AdjustStockDialog
          item={adjusting}
          onClose={() => setAdjusting(null)}
          onDone={() => {
            setAdjusting(null)
            toast(t('inventory.adjusted'), 'success')
            load()
          }}
        />
      ) : null}
    </div>
  )
}
