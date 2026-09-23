/** Payment dialog: method, discount echo, cash tendered/change, print. */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, MoneyDisplay } from '@/components/ui'
import { Check } from '@/components/ui/icon'
import { Field, Input } from '@/components/ui/input'
import { useToast } from '@/components/ui'
import { api, type OrderPreview, type PrintOutcome } from '@/services/posApi'
import { TotalsBlock } from './OrderPanel'
import { parseMajor } from '@/lib/utils'

export function PaymentDialog({
  orderId,
  onClose,
  onDone,
}: {
  orderId: number
  onClose: () => void
  onDone: (invoiceId: number, outcome: PrintOutcome | null) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [preview, setPreview] = useState<OrderPreview | null>(null)
  const [method, setMethod] = useState<'CASH' | 'CARD' | 'CREDIT'>('CASH')
  const [received, setReceived] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Discount editing lives in the order panel; the dialog just reads the order's
  // current discount (set from the panel before opening). Keep these so the
  // dialog can surface the discount in TotalsBlock and pass it to checkout.
  const [discountMode, setDiscountMode] = useState<string | null>(null)
  const [discountValue, setDiscountValue] = useState<number | null>(null)

  // Sync the dialog's discount state with the order on open.
  useEffect(() => {
    let cancelled = false
    api
      .preview(orderId, null, null)
      .then((p) => {
        if (!cancelled) {
          setDiscountMode(p.discount_mode)
          setDiscountValue(p.discount_value)
        }
      })
      .catch(() => {
        // The second effect re-fetches with the same inputs and surfaces the
        // error inline; nothing to do here without a discount yet.
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  useEffect(() => {
    api
      .preview(orderId, discountMode, discountValue)
      .then((p) => {
        setPreview(p)
        setError(null)
      })
      .catch((e) =>
        setError(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error'])),
      )
  }, [orderId, discountMode, discountValue, t, toast])

  const pay = () => {
    if (!preview) return
    setError(null)
    let receivedMinor: number | null = null
    if (method === 'CASH') {
      const parsed = parseMajor(received)
      if (parsed === null) {
        setError(t('pay.invalidReceived'))
        return
      }
      if (parsed < preview.total) {
        setError(t('pay.insufficientCash'))
        return
      }
      receivedMinor = parsed
    }
    setBusy(true)
    api
      .checkout({
        order_id: orderId,
        method,
        discount_mode: discountMode,
        discount_value: discountValue,
        received: receivedMinor,
      })
      .then((res) =>
        api
          .printInvoice(res.invoice_id)
          .then((outcome) => onDone(res.invoice_id, outcome))
          .catch((e) => {
            // Invoice exists and money is settled; printing failed → surface
            // the failure without pretending the sale failed.
            toast(
              t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']),
              'error',
            )
            onDone(res.invoice_id, null)
          }),
      )
      .catch((e) =>
        setError(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error'])),
      )
      .finally(() => setBusy(false))
  }

  const change =
    preview && method === 'CASH' && parseMajor(received) !== null
      ? (parseMajor(received) as number) - preview.total
      : null

  return (
    <Dialog open onClose={onClose} title={t('pos.pay')}>
      {preview ? <TotalsBlock shown={preview} /> : <p>{t('app.loading')}</p>}

      <div className="mb-3 grid grid-cols-3 gap-2" role="group" aria-label={t('pay.methodLabel')}>
        {(['CASH', 'CARD', 'CREDIT'] as const).map((m) => (
          <Button
            key={m}
            variant={method === m ? 'default' : 'outline'}
            aria-pressed={method === m}
            onClick={() => setMethod(m)}
          >
            {t(`pay.method.${m}`)}
          </Button>
        ))}
      </div>

      {method === 'CASH' ? (
        <Field label={t('pay.received')}>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={received}
            onChange={(e) => setReceived(e.target.value)}
            placeholder="0.00"
          />
        </Field>
      ) : null}
      {change !== null && change >= 0 ? (
        <div className="mt-2 flex justify-between text-sm font-bold">
          <span>{t('pay.change')}</span>
          <MoneyDisplay amount={change} />
        </div>
      ) : null}
      {method === 'CREDIT' ? (
        <p className="mb-2 text-xs text-foreground-subtle">{t('pay.creditHint')}</p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          {t('app.cancel')}
        </Button>
        <Button onClick={pay} disabled={busy || !preview} loading={busy}>
          {!busy ? <Check size={16} aria-hidden /> : null}
          {busy ? t('app.loading') : t('pos.confirmPay')}
        </Button>
      </div>
      <p className="mt-2 text-xs text-foreground-subtle">{t('pos.payHintDiscount')}</p>
    </Dialog>
  )
}
