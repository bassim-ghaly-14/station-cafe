import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AmountAutoFill,
  Badge,
  Button,
  Dialog,
  EmployeeAvatar,
  MoneyDisplay,
  useToast,
} from '@/components/ui'
import { DisplayDateTime } from '@/components/ui/display-datetime'
import { Clock, Eye, Lock } from '@/components/ui/icon'
import { Field, Input } from '@/components/ui/input'
import { ListRowsSkeleton, Skeleton } from '@/components/ui'
import { ErrorState } from '@/components/states'
import { parseMajor } from '@/lib/utils'
import { formatMinorMoney } from '@/lib/money'
import { normalizeToUtcIso } from '@/lib/date'
import { shiftApi, type ShiftClosingPreview, type ShiftRow } from '@/services/shiftApi'
import { api } from '@/services/posApi'
import { PrintPreviewDialog, type PrintPreviewTarget } from './PrintPreviewDialog'
import { ClosingCard, ClosingMetric } from './ClosingCard'

function errorText(t: ReturnType<typeof useTranslation>['t'], error: unknown) {
  return t([`errors.${(error as { message: string }).message}`, 'errors.internal_error'])
}

/** Minutes elapsed since the shift opened, from the canonical clock. */
function elapsedMinutes(openedAt: string, now: number) {
  // `openedAt` is a UTC instant and `now` is an epoch instant, so the elapsed
  // time is computed on the timeline — no timezone involved. This stays correct
  // regardless of which business day either value falls on.
  const opened = Date.parse(normalizeToUtcIso(openedAt))
  if (Number.isNaN(opened)) return 0
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
  const [loadingPreview, setLoadingPreview] = useState(false)
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

  // The closing preview is read when the dialog opens, from the SAME command
  // that produced the card's numbers — the dialog never becomes the only place
  // where correct shift totals are visible.
  const loadPreview = useCallback(async () => {
    setLoadingPreview(true)
    try {
      setPreview(await shiftApi.previewShiftClose())
      setError(null)
    } catch (e) {
      setPreview(null)
      setError(errorText(t, e))
    } finally {
      setLoadingPreview(false)
    }
  }, [t])

  // The dialog opens immediately and shows its own loading state; opening is
  // never blocked on a network round-trip.
  function openDialog() {
    if (busy) return
    setActualCash('')
    setPreview(null)
    setError(null)
    setDialogOpen(true)
    void loadPreview()
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
      <ClosingCard
        accent="shift"
        title={t('shift.current')}
        icon={<Clock size={18} aria-hidden />}
        status={
          <Badge variant="success" size="sm" dot>
            {t('shift.open')}
          </Badge>
        }
        meta={
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <EmployeeAvatar role={shift.user_role} size="sm" />
              <span className="truncate">{shift.user_name ?? '—'}</span>
            </span>
            <span className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <Clock size={14} aria-hidden className="shrink-0" />
              <DisplayDateTime value={shift.opened_at} />
              <span>
                · {t('shift.elapsed', { hours: Math.floor(elapsed / 60), minutes: elapsed % 60 })}
              </span>
            </span>
          </>
        }
        primaryLabel={t('shift.sales')}
        primaryAmount={totalSales}
        primaryNote={
          <p>
            {t('shift.invoiceCount')}:{' '}
            <span className="font-bold tabular-nums">{shift.invoices_count}</span>
          </p>
        }
        metrics={
          <>
            <ClosingMetric label={t('shift.cashSales')} amount={shift.cash_sales} />
            <ClosingMetric label={t('shift.cardSales')} amount={shift.card_sales} />
            <ClosingMetric label={t('shift.creditSales')} amount={shift.credit_sales} />
            <ClosingMetric label={t('shift.openingCash')} amount={shift.opening_cash} />
          </>
        }
        highlight={
          <div className="font-bold">
            <SummaryRow label={t('shift.expectedCash')} amount={shift.expected_cash} strong />
          </div>
        }
        footerNote={<p className="max-w-sm text-caption">{t('shift.closeHint')}</p>}
        headerAction={
          <span className="hidden text-xs font-medium text-foreground-subtle sm:block">
            #{shift.id}
          </span>
        }
        action={
          <Button
            variant="outline"
            onClick={openDialog}
            loading={busy}
            disabled={busy}
            className="border-closing-shift-border text-closing-shift-foreground hover:bg-closing-shift-soft"
          >
            {!busy ? <Lock size={16} aria-hidden /> : null}
            {t('shift.close')}
          </Button>
        }
      />
      {dialogOpen ? (
        <Dialog
          open
          onClose={() => !busy && setDialogOpen(false)}
          title={t('shift.closeTitle')}
          wide
        >
          {/* The form is rendered from the first commit, so the cash field exists
              — and holds initial focus — before the closing figures arrive. Only
              the SERVER-DERIVED values show a loading state; the input never
              does, and the user is never asked to open a dialog to refresh
              anything. */}
          <div className="max-h-[65vh] space-y-4 overflow-y-auto">
            <div className="grid gap-3 rounded-md bg-surface-muted p-3 sm:grid-cols-3">
              <div>
                <p className="text-caption">{t('shift.cashier')}</p>
                {preview ? (
                  <p className="flex min-w-0 items-center gap-1.5 font-bold">
                    <EmployeeAvatar role={preview.shift.user_role} size="sm" />
                    <span className="truncate">{preview.shift.user_name ?? '—'}</span>
                  </p>
                ) : (
                  <Skeleton variant="text" className="h-5 w-24" accessibilityLabel="" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-caption">{t('shift.from')}</p>
                {preview ? (
                  <p className="min-w-0 font-bold">
                    <DisplayDateTime value={preview.shift.opened_at} />
                  </p>
                ) : (
                  <Skeleton variant="text" className="h-5 w-28" accessibilityLabel="" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-caption">{t('shift.to')}</p>
                {preview ? (
                  <p className="min-w-0 font-bold">
                    <DisplayDateTime value={preview.closing_at} />
                  </p>
                ) : (
                  <Skeleton variant="text" className="h-5 w-28" accessibilityLabel="" />
                )}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <section className="rounded-md border border-border-subtle p-3">
                <h3 className="mb-1 font-bold text-foreground-strong">
                  {t('shift.financialSummary')}
                </h3>
                {preview ? (
                  <>
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
                  </>
                ) : (
                  <div role="status" aria-label={t('app.loading')}>
                    <ListRowsSkeleton rows={4} />
                  </div>
                )}
              </section>
              <section>
                <Field
                  label={t('shift.actualCash')}
                  // Field-level feedback is validation only. A failed LOAD is
                  // reported once, by the alert below, so the same problem is
                  // never announced twice.
                  error={actualCash.trim() && parsedCash === null ? t('shift.invalidCash') : null}
                  htmlFor="actual-cash"
                >
                  <Input
                    id="actual-cash"
                    className="h-12 text-lg font-bold"
                    dir="ltr"
                    inputMode="decimal"
                    autoComplete="off"
                    // Declares THIS control as the dialog's initial focus target.
                    // The dialog primitive honours the marker once per opening;
                    // the field then behaves like any other controlled input for
                    // the rest of its life — no refocus, no timer, no remount.
                    data-dialog-autofocus=""
                    value={actualCash}
                    onChange={(e) => {
                      setActualCash(e.target.value)
                      if (error) setError(null)
                    }}
                    placeholder="0.00"
                    disabled={busy}
                  />
                </Field>
                {/* The expected cash is a safe, backend-computed amount, so the
                    balanced-drawer case needs no typing. Same shared auto-fill
                    affordance as the payment dialog — an ACTION that writes the
                    field, never a second amount reading. */}
                {preview ? (
                  <AmountAutoFill
                    className="mt-2"
                    amount={preview.expected_cash}
                    label={t('shift.autoFillLabel', {
                      amount: formatMinorMoney(preview.expected_cash),
                    })}
                    hint={t('shift.autoFillHint')}
                    active={parsedCash === preview.expected_cash}
                    disabled={busy}
                    onFill={() => {
                      setActualCash((preview.expected_cash / 100).toFixed(2))
                      if (error) setError(null)
                    }}
                  />
                ) : null}
                {variance !== null ? (
                  <div
                    className={`mt-3 flex items-center justify-between gap-3 rounded-md border p-3 ${variance === 0 ? 'border-success-border bg-success-soft text-success-foreground' : variance < 0 ? 'border-destructive-border bg-destructive-soft text-destructive-soft-foreground' : 'border-warning-border bg-warning-soft text-warning-foreground'}`}
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
            {/* A failed load is reported once, with a retry, because the figures the
                user must reconcile against do not exist yet. A failed SUBMISSION
                is reported inline — the dialog stays open with the amount intact. */}
            {error && !preview ? (
              <ErrorState
                message={error}
                onRetry={() => void loadPreview()}
                retryLabel={t('app.retry')}
              />
            ) : null}
            {error && preview ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle pt-4">
              <Button variant="outline" disabled={busy} onClick={() => setDialogOpen(false)}>
                {t('app.cancel')}
              </Button>
              <Button
                variant="ghost"
                disabled={busy || loadingPreview}
                onClick={() => setPrintPreview({ kind: 'shift_report', shift_id: shift.id })}
              >
                <Eye size={16} aria-hidden />
                {t('pos.printPreviewBeforePrint')}
              </Button>
              <Button
                variant="outline"
                className="border-closing-shift-border text-closing-shift-foreground hover:bg-closing-shift-soft"
                // Never confirm against figures the backend has not returned yet.
                disabled={busy || loadingPreview || !preview || parsedCash === null}
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
    </>
  )
}
