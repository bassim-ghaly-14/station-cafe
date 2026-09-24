import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, CardHeader, Dialog, MoneyDisplay, useToast } from '@/components/ui'
import { Clock, Eye, Lock } from '@/components/ui/icon'
import { formatSqlDateTime } from '@/lib/date'
import { shiftApi, type DayReportData } from '@/services/shiftApi'
import { api } from '@/services/posApi'
import { PrintPreviewDialog, type PrintPreviewTarget } from './PrintPreviewDialog'

export function DayClosingPanel({ dayId, onDone }: { dayId: number; onDone: () => Promise<void> }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [preview, setPreview] = useState<DayReportData | null>(null)
  const [open, setOpen] = useState(false)
  const [printPreview, setPrintPreview] = useState<PrintPreviewTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadPreview() {
    try {
      setPreview(await shiftApi.dayReport(dayId))
    } catch {
      setPreview(null)
    }
  }

  useEffect(() => {
    void loadPreview()
  }, [dayId])

  async function closeDay() {
    if (busy || !preview) return

    setBusy(true)
    setError(null)

    try {
      await shiftApi.closeDay() // final snapshot + business_days CLOSED, committed first
    } catch (e) {
      setError(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']))
      setBusy(false)
      return
    }

    setOpen(false)

    try {
      await api.printDay(preview.day.id)
    } catch (e) {
      toast(
        t(
          (e as { message: string }).message.startsWith('printer.')
            ? 'shift.closedPrintWarning'
            : 'print.failed',
        ),
        'error',
      )
    }

    try {
      await onDone()
    } catch {
      // The business day is already committed as closed.
    } finally {
      setBusy(false)
    }
  }

  if (!preview) return null

  return (
    <>
      <Card>
        <CardHeader
          title={t('settlement.title')}
          subtitle={t('settlement.pending', { count: preview.shifts.length })}
        />

        <div className="flex justify-end">
          <Button
            variant="destructive"
            onClick={() => setOpen(true)}
            loading={busy}
            disabled={busy}
          >
            <Lock size={16} aria-hidden />
            {t('settlement.title')}
          </Button>
        </div>
      </Card>

      {open ? (
        <Dialog open onClose={() => !busy && setOpen(false)} title={t('settlement.title')}>
          <div className="max-h-[65vh] space-y-4 overflow-y-auto">
            <p className="text-sm">
              {t('app.date')}: <span dir="ltr">{preview.day.day_date}</span>
            </p>

            <p className="text-sm">
              {t('shift.from')}: <span dir="ltr">{formatSqlDateTime(preview.day.opened_at)}</span>
            </p>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <p>
                {t('shift.invoiceCount')}: {preview.totals.invoices_count}
              </p>

              <p>
                {t('app.amount')}: <MoneyDisplay amount={preview.totals.total_sales} />
              </p>

              <p>
                {t('shift.cashSales')}: <MoneyDisplay amount={preview.totals.cash} />
              </p>

              <p>
                {t('shift.cardSales')}: <MoneyDisplay amount={preview.totals.card} />
              </p>

              <p>
                {t('shift.creditSales')}: <MoneyDisplay amount={preview.totals.credit} />
              </p>

              <p>
                {t('expenses.add')}: <MoneyDisplay amount={preview.totals.expenses} />
              </p>
            </div>

            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
                {t('app.cancel')}
              </Button>

              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  setPrintPreview({
                    kind: 'day_report',
                    day_id: preview.day.id,
                  })
                }
              >
                <Eye size={16} aria-hidden />
                {t('pos.printPreviewBeforePrint')}
              </Button>

              <Button
                variant="destructive"
                disabled={busy}
                loading={busy}
                onClick={() => void closeDay()}
              >
                <Clock size={16} aria-hidden />
                {t('settlement.confirm')}
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
