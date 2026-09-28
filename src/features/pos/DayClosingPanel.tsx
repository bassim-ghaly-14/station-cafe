import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/states'
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmployeeAvatar,
  MoneyDisplay,
  Skeleton,
  useToast,
} from '@/components/ui'

import {
  DisplayDate,
  DisplayDateTime,
  DisplayDateTimeRange,
} from '@/components/ui/display-datetime'
import { Check, CalendarDays, Clock, Eye, Lock, RefreshCw } from '@/components/ui/icon'
import {
  shiftApi,
  type DayClosePreview,
  type DayClosingRecord,
  type DayReconciliation,
  type SettlementPreview,
  type ShiftRow,
} from '@/services/shiftApi'
import { api } from '@/services/posApi'
import { dayBadgeVariant } from '@/lib/status-badge'
import { PrintPreviewDialog, type PrintPreviewTarget } from './PrintPreviewDialog'
import { ClosingCard } from './ClosingCard'
import {
  ExpensesSection,
  HandoverSection,
  SalesSection,
  ServicesSection,
} from './ReconciliationSections'

function errorText(t: ReturnType<typeof useTranslation>['t'], error: unknown) {
  return t([`errors.${(error as { message: string }).message}`, 'errors.internal_error'])
}

function SummaryRow({
  label,
  amount,
  strong = false,
  tone,
}: {
  readonly label: string
  readonly amount: number
  readonly strong?: boolean
  readonly tone?: 'danger' | 'warning'
}) {
  return (
    <div className={`flex items-center justify-between gap-4 py-1.5 ${strong ? 'font-bold' : ''}`}>
      <span className={strong ? 'text-foreground-strong' : 'text-foreground-muted'}>{label}</span>
      <MoneyDisplay
        amount={amount}
        className={
          tone === 'danger'
            ? 'text-destructive'
            : tone === 'warning'
              ? 'text-warning-foreground'
              : undefined
        }
      />
    </div>
  )
}

function ShiftRowItem({ shift }: Readonly<{ readonly shift: ShiftRow }>) {
  const { t } = useTranslation()
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-2.5 text-sm">
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-1.5 font-bold">
          <EmployeeAvatar role={shift.user_role} size="sm" />
          <span className="truncate">{shift.user_name ?? '—'}</span>
          <span className="shrink-0 font-normal text-foreground-subtle">· #{shift.id}</span>
        </p>
        <p className="min-w-0 text-caption">
          <DisplayDateTimeRange from={shift.opened_at} to={shift.closed_at} />
        </p>
      </div>
      <div className="text-end">
        <p>
          {t('shift.invoiceCount')}:{' '}
          <span className="font-bold tabular-nums">{shift.invoices_count}</span>
        </p>
        <MoneyDisplay amount={shift.expected_cash} className="font-bold" />
      </div>
    </li>
  )
}

export function DayClosingPanel({
  dayId,
  revision,
  onDone,
}: {
  readonly dayId: number
  /**
   * POS data revision. The POS page owns the single invalidation signal for
   * the screen and bumps it whenever it reloads POS state (a completed sale,
   * a shift closing, a day settlement). The day card re-reads its sources
   * from that signal, so it can never be a second, stale copy of the data —
   * without polling and without any duplicated global state.
   */
  readonly revision: number
  readonly onDone: () => Promise<void>
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [report, setReport] = useState<DayReconciliation | null>(null)
  const [closePreview, setClosePreview] = useState<DayClosePreview | null>(null)
  const [settlement, setSettlement] = useState<SettlementPreview | null>(null)
  const [history, setHistory] = useState<DayClosingRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [dataValid, setDataValid] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [warnOpenShifts, setWarnOpenShifts] = useState(false)
  const [busy, setBusy] = useState(false)
  const [printPreview, setPrintPreview] = useState<PrintPreviewTarget | null>(null)

  const load = useCallback(
    async (initial = false) => {
      if (initial) setLoading(true)
      else setRefreshing(true)
      try {
        // `preview_day_close` is the backend's own inclusion decision: which
        // shifts the closing will cover, and which open shifts it will exclude.
        // The UI renders that decision; it never computes one.
        const [nextReport, nextSettlement, nextHistory, nextClose] = await Promise.all([
          shiftApi.dayReport(dayId),
          shiftApi.previewDaySettlement(),
          shiftApi.daySettlementHistory(),
          shiftApi.previewDayClose(),
        ])
        if (nextReport.day.id !== nextSettlement.business_day_id) throw new Error('day.stale')
        setReport(nextReport)
        setSettlement(nextSettlement)
        setClosePreview(nextClose)
        setHistory(nextHistory)
        setDataValid(true)
        setError(null)
      } catch (e) {
        setDataValid(false)
        setError(errorText(t, e))
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [dayId, t],
  )

  // Initial load, then a silent reload on every POS data revision. `load` is
  // stable for a given day, so this fires on mount and on revision bumps only.
  useEffect(() => {
    void load(true)
  }, [load, revision])

  const pending = settlement?.pending_shifts ?? []
  // The open shifts come from the BACKEND preview, not from inspecting the
  // shift list here, so the warning can never disagree with the closing.
  const openShifts = closePreview?.open_shifts ?? []
  /**
   * A pending settlement covers the day's CLOSED, not-yet-claimed shifts, and it
   * is independent of whether some OTHER shift is still open: the backend
   * excludes an open shift from a settlement by construction. Requiring the
   * absence of open shifts here would deadlock the manager — a day with both a
   * settled-but-unclaimed shift and a still-open one could neither be settled
   * nor closed. The open-shift confirmation belongs to the CLOSING action, and
   * that is where it stays.
   */
  const readyToSettle = pending.length > 0
  const reconciled = report?.shifts.filter((shift) => shift.status === 'CLOSED') ?? []

  /**
   * Opening the closing dialog. When open shifts exist this raises the
   * CONFIRMATION first: it is a warning, never a blocking error, so the manager
   * can always proceed with the settled shifts.
   */
  function requestClose() {
    if (openShifts.length > 0) {
      setWarnOpenShifts(true)
      return
    }
    setOpen(true)
  }

  async function settle() {
    if (busy || !readyToSettle) return
    setBusy(true)
    setError(null)
    try {
      await shiftApi.settleDay()
      toast(t('settlement.success'), 'success')
      setOpen(false)
      await Promise.allSettled([load(), onDone()])
    } catch (e) {
      setError(errorText(t, e))
    } finally {
      setBusy(false)
    }
  }

  async function closeDay() {
    if (busy || !report || pending.length > 0) return
    setBusy(true)
    setError(null)
    try {
      await shiftApi.closeDay()
    } catch (e) {
      setError(errorText(t, e))
      setBusy(false)
      return
    }
    setOpen(false)
    try {
      await api.printDay(report.day.id)
    } catch (e) {
      toast(
        (e as { message: string }).message.startsWith('printer.')
          ? t('settlement.closedPrintWarning')
          : t('print.failed'),
        'error',
      )
    }
    try {
      await onDone()
    } catch {
      /* Final financial close is already committed. */
    } finally {
      setBusy(false)
    }
  }

  if (loading && !report)
    return (
      <Card className="space-y-4 p-4" aria-label={t('settlement.loading')}>
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle pb-3">
          <Skeleton variant="text" className="h-5 w-32" accessibilityLabel="" />
          <Skeleton variant="text" className="h-6 w-20" accessibilityLabel="" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-28" accessibilityLabel="" />
          <div className="space-y-3 py-1">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} variant="text" className="w-full" accessibilityLabel="" />
            ))}
          </div>
        </div>
        <output className="sr-only">{t('settlement.loading')}</output>
      </Card>
    )
  if (!report || !settlement)
    return (
      <ErrorState
        message={error ?? t('settlement.loadError')}
        onRetry={() => void load(true)}
        retryLabel={t('app.retry')}
      />
    )

  const actionMode = readyToSettle
    ? 'settle'
    : pending.length === 0 && report.shift_count > 0
      ? 'close'
      : 'blocked'
  const actionLabel =
    actionMode === 'settle'
      ? t('settlement.settleAction')
      : actionMode === 'close'
        ? t('settlement.closeAction')
        : t('settlement.pendingAction')
  return (
    <>
      <ClosingCard
        accent="day"
        title={t('settlement.title')}
        icon={<CalendarDays size={18} aria-hidden />}
        status={
          <Badge variant={dayBadgeVariant(report.day.status)} size="sm" dot>
            {t(`settlement.dayStatus.${report.day.status}`)}
          </Badge>
        }
        meta={
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <DisplayDate value={report.day.day_date} />
            <span aria-hidden className="shrink-0 text-foreground-faint select-none">
              ·
            </span>
            <DisplayDateTime value={report.day.opened_at} separator="" />
          </span>
        }
        primaryLabel={t('settlement.totalSales')}
        primaryAmount={report.total_sales}
        primaryNote={
          <p>
            {t('shift.invoiceCount')}:{' '}
            <span className="font-bold tabular-nums">{report.invoices_count}</span>
          </p>
        }
        metrics={
          <>
            <SummaryRow label={t('settlement.cash')} amount={report.cash_sales} />
            <SummaryRow label={t('settlement.card')} amount={report.card_sales} />
            <SummaryRow label={t('settlement.credit')} amount={report.credit_sales} />
            <SummaryRow label={t('settlement.expenses')} amount={report.expenses} />
          </>
        }
        highlight={
          <div className="font-bold">
            <SummaryRow
              label={t('settlement.expectedClosingCash')}
              amount={report.cash.expected_cash}
              strong
            />
          </div>
        }
        footerNote={
          <div>
            <p className="text-sm font-bold">
              {t('settlement.settledShiftsCount', { count: report.shift_count })}
            </p>
            {/* Open shifts are EXCLUDED, and the card says so plainly. */}
            {report.open_shift_count > 0 ? (
              <p className="text-caption text-warning-foreground">
                {t('settlement.openShiftsExcluded')}: {report.open_shift_count}
              </p>
            ) : null}
          </div>
        }
        headerAction={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('app.retry')}
            onClick={() => void load()}
            disabled={refreshing || busy}
          >
            <RefreshCw size={16} aria-hidden />
          </Button>
        }
        action={
          <Button
            variant={actionMode === 'blocked' ? 'outline' : 'default'}
            className={
              actionMode === 'blocked'
                ? undefined
                : 'bg-closing-day-solid text-closing-day-solid-foreground hover:bg-closing-day-solid-hover active:bg-closing-day-solid-active'
            }
            disabled={actionMode === 'blocked' || !dataValid || busy}
            loading={busy}
            onClick={() => (actionMode === 'settle' ? setOpen(true) : requestClose())}
          >
            {actionMode === 'close' ? (
              <Lock size={16} aria-hidden />
            ) : actionMode === 'settle' ? (
              <Check size={16} aria-hidden />
            ) : (
              <Clock size={16} aria-hidden />
            )}
            {actionLabel}
          </Button>
        }
      />
      {error && !open ? (
        <div className="mt-2">
          <ErrorState message={error} onRetry={() => void load(true)} retryLabel={t('app.retry')} />
        </div>
      ) : null}
      {/* The open-shift WARNING. It is a confirmation, not a blocking error:
          cancelling closes nothing, confirming proceeds to the closing dialog
          over the settled shifts only. */}
      {warnOpenShifts ? (
        <Dialog
          open
          onClose={() => setWarnOpenShifts(false)}
          title={t('settlement.openShiftsTitle')}
        >
          <div className="space-y-4">
            <div className="rounded-md border border-warning-border bg-warning-soft p-3 text-warning-foreground">
              <p className="text-sm">{t('settlement.openShiftsBody')}</p>
              <p className="mt-1 font-bold">{t('settlement.openShiftsQuestion')}</p>
            </div>
            {/* One row per excluded shift, carrying the backend's own live
                figures so the manager sees exactly WHAT the closing leaves out
                instead of guessing. The cashier's name appears exactly once, so
                the warning cannot be misread as naming two different shifts.
                `OpenShiftInfo` comes from the hydrated closing preview, never
                recomputed here. */}
            <ul
              aria-label={t('settlement.excludedMoney')}
              className="max-h-48 divide-y divide-border-subtle overflow-y-auto rounded-md border border-border-subtle px-3"
            >
              {openShifts.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 py-2 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <EmployeeAvatar role={null} size="sm" />
                    <span className="truncate">{s.user_name ?? '—'}</span>
                    <span className="shrink-0 font-normal text-foreground-subtle">· #{s.id}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span>
                      {t('settlement.cash')}:{' '}
                      <MoneyDisplay amount={s.cash_sales} className="font-bold tabular-nums" />
                    </span>
                    <span>
                      {t('settlement.expenses')}:{' '}
                      <MoneyDisplay amount={s.expenses} className="font-bold tabular-nums" />
                    </span>
                  </span>
                </li>
              ))}
              <li className="py-2 text-caption text-warning-foreground">
                {t('settlement.excludedMoneyHint')}
              </li>
            </ul>
            <p className="text-caption">
              {t('settlement.openShiftsInReport')}: {report.shift_count}
            </p>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle pt-4">
              <Button variant="outline" onClick={() => setWarnOpenShifts(false)}>
                {t('app.cancel')}
              </Button>
              <Button
                onClick={() => {
                  setWarnOpenShifts(false)
                  setOpen(true)
                }}
              >
                {t('settlement.continueAnyway')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {open ? (
        <Dialog
          open
          onClose={() => !busy && setOpen(false)}
          title={actionMode === 'settle' ? t('settlement.reviewTitle') : t('settlement.finalTitle')}
          wide
        >
          <div className="max-h-[68vh] space-y-4 overflow-y-auto">
            <div className="grid gap-3 rounded-md bg-surface-muted p-3 sm:grid-cols-3">
              <div className="min-w-0">
                <p className="text-caption">{t('app.date')}</p>
                <p className="min-w-0 font-bold">
                  <DisplayDate value={report.day.day_date} />
                </p>
              </div>
              <div className="min-w-0">
                <p className="text-caption">{t('shift.from')}</p>
                <p className="min-w-0 font-bold">
                  <DisplayDateTime value={report.day.opened_at} />
                </p>
              </div>
              <div>
                <p className="text-caption">
                  {t('settlement.progress', {
                    pending: pending.length,
                    settled: reconciled.length,
                  })}
                </p>
                <p className="font-bold">{t(`settlement.dayStatus.${report.day.status}`)}</p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <section className="rounded-md border border-border-subtle p-3">
                <h3 className="mb-1 font-bold">{t('settlement.dayTotals')}</h3>
                {/* The SAME reconciliation sections the shift closing and the
                    printer use, fed by the backend's day report. */}
                <SalesSection data={report} />
                <ServicesSection
                  serviceCharges={report.service_charges}
                  discounts={report.discounts}
                />
                <ExpensesSection
                  total={report.expenses}
                  cashExpenses={report.cash_expenses}
                  breakdown={report.expense_breakdown}
                />
                <HandoverSection cash={report.cash} />
              </section>
              <section>
                <h3 className="mb-2 font-bold">
                  {actionMode === 'settle'
                    ? t('settlement.pendingShifts')
                    : t('settlement.allShifts')}
                </h3>
                {pending.length === 0 ? (
                  <p className="rounded-md bg-success-soft p-3 text-success-foreground">
                    {t('settlement.reconciled')}
                  </p>
                ) : (
                  <ul className="max-h-48 divide-y divide-border-subtle overflow-y-auto rounded-md border border-border-subtle px-3">
                    {pending.map((shift) => (
                      <ShiftRowItem key={shift.id} shift={shift} />
                    ))}
                  </ul>
                )}
                {history.some((item) => !item.final_snapshot) ? (
                  <div className="mt-3">
                    <p className="mb-1 text-caption">{t('settlement.previousSettlements')}</p>
                    <ul className="divide-y divide-border-subtle rounded-md border border-border-subtle px-3">
                      {history
                        .filter((item) => !item.final_snapshot)
                        .map((item) => (
                          <li
                            key={item.id}
                            className="flex items-center justify-between gap-3 py-2 text-sm"
                          >
                            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption">
                              <DisplayDateTime value={item.closed_at} separator="" />
                              <span
                                aria-hidden
                                className="shrink-0 text-foreground-faint select-none"
                              >
                                ·
                              </span>
                              <span className="min-w-0">
                                {t('settlement.settledShifts', { count: item.shift_ids.length })}
                              </span>
                            </span>
                            <MoneyDisplay amount={item.totals.total_sales} className="font-bold" />
                          </li>
                        ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            </div>
            <div
              className={`rounded-md border p-3 ${actionMode === 'close' ? 'border-destructive-border bg-destructive-soft' : 'border-info-border bg-info-soft'}`}
            >
              <p className="font-bold text-foreground-strong">
                {actionMode === 'settle'
                  ? t('settlement.settleConsequence')
                  : t('settlement.closeConsequence')}
              </p>
              <p className="mt-1 text-caption">
                {actionMode === 'settle'
                  ? t('settlement.settleConsequenceHint')
                  : t('settlement.closeConsequenceHint')}
              </p>
            </div>
            {error ? (
              <ErrorState message={error} onRetry={() => void load()} retryLabel={t('app.retry')} />
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle pt-4">
              <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
                {t('app.cancel')}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setPrintPreview({ kind: 'day_report', day_id: report.day.id })}
              >
                <Eye size={16} aria-hidden />
                {t('pos.printPreviewBeforePrint')}
              </Button>
              <Button
                variant="destructive"
                loading={busy}
                disabled={busy}
                onClick={() => void (actionMode === 'settle' ? settle() : closeDay())}
              >
                {actionMode === 'settle' ? (
                  <Check size={16} aria-hidden />
                ) : (
                  <Lock size={16} aria-hidden />
                )}
                {actionMode === 'settle'
                  ? t('settlement.confirmSettlement')
                  : t('settlement.confirmClose')}
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
