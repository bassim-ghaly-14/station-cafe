/** Payment dialog: method + live totals, cash tendered/change, print. */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, MoneyDisplay } from '@/components/ui'
import { Check } from '@/components/ui/icon'
import { Field, Input } from '@/components/ui/input'
import { useToast } from '@/components/ui'
import { api, type DiscountSel, type OrderPreview, type PrintOutcome } from '@/services/posApi'
import { TotalsBlock } from './CheckoutSummary'
import { parseMajor } from '@/lib/utils'

export function PaymentDialog({
  orderId,
  discount,
  order,
  onClose,
  onDone,
}: {
  orderId: number
  discount: DiscountSel
  order?: { order_type?: string; takeaway_no?: number | null } | null
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

  // Single authoritative preview: the SAME discount selection the order panel
  // holds. No second discount editor lives here — one source of truth.
  useEffect(() => {
    api
      .preview(orderId, discount.mode, discount.value)
      .then((p) => {
        setPreview(p)
        setError(null)
      })
      .catch((e) =>
        setError(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error'])),
      )
  }, [orderId, discount.mode, discount.value, t])

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
        discount_mode: discount.mode,
        discount_value: discount.value,
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
      {order?.order_type === 'TAKEAWAY' ? (
        <p className="mb-2 text-sm font-bold text-foreground-strong">
          {t('pos.takeaway')}
          {typeof order.takeaway_no === 'number' ? (
            <>
              {' '}
              {t('pos.takeawayNo')}: <span dir="ltr">#{order.takeaway_no}</span>
            </>
          ) : (
            <> · {t('pos.takeawayHint')}</>
          )}
        </p>
      ) : null}
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
