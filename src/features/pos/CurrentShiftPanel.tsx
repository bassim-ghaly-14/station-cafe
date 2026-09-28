import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseMajor } from '@/lib/utils'
import { Badge, Button, EmployeeAvatar, MoneyDisplay, useToast } from '@/components/ui'
import { DisplayDateTime } from '@/components/ui/display-datetime'
import { Clock, Lock } from '@/components/ui/icon'
import { normalizeToUtcIso } from '@/lib/date'
import {
  shiftApi,
  type CashStatus,
  type ShiftClosingPreview,
  type ShiftRow,
} from '@/services/shiftApi'
import { api } from '@/services/posApi'
import { opsApi, type Expense } from '@/services/opsApi'
import { PrintPreviewDialog, type PrintPreviewTarget } from './PrintPreviewDialog'
import { ClosingCard, ClosingMetric } from './ClosingCard'
import { AddExpenseButton, ShiftExpenseDialog } from './ShiftExpenses'
import { CloseShiftDialog } from './CloseShiftDialog'

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
  readonly label: string
  readonly amount: number
  readonly strong?: boolean
}) {
  return (
    <div className={`flex items-center justify-between gap-4 py-1.5 ${strong ? 'font-bold' : ''}`}>
      <span className={strong ? 'text-foreground-strong' : 'text-foreground-muted'}>{label}</span>
      <MoneyDisplay amount={amount} />
    </div>
  )
}

/** The open shift's live card: who opened it, for how long, and what it took. */
function ShiftSummaryCard({
  shift,
  elapsedMinutesValue,
  busy,
  onOpenExpense,
  onOpenClose,
}: {
  readonly shift: ShiftRow
  readonly elapsedMinutesValue: number
  readonly busy: boolean
  readonly onOpenExpense: () => void
  readonly onOpenClose: () => void
}) {
  const { t } = useTranslation()
  return (
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
              ·{' '}
              {t('shift.elapsed', {
                hours: Math.floor(elapsedMinutesValue / 60),
                minutes: elapsedMinutesValue % 60,
              })}
            </span>
          </span>
        </>
      }
      primaryLabel={t('shift.sales')}
      primaryAmount={shift.total_sales}
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
        <>
          <AddExpenseButton onClick={onOpenExpense} />
          <Button
            variant="outline"
            onClick={onOpenClose}
            loading={busy}
            disabled={busy}
            className="border-closing-shift-border text-closing-shift-foreground hover:bg-closing-shift-soft"
          >
            {!busy ? <Lock size={16} aria-hidden /> : null}
            {t('shift.close')}
          </Button>
        </>
      }
    />
  )
}

export function CurrentShiftPanel({
  shift,
  onClosed,
  onRefresh,
}: {
  readonly shift: ShiftRow
  readonly onClosed: () => Promise<void>
  /**
   * Invalidation hook for a mutation that changes the shift's own figures (a
   * booked expense changes the expected drawer). The card reads `shift` from the
   * POS screen, so without this the screen would keep showing the pre-expense
   * totals until some unrelated refresh happened.
   */
  readonly onRefresh?: () => void | Promise<void>
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
  const [expenseOpen, setExpenseOpen] = useState(false)
  const [shiftExpenses, setShiftExpenses] = useState<Expense[] | null>(null)

  const elapsed = elapsedMinutes(shift.opened_at, now)
  const parsedCash = useMemo(() => parseMajor(actualCash), [actualCash])
  /**
   * A live preview of the verdict the user is about to create.
   *
   * This is NOT a financial rule: `expected_cash` is the backend's figure and
   * only the pending, un-submitted input is compared against it. The submitted
   * difference and status always come back from the backend, so this label can
   * never contradict the persisted result. It reuses the same status vocabulary
   * and colors as the closing document so the two always agree.
   */
  const pendingStatus = useMemo<CashStatus | null>(() => {
    if (!preview || parsedCash === null) return null
    if (parsedCash === preview.expected_cash) return 'BALANCED'
    return parsedCash < preview.expected_cash ? 'SHORTAGE' : 'SURPLUS'
  }, [preview, parsedCash])

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
  async function openDialog() {
    if (busy) return
    setActualCash('')
    setPreview(null)
    setError(null)
    setDialogOpen(true)
    await loadPreview()
  }

  function openExpense() {
    setExpenseOpen(true)
  }

  // The dialog is not dismissible while a close is in flight: the command is
  // already committed server-side, so leaving it open would invite a second one.
  function closeDialog() {
    if (busy) return
    setDialogOpen(false)
  }

  // Typing replaces the previous verdict, so any stale submission error is
  // cleared by the same action that changes what it was about.
  function changeActualCash(value: string) {
    setActualCash(value)
    if (error) setError(null)
  }

  function fillExpectedCash() {
    if (!preview) return
    setActualCash((preview.expected_cash / 100).toFixed(2))
    if (error) setError(null)
  }

  function openPrintPreview() {
    setPrintPreview({ kind: 'shift_report', shift_id: shift.id })
  }

  // The shift's own expense rows. Booking one changes the expected drawer, so
  // the live card and the closing dialog are both re-read from the backend.
  const loadExpenses = useCallback(async () => {
    try {
      setShiftExpenses(await opsApi.shiftExpenses())
    } catch {
      setShiftExpenses([])
    }
  }, [])

  useEffect(() => {
    // A failed read is already handled inside `loadExpenses`, so there is no
    // rejection left to swallow here.
    loadExpenses()
  }, [loadExpenses])

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
      <ShiftSummaryCard
        shift={shift}
        elapsedMinutesValue={elapsed}
        busy={busy}
        onOpenExpense={openExpense}
        onOpenClose={openDialog}
      />
      {dialogOpen ? (
        <CloseShiftDialog
          preview={preview}
          loadingPreview={loadingPreview}
          error={error}
          busy={busy}
          actualCash={actualCash}
          parsedCash={parsedCash}
          pendingStatus={pendingStatus}
          shiftExpenses={shiftExpenses}
          onActualCashChange={changeActualCash}
          onFillExpected={fillExpectedCash}
          onRetry={loadPreview}
          onPrintPreview={openPrintPreview}
          onConfirm={close}
          onCancel={closeDialog}
        />
      ) : null}
      {printPreview ? (
        <PrintPreviewDialog target={printPreview} onClose={() => setPrintPreview(null)} />
      ) : null}
      <ShiftExpenseDialog
        open={expenseOpen}
        onClose={() => setExpenseOpen(false)}
        onCreated={async () => {
          await loadExpenses()
          // A new expense changes the expected drawer, so the closing figures
          // must be re-read from the backend rather than adjusted here.
          if (dialogOpen) await loadPreview()
          // ...and the card's own totals come from the screen's state, so they
          // must be invalidated too — otherwise the drawer on screen stays stale.
          await onRefresh?.()
        }}
      />
    </>
  )
}
