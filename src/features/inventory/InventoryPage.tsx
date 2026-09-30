/**
 * Manager inventory UI (Phase 2 foundation) — current stock, adjustments,
 * movement history. Not a warehouse system; the backend owns the rules.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState } from '@/components/states'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogActions,
  DisplayDateTime,
  ListRowsSkeleton,
} from '@/components/ui'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Boxes, Save, SlidersHorizontal } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { opsApi, STOCK_REASONS, type MovementRow, type StockRow } from '@/services/opsApi'
import { useErrText } from '@/lib/err'
import { cn } from '@/lib/utils'

/** One stock line, with the low-stock warning the table contract promises. */
function StockRow({
  row,
  onAdjust,
}: {
  readonly row: StockRow
  readonly onAdjust: (row: StockRow) => void
}) {
  const { t } = useTranslation()
  const low = row.quantity <= row.min_quantity
  return (
    // `flex-col` below `sm` for the same reason the expenses rows use it: the
    // quantity, its low-stock badge and the adjust action each need their own
    // line in 296px, and a wrapped row put the action button on a line of its own
    // at a random width. `sm:flex-row` is the original single line.
    <div className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:gap-3">
      <div className="min-w-0 flex-1 sm:min-w-40">
        <p className="text-body font-bold">{row.product_name}</p>
        <p className="text-caption">
          {t(`catalog.${row.department}`)} · {t('catalog.category')}: {row.category_name} ·{' '}
          {t(`catalog.${row.item_type}`)} · {t('inventory.min')}: {row.min_quantity}
        </p>
      </div>
      {/* The quantity leads the phone row, because "how much is left" is the
          question this screen exists to answer. */}
      <div className="flex items-center justify-between gap-2 sm:ms-auto sm:justify-end">
        <span
          className={cn('text-money', low ? 'text-destructive' : 'text-foreground-muted')}
          aria-label={low ? t('inventory.low') : undefined}
        >
          {row.quantity}
        </span>
        {low ? (
          <Badge variant="warning" size="sm" dot>
            {t('inventory.low')}
          </Badge>
        ) : null}
      </div>
      <Button variant="outline" size="sm" onClick={() => onAdjust(row)} className="sm:ms-2">
        <SlidersHorizontal size={16} aria-hidden />
        {t('inventory.adjust')}
      </Button>
    </div>
  )
}

/**
 * The stock rows, kept as their own component so the loading/error/empty/data
 * decision above reads as a flat chain rather than a nested ternary.
 */
function StockRows({
  rows,
  onAdjust,
}: {
  readonly rows: readonly StockRow[]
  readonly onAdjust: (row: StockRow) => void
}) {
  return (
    <>
      {rows.map((row) => (
        <StockRow key={row.product_id} row={row} onAdjust={onAdjust} />
      ))}
    </>
  )
}

/** One movement line: the product, when it happened, why, and the signed change. */
function MovementRow({ row }: { readonly row: MovementRow }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-3 py-2">
      <div className="min-w-40 flex-1">
        <p className="text-body">{row.product_name}</p>
        <p className="min-w-0 text-caption">
          <DisplayDateTime value={row.created_at} separator="" />
          {row.note ? ` · ${t(['inventory.note.' + row.note, row.note])}` : ''}
        </p>
      </div>
      <Badge variant={row.change > 0 ? 'success' : 'danger'} size="sm" dot>
        {t(`inventory.reason.${row.reason}`)}
      </Badge>
      <span className={cn('text-money', row.change > 0 ? 'text-success' : 'text-destructive')}>
        {row.change > 0 ? `+${row.change}` : row.change}
      </span>
    </div>
  )
}

function MovementRows({ rows }: { readonly rows: readonly MovementRow[] }) {
  return (
    <>
      {rows.map((row) => (
        <MovementRow key={row.id} row={row} />
      ))}
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
      .movements(30)
      .then(setMovements)
      .catch((e) => {
        setMovErr(errText(e))
        toast(errText(e), 'error')
      })
  }, [toast, errText])

  useEffect(() => {
    // The page's initial read of the stock rows and the recent movements.
    // External async init, started after the first commit.
    // oxlint-disable-next-line react/set-state-in-effect -- external async init.
    load()
  }, [load])

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-heading flex items-center gap-2">
        <Boxes size={22} aria-hidden />
        {t('nav.inventory')}
      </h1>

      <StockSection rows={stock} error={stockErr} onRetry={load} onAdjust={setAdjusting} />

      <Card>
        <CardHeader title={t('inventory.movements')} />
        <MovementsSection rows={movements} error={movErr} onRetry={load} />
      </Card>

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

function AdjustStockDialog({
  item,
  onClose,
  onDone,
}: {
  readonly item: StockRow
  readonly onClose: () => void
  readonly onDone: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [change, setChange] = useState('')
  const [reason, setReason] = useState<(typeof STOCK_REASONS)[number]>('PURCHASE')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    const n = Number.parseInt(change.trim(), 10)
    if (!Number.isInteger(n) || n === 0) {
      toast(t('errors.inventory.zero_change'), 'error')
      return
    }
    setBusy(true)
    try {
      await opsApi.adjustStock(item.product_id, n, reason, note.trim() || null)
      onDone()
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={t('inventory.adjustTitle', { name: item.product_name })}>
      <div className="flex flex-col gap-4">
        <Field label={t('inventory.change')}>
          <Input
            dir="ltr"
            inputMode="numeric"
            value={change}
            onChange={(e) => setChange(e.target.value)}
          />
          <p className="text-caption">{t('inventory.changeHint')}</p>
        </Field>
        <Field label={t('inventory.reason')}>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as typeof reason)}
            className="h-10 w-full rounded-md border border-border-strong bg-surface-input px-3 text-base"
          >
            {STOCK_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`inventory.reason.${r}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('app.notes')}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
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

/**
 * The three states every independently-loaded list on this page is in: not
 * loaded yet (error or skeleton), loaded and empty, or loaded with rows.
 *
 * The stock list and the movement list differ only in their copy, their
 * skeleton size and their rows, so the precedence is stated once here instead
 * of written twice — and a failed load is never presented as an empty list.
 */
function LoadedList<T>({
  rows,
  error,
  onRetry,
  skeletonRows,
  emptyTitle,
  children,
}: Readonly<{
  rows: readonly T[] | null
  error: string | null
  onRetry: () => void
  skeletonRows: number
  emptyTitle: string
  children: (rows: readonly T[]) => ReactNode
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

/** The stock card, with its own header, subtitle and adjust action. */
function StockSection({
  rows,
  error,
  onRetry,
  onAdjust,
}: Readonly<{
  rows: readonly StockRow[] | null
  error: string | null
  onRetry: () => void
  onAdjust: (row: StockRow) => void
}>) {
  const { t } = useTranslation()
  return (
    <LoadedList
      rows={rows}
      error={error}
      onRetry={onRetry}
      skeletonRows={5}
      emptyTitle={t('inventory.empty')}
    >
      {(loaded) => (
        <Card>
          <CardHeader title={t('inventory.stock')} subtitle={t('inventory.stockHint')} />
          <div className="flex flex-col divide-y divide-border-subtle">
            <StockRows rows={loaded} onAdjust={onAdjust} />
          </div>
        </Card>
      )}
    </LoadedList>
  )
}

/** The movement list, which sits inside the movements card. */
function MovementsSection({
  rows,
  error,
  onRetry,
}: Readonly<{
  rows: readonly MovementRow[] | null
  error: string | null
  onRetry: () => void
}>) {
  const { t } = useTranslation()
  return (
    <LoadedList
      rows={rows}
      error={error}
      onRetry={onRetry}
      skeletonRows={4}
      emptyTitle={t('inventory.noMovements')}
    >
      {(loaded) => (
        <div className="flex flex-col divide-y divide-border-subtle">
          <MovementRows rows={loaded} />
        </div>
      )}
    </LoadedList>
  )
}
