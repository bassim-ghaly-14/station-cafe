import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Card, Dialog, MoneyDisplay, useToast } from '@/components/ui'
import { Clock, Eye, Lock, User } from '@/components/ui/icon'
import { Field, Input } from '@/components/ui/input'
import { formatSqlDateTime } from '@/lib/date'
import { parseMajor } from '@/lib/utils'
import { shiftApi, type ShiftClosingPreview, type ShiftRow } from '@/services/shiftApi'
import { api } from '@/services/posApi'
import { PrintPreviewDialog, type PrintPreviewTarget } from './PrintPreviewDialog'

function errorText(t: ReturnType<typeof useTranslation>['t'], error: unknown) {
  return t([`errors.${(error as { message: string }).message}`, 'errors.internal_error'])
}

function elapsedMinutes(openedAt: string, now: number) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(openedAt)
  if (!match) return 0
  const opened = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5])
  return Math.max(0, Math.floor((now - opened) / 60_000))
}

function SummaryRow({
  label,
  amount,
  strong = false,
}: {
  label: string
  amount: number
  strong?: boolean
}) {
  return (
    <div className={`flex items-center justify-between gap-4 py-1.5 ${strong ? 'font-bold' : ''}`}>
      <span className={strong ? 'text-foreground-strong' : 'text-foreground-muted'}>{label}</span>
      <MoneyDisplay amount={amount} />
    </div>
  )
}

export function CurrentShiftPanel({
  shift,
  onClosed,
}: {
  shift: ShiftRow
  onClosed: () => Promise<void>
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [actualCash, setActualCash] = useState('')
  const [preview, setPreview] = useState<ShiftClosingPreview | null>(null)
  const [printPreview, setPrintPreview] = useState<PrintPreviewTarget | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const totalSales = shift.cash_sales + shift.card_sales + shift.credit_sales
  const elapsed = elapsedMinutes(shift.opened_at, now)
  const parsedCash = useMemo(() => parseMajor(actualCash), [actualCash])
  const variance = preview && parsedCash !== null ? parsedCash - preview.expected_cash : null

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  async function openDialog() {
    if (busy) return
    setBusy(true)
    setError(null)
    setActualCash('')
    setPreview(null)
    try {
      setPreview(await shiftApi.previewShiftClose())
      setDialogOpen(true)
    } catch (e) {
      setError(errorText(t, e))
    } finally {
      setBusy(false)
    }
  }

  async function close() {
    if (busy || !preview) return
    if (parsedCash === null) {
      setError(t('shift.invalidCash'))
      return
    }
    setBusy(true)
    setError(null)
    let result: Awaited<ReturnType<typeof shiftApi.closeShift>>
    try {
      result = await shiftApi.closeShift(parsedCash)
    } catch (e) {
      setError(errorText(t, e))
      setBusy(false)
      return
    }
    setDialogOpen(false)
    try {
      await api.printShift(result.shift.id)
    } catch (e) {
      toast(
        (e as { message: string }).message.startsWith('printer.')
          ? t('shift.closedPrintWarning')
          : t('print.failed'),
        'error',
      )
    }
    try {
      await onClosed()
    } catch {
      // The financial close is committed; a refresh failure must not report it as failed.
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card className="flex h-full flex-col overflow-hidden p-0">
        <div className="flex items-start justify-between gap-4 border-b border-border-subtle bg-surface-muted/50 px-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-section">{t('shift.current')}</h2>
              <Badge tone="success">{t('shift.open')}</Badge>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption">
              <span className="flex items-center gap-1.5">
                <User size={14} aria-hidden />
                {shift.user_name ?? '—'}
              </span>
              <span className="flex items-center gap-1.5">
                <Clock size={14} aria-hidden />
                <span dir="ltr">{formatSqlDateTime(shift.opened_at)}</span>
                <span>
                  · {t('shift.elapsed', { hours: Math.floor(elapsed / 60), minutes: elapsed % 60 })}
                </span>
              </span>
            </div>
          </div>
          <span className="hidden text-xs font-medium text-foreground-subtle sm:block">
            #{shift.id}
          </span>
        </div>
        <div className="grid flex-1 gap-4 p-4 sm:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <section className="flex flex-col justify-center rounded-md bg-primary px-4 py-3 text-primary-foreground">
            <p className="text-sm font-medium opacity-90">{t('shift.sales')}</p>
            <MoneyDisplay amount={totalSales} className="mt-1 text-2xl font-bold tracking-tight" />
            <p className="mt-1 text-sm opacity-90">
              {t('shift.invoiceCount')}:{' '}
              <span className="font-bold tabular-nums">{shift.invoices_count}</span>
            </p>
          </section>
          <section className="grid grid-cols-2 gap-x-5 text-sm">
            <SummaryRow label={t('shift.cashSales')} amount={shift.cash_sales} />
            <SummaryRow label={t('shift.cardSales')} amount={shift.card_sales} />
            <SummaryRow label={t('shift.creditSales')} amount={shift.credit_sales} />
            <SummaryRow label={t('shift.openingCash')} amount={shift.opening_cash} />
            <div className="col-span-2 mt-1 border-t border-border-subtle pt-2">
              <SummaryRow label={t('shift.expectedCash')} amount={shift.expected_cash} strong />
            </div>
          </section>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle px-4 py-3">
          <p className="max-w-sm text-caption">{t('shift.closeHint')}</p>
          <Button
            variant="destructive"
            onClick={() => void openDialog()}
            loading={busy}
            disabled={busy}
          >
            {!busy ? <Lock size={16} aria-hidden /> : null}
            {t('shift.close')}
          </Button>
        </div>
      </Card>
      {dialogOpen && preview ? (
        <Dialog
          open
          onClose={() => !busy && setDialogOpen(false)}
          title={t('shift.closeTitle')}
          wide
        >
          <div className="max-h-[65vh] space-y-4 overflow-y-auto">
            <div className="grid gap-3 rounded-md bg-surface-muted p-3 sm:grid-cols-3">
              <div>
                <p className="text-caption">{t('shift.cashier')}</p>
                <p className="font-bold">{preview.shift.user_name ?? '—'}</p>
              </div>
              <div>
                <p className="text-caption">{t('shift.from')}</p>
                <p className="font-bold" dir="ltr">
                  {formatSqlDateTime(preview.shift.opened_at)}
                </p>
              </div>
              <div>
                <p className="text-caption">{t('shift.to')}</p>
                <p className="font-bold" dir="ltr">
                  {formatSqlDateTime(preview.closing_at)}
                </p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <section className="rounded-md border border-border-subtle p-3">
                <h3 className="mb-1 font-bold text-foreground-strong">
                  {t('shift.financialSummary')}
                </h3>
                <div className="flex justify-between py-1.5 text-foreground-muted">
                  <span>{t('shift.invoiceCount')}</span>
                  <span className="font-bold tabular-nums">{preview.invoices_count}</span>
                </div>
                <SummaryRow label={t('shift.cashSales')} amount={preview.cash_sales} />
                <SummaryRow label={t('shift.cardSales')} amount={preview.card_sales} />
                <SummaryRow label={t('shift.creditSales')} amount={preview.credit_sales} />
                <div className="mt-1 border-t border-border-subtle pt-1.5">
                  <SummaryRow
                    label={t('shift.expectedCash')}
                    amount={preview.expected_cash}
                    strong
                  />
                </div>
              </section>
              <section>
                <Field
                  label={t('shift.actualCash')}
                  error={actualCash.trim() && parsedCash === null ? t('shift.invalidCash') : error}
                  htmlFor="actual-cash"
                >
                  <Input
                    id="actual-cash"
                    className="h-12 text-lg font-bold"
                    dir="ltr"
                    inputMode="decimal"
                    autoComplete="off"
                    value={actualCash}
                    onChange={(e) => {
                      setActualCash(e.target.value)
                      if (error) setError(null)
                    }}
                    placeholder="0.00"
                    disabled={busy}
                  />
                </Field>
                {variance !== null ? (
                  <div
                    className={`mt-3 flex items-center justify-between gap-3 rounded-md border p-3 ${variance === 0 ? 'border-success/40 bg-success-soft text-success-foreground' : variance < 0 ? 'border-destructive-soft bg-destructive-soft text-destructive-soft-foreground' : 'border-warning-soft bg-warning-soft text-warning-foreground'}`}
                  >
                    <span className="font-bold">
                      {variance === 0
                        ? t('shift.cashBalanced')
                        : variance < 0
                          ? t('shift.cashShort')
                          : t('shift.cashOver')}
                    </span>
                    <MoneyDisplay amount={Math.abs(variance)} className="font-bold" />
                  </div>
                ) : null}
                <p className="mt-3 text-caption">{t('shift.countHint')}</p>
              </section>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle pt-4">
              <Button variant="outline" disabled={busy} onClick={() => setDialogOpen(false)}>
                {t('app.cancel')}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setPrintPreview({ kind: 'shift_report', shift_id: shift.id })}
              >
                <Eye size={16} aria-hidden />
                {t('pos.printPreviewBeforePrint')}
              </Button>
              <Button
                variant="destructive"
                disabled={busy || parsedCash === null}
                loading={busy}
                onClick={() => void close()}
              >
                {!busy ? <Lock size={16} aria-hidden /> : null}
                {t('shift.confirmClose')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {printPreview ? (
        <PrintPreviewDialog target={printPreview} onClose={() => setPrintPreview(null)} />
      ) : null}
      {error && !dialogOpen ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  )
}
