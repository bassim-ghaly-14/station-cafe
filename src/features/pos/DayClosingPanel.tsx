import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorState } from '@/components/states'
import { Badge, Button, Card, Dialog, MoneyDisplay, useToast } from '@/components/ui'
import { Check, Clock, Eye, Lock, RefreshCw } from '@/components/ui/icon'
import { formatSqlDateTime } from '@/lib/date'
import {
  shiftApi,
  type DayClosingRecord,
  type DayReportData,
  type SettlementPreview,
  type ShiftRow,
} from '@/services/shiftApi'
import { api } from '@/services/posApi'
import { PrintPreviewDialog, type PrintPreviewTarget } from './PrintPreviewDialog'

function errorText(t: ReturnType<typeof useTranslation>['t'], error: unknown) {
  return t([`errors.${(error as { message: string }).message}`, 'errors.internal_error'])
}

function SummaryRow({
  label,
  amount,
  strong = false,
  tone,
}: {
  label: string
  amount: number
  strong?: boolean
  tone?: 'danger' | 'warning'
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

function ShiftRowItem({ shift }: { shift: ShiftRow }) {
  const { t } = useTranslation()
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-2.5 text-sm">
      <div className="min-w-0">
        <p className="truncate font-bold">
          {shift.user_name ?? '—'}{' '}
          <span className="font-normal text-foreground-subtle">· #{shift.id}</span>
        </p>
        <p className="text-caption" dir="ltr">
          {formatSqlDateTime(shift.opened_at)} → {formatSqlDateTime(shift.closed_at ?? '')}
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

export function DayClosingPanel({ dayId, onDone }: { dayId: number; onDone: () => Promise<void> }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [report, setReport] = useState<DayReportData | null>(null)
  const [settlement, setSettlement] = useState<SettlementPreview | null>(null)
  const [history, setHistory] = useState<DayClosingRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [dataValid, setDataValid] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [printPreview, setPrintPreview] = useState<PrintPreviewTarget | null>(null)

  const load = useCallback(
    async (initial = false) => {
      if (initial) setLoading(true)
      else setRefreshing(true)
      try {
        const [nextReport, nextSettlement, nextHistory] = await Promise.all([
          shiftApi.dayReport(dayId),
          shiftApi.previewDaySettlement(),
          shiftApi.daySettlementHistory(),
        ])
        if (nextReport.day.id !== nextSettlement.business_day_id) throw new Error('day.stale')
        setReport(nextReport)
        setSettlement(nextSettlement)
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

  useEffect(() => {
    void load(true)
  }, [load])

  const pending = settlement?.pending_shifts ?? []
  const hasActiveShift = report?.shifts.some((shift) => shift.status === 'ACTIVE') ?? false
  const readyToSettle = pending.length > 0 && !hasActiveShift
  const reconciled =
    report?.shifts.filter(
      (shift) => shift.status === 'CLOSED' && !pending.some((item) => item.id === shift.id),
    ) ?? []

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
    if (busy || !report || pending.length > 0 || hasActiveShift) return
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
      <Card>
        <p className="py-8 text-center text-foreground-muted" role="status">
          {t('settlement.loading')}
        </p>
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
    : pending.length === 0 && !hasActiveShift
      ? 'close'
      : 'blocked'
  const actionLabel =
    actionMode === 'settle'
      ? t('settlement.settleAction')
      : actionMode === 'close'
        ? t('settlement.closeAction')
        : hasActiveShift
          ? t('settlement.activeShift')
          : t('settlement.pendingAction')
  const differenceTone =
    report.cash_differences === 0 ? undefined : report.cash_differences < 0 ? 'danger' : 'warning'
  const differenceLabel =
    report.cash_differences === 0
      ? t('settlement.cashBalanced')
      : report.cash_differences < 0
        ? t('settlement.cashShort')
        : t('settlement.cashOver')

  return (
    <>
      <Card className="flex h-full flex-col overflow-hidden p-0">
        <div className="flex items-start justify-between gap-3 border-b border-border-subtle bg-surface-muted/50 px-4 py-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-section">{t('settlement.title')}</h2>
              <Badge tone={report.day.status === 'OPEN' ? 'info' : 'success'}>
                {t(`settlement.dayStatus.${report.day.status}`)}
              </Badge>
            </div>
            <p className="mt-1 text-caption">
              <span dir="ltr">{report.day.day_date}</span> ·{' '}
              <span dir="ltr">{formatSqlDateTime(report.day.opened_at)}</span>
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('app.retry')}
            onClick={() => void load()}
            disabled={refreshing || busy}
          >
            <RefreshCw size={16} aria-hidden />
          </Button>
        </div>
        <div className="grid flex-1 gap-4 p-4 sm:grid-cols-2">
          <section className="rounded-md bg-primary px-4 py-3 text-primary-foreground">
            <p className="text-sm font-medium opacity-90">{t('settlement.totalSales')}</p>
            <MoneyDisplay
              amount={report.totals.total_sales}
              className="mt-1 text-2xl font-bold tracking-tight"
            />
            <p className="mt-1 text-sm opacity-90">
              {t('shift.invoiceCount')}:{' '}
              <span className="font-bold tabular-nums">{report.totals.invoices_count}</span>
            </p>
          </section>
          <section className="grid grid-cols-2 gap-x-5 text-sm">
            <SummaryRow label={t('settlement.cash')} amount={report.totals.cash} />
            <SummaryRow label={t('settlement.card')} amount={report.totals.card} />
            <SummaryRow label={t('settlement.credit')} amount={report.totals.credit} />
            <SummaryRow label={t('settlement.expenses')} amount={report.totals.expenses} />
            <div className="col-span-2 mt-1 border-t border-border-subtle pt-2">
              <SummaryRow
                label={t('settlement.expectedDrawer')}
                amount={report.expected_drawer_cash}
                strong
              />
            </div>
          </section>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle px-4 py-3">
          <div>
            <p className="text-sm font-bold">
              {t('settlement.progress', { pending: pending.length, settled: reconciled.length })}
            </p>
            <p className="text-caption">
              {t(actionMode === 'blocked' ? 'settlement.blockedHint' : 'settlement.readyHint')}
            </p>
          </div>
          <Button
            variant={actionMode === 'blocked' ? 'outline' : 'destructive'}
            disabled={actionMode === 'blocked' || !dataValid || busy}
            loading={busy}
            onClick={() => setOpen(true)}
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
        </div>
      </Card>
      {error && !open ? (
        <div className="mt-2">
          <ErrorState message={error} onRetry={() => void load(true)} retryLabel={t('app.retry')} />
        </div>
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
              <div>
                <p className="text-caption">{t('app.date')}</p>
                <p className="font-bold" dir="ltr">
                  {report.day.day_date}
                </p>
              </div>
              <div>
                <p className="text-caption">{t('shift.from')}</p>
                <p className="font-bold" dir="ltr">
                  {formatSqlDateTime(report.day.opened_at)}
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
                <SummaryRow
                  label={t('settlement.totalSales')}
                  amount={report.totals.total_sales}
                  strong
                />
                <SummaryRow label={t('settlement.cash')} amount={report.totals.cash} />
                <SummaryRow label={t('settlement.card')} amount={report.totals.card} />
                <SummaryRow label={t('settlement.credit')} amount={report.totals.credit} />
                <SummaryRow label={t('settlement.expenses')} amount={report.totals.expenses} />
                <div className="mt-1 border-t border-border-subtle pt-1.5">
                  <SummaryRow
                    label={t('settlement.expectedDrawer')}
                    amount={report.expected_drawer_cash}
                    strong
                  />
                </div>
                <SummaryRow
                  label={differenceLabel}
                  amount={Math.abs(report.cash_differences)}
                  tone={differenceTone}
                />
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
                {history.filter((item) => !item.final_snapshot).length > 0 ? (
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
                            <span className="text-caption" dir="ltr">
                              {formatSqlDateTime(item.closed_at)} ·{' '}
                              {t('settlement.settledShifts', { count: item.shift_ids.length })}
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
              className={`rounded-md border p-3 ${actionMode === 'close' ? 'border-destructive-soft bg-destructive-soft' : 'border-info-soft bg-info-soft'}`}
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
