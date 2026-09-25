/**
 * Manager inventory UI (Phase 2 foundation) — current stock, adjustments,
 * movement history. Not a warehouse system; the backend owns the rules.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState } from '@/components/states'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  DisplayDateTime,
  ListRowsSkeleton,
} from '@/components/ui'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Boxes, Save, SlidersHorizontal } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { opsApi, STOCK_REASONS, type MovementRow, type StockRow } from '@/services/opsApi'
import { useErrText } from '@/lib/err'
import { cn } from '@/lib/utils'

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
    load()
  }, [load])

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-heading flex items-center gap-2">
        <Boxes size={22} aria-hidden />
        {t('nav.inventory')}
      </h1>

      {stock === null ? (
        stockErr ? (
          <ErrorState message={stockErr} onRetry={load} retryLabel={t('app.retry')} />
        ) : (
          <ListRowsSkeleton rows={5} />
        )
      ) : stock.length === 0 ? (
        <EmptyState title={t('inventory.empty')} />
      ) : (
        <Card>
          <CardHeader title={t('inventory.stock')} subtitle={t('inventory.stockHint')} />
          <div className="flex flex-col divide-y divide-border-subtle">
            {stock.map((s) => {
              const low = s.quantity <= s.min_quantity
              return (
                <div key={s.product_id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <div className="min-w-40 flex-1">
                    <p className="text-body font-bold">{s.product_name}</p>
                    <p className="text-caption">
                      {t(`catalog.${s.department}`)} · {t('catalog.category')}: {s.category_name} ·{' '}
                      {t(`catalog.${s.item_type}`)} · {t('inventory.min')}: {s.min_quantity}
                    </p>
                  </div>
                  <span
                    className={cn('text-money', low ? 'text-destructive' : 'text-foreground-muted')}
                    aria-label={low ? t('inventory.low') : undefined}
                  >
                    {s.quantity}
                  </span>
                  {low ? (
                    <Badge variant="warning" size="sm" dot>
                      {t('inventory.low')}
                    </Badge>
                  ) : null}
                  <Button variant="outline" size="sm" onClick={() => setAdjusting(s)}>
                    <SlidersHorizontal size={16} aria-hidden />
                    {t('inventory.adjust')}
                  </Button>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title={t('inventory.movements')} />
        {movements === null ? (
          movErr ? (
            <ErrorState message={movErr} onRetry={load} retryLabel={t('app.retry')} />
          ) : (
            <ListRowsSkeleton rows={4} />
          )
        ) : movements.length === 0 ? (
          <EmptyState title={t('inventory.noMovements')} />
        ) : (
          <div className="flex flex-col divide-y divide-border-subtle">
            {movements.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-40 flex-1">
                  <p className="text-body">{m.product_name}</p>
                  <p className="min-w-0 text-caption">
                    <DisplayDateTime value={m.created_at} separator="" />
                    {m.note ? ` · ${t([`inventory.note.${m.note}`, m.note])}` : ''}
                  </p>
                </div>
                <Badge variant={m.change > 0 ? 'success' : 'danger'} size="sm" dot>
                  {t(`inventory.reason.${m.reason}`)}
                </Badge>
                <span
                  className={cn('text-money', m.change > 0 ? 'text-success' : 'text-destructive')}
                >
                  {m.change > 0 ? `+${m.change}` : m.change}
                </span>
              </div>
            ))}
          </div>
        )}
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
  item: StockRow
  onClose: () => void
  onDone: () => void
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
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button onClick={save} disabled={busy} loading={busy}>
            {!busy ? <Save size={16} aria-hidden /> : null}
            {t('app.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
