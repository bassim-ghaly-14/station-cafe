import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Card, CardHeader, Dialog, MoneyDisplay, useToast } from '@/components/ui'
import { Clock, Eye, Lock } from '@/components/ui/icon'
import { Field, Input } from '@/components/ui/input'
import { formatSqlDateTime } from '@/lib/date'
import { parseMajor } from '@/lib/utils'
import { shiftApi, type ShiftRow } from '@/services/shiftApi'
import { api } from '@/services/posApi'
import { PrintPreviewDialog, type PrintPreviewTarget } from './PrintPreviewDialog'

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
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof shiftApi.previewShiftClose>
  > | null>(null)
  const [printPreview, setPrintPreview] = useState<PrintPreviewTarget | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function openDialog() {
    setBusy(true)
    setError(null)
    try {
      setPreview(await shiftApi.previewShiftClose())
      setDialogOpen(true)
    } catch (e) {
      setError(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']))
    } finally {
      setBusy(false)
    }
  }

  async function close() {
    const amount = parseMajor(actualCash)
    if (amount === null) {
      setError(t('shift.invalidCash'))
      return
    }
    setBusy(true)
    setError(null)
    let result: Awaited<ReturnType<typeof shiftApi.closeShift>>
    try {
      // The close service commits before returning. From this point onward,
      // refresh/printing failures must not be reported as close failures.
      result = await shiftApi.closeShift(amount)
    } catch (e) {
      setError(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']))
      setBusy(false)
      return
    }
    setDialogOpen(false)
    try {
      await api.printShift(result.shift.id)
    } catch (e) {
      if ((e as { message: string }).message.startsWith('printer.')) {
        toast(t('shift.closedPrintWarning'), 'error')
      } else {
        toast(t('print.failed'), 'error')
      }
    }
    try {
      await onClosed()
    } catch {
      // The financial close is already committed; do not reopen or misreport it.
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card>
        <CardHeader
          title={t('shift.current')}
          actions={<Badge tone="success">{t('shift.open')}</Badge>}
        />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1 text-sm">
            <p>
              <span className="font-bold">{t('shift.from')}:</span>{' '}
              <span dir="ltr">{formatSqlDateTime(shift.opened_at)}</span>
            </p>
            <p className="text-foreground-muted">
              {t('shift.cashier')}: {shift.user_name ?? '—'}
            </p>
          </div>
          <Button
            variant="destructive"
            onClick={() => void openDialog()}
            loading={busy}
            disabled={busy}
          >
            <Lock size={16} aria-hidden />
            {t('shift.close')}
          </Button>
        </div>
      </Card>
      {dialogOpen && preview ? (
        <Dialog open onClose={() => !busy && setDialogOpen(false)} title={t('shift.closeTitle')}>
          <div className="max-h-[65vh] space-y-4 overflow-y-auto">
            <p className="text-sm">
              <span className="font-bold">{t('shift.from')}:</span>{' '}
              <span dir="ltr">{formatSqlDateTime(preview.shift.opened_at)}</span>
            </p>
            <p className="text-sm">
              <span className="font-bold">{t('shift.to')}:</span>{' '}
              <span dir="ltr">{formatSqlDateTime(preview.closing_at)}</span>
            </p>
            <p className="text-sm">
              <span className="font-bold">{t('shift.cashier')}:</span>{' '}
              {preview.shift.user_name ?? '—'}
            </p>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <p>
                {t('shift.invoiceCount')}: {preview.invoices_count}
              </p>
              <p>
                {t('shift.cashSales')}: <MoneyDisplay amount={preview.cash_sales} />
              </p>
              <p>
                {t('shift.cardSales')}: <MoneyDisplay amount={preview.card_sales} />
              </p>
              <p>
                {t('shift.creditSales')}: <MoneyDisplay amount={preview.credit_sales} />
              </p>
              <p className="col-span-2 font-bold">
                {t('shift.expectedCash')}: <MoneyDisplay amount={preview.expected_cash} />
              </p>
            </div>
            <Field label={t('shift.actualCash')} error={error}>
              <Input
                id="actual-cash"
                dir="ltr"
                inputMode="decimal"
                value={actualCash}
                onChange={(e) => setActualCash(e.target.value)}
                placeholder="0.00"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setDialogOpen(false)}>
                {t('app.cancel')}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setPrintPreview({ kind: 'shift_report', shift_id: shift.id })}
              >
                <Eye size={16} aria-hidden />
                {t('pos.printPreviewBeforePrint')}
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                loading={busy}
                onClick={() => void close()}
              >
                <Clock size={16} aria-hidden />
                {t('shift.close')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {printPreview ? (
        <PrintPreviewDialog target={printPreview} onClose={() => setPrintPreview(null)} />
      ) : null}
      {error && !dialogOpen ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  )
}
