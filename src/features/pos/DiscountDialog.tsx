/**
 * Discount amount step.
 *
 * The AMOUNT is open-ended: the admin quick-pick amounts are shortcuts that fill
 * the field, never a ceiling, so any value the order can carry can be typed.
 * Confirming an amount does NOT apply it — it opens the authorization dialog,
 * and the discount is applied only after the backend accepts the cashier's
 * credential. Clearing an existing discount needs no credential.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, MoneyDisplay, useToast } from '@/components/ui'
import { Tag, X } from '@/components/ui/icon'
import { Field, Input } from '@/components/ui/input'
import { api, type DiscountSel, type PosOrder } from '@/services/posApi'
import { formatMinorMoneyInput } from '@/lib/money'
import { parseMajor } from '@/lib/utils'
import { DiscountAuthorizationDialog } from './DiscountAuthorizationDialog'

export function DiscountDialog({
  initial,
  orderId,
  subtotal,
  amounts,
  onClose,
  onApply,
}: {
  initial: DiscountSel
  orderId: number
  /** Authoritative order subtotal, in minor units. */
  subtotal: number
  /** Admin-configured quick-pick amounts, in minor units. */
  amounts: number[]
  onClose: () => void
  onApply: (d: DiscountSel, refreshed?: PosOrder) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [value, setValue] = useState(
    initial.mode === 'FIXED' && typeof initial.value === 'number'
      ? formatMinorMoneyInput(initial.value)
      : '',
  )
  const [amount, setAmount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const errText = (e: unknown) =>
    t([`errors.${(e as { message: string }).message}`, 'errors.internal_error'])

  const apply = (value: number | null, credential: string | null) => {
    setBusy(true)
    setError(null)
    api
      .setDiscount(orderId, value, credential)
      .then((order) => onApply({ mode: value === null ? null : 'FIXED', value }, order))
      .catch((e) => {
        setError(errText(e))
        toast(errText(e), 'error')
      })
      .finally(() => setBusy(false))
  }

  const authorize = (credential: string) => {
    if (amount === null) return
    apply(amount, credential)
  }

  // The amount must be a real, positive discount this invoice can carry. The
  // backend enforces exactly the same rules; this only avoids a pointless
  // authorization round-trip for an impossible amount.
  const confirm = () => {
    const parsed = parseMajor(value)
    if (parsed === null || parsed <= 0) {
      setError(t('pos.invalidDiscountAmount'))
      return
    }
    if (parsed > subtotal) {
      setError(t('pos.discountExceedsSubtotal'))
      return
    }
    setError(null)
    setAmount(parsed)
  }

  return (
    <>
      <Dialog open onClose={onClose} title={t('pos.addDiscount')}>
        <div className="flex flex-col gap-4">
          {/* The error belongs to whichever step is in front: while the
              authorization dialog is open, the amount field is background. */}
          <Field
            label={t('pos.discountAmount')}
            htmlFor="discount-amount"
            error={amount === null ? error : null}
          >
            <Input
              id="discount-amount"
              data-dialog-autofocus
              inputMode="decimal"
              dir="ltr"
              autoComplete="off"
              value={value}
              placeholder={t('pos.discountAmountPlaceholder')}
              onChange={(e) => {
                setValue(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  confirm()
                }
              }}
            />
          </Field>

          <p className="text-xs text-foreground-subtle">{t('pos.discountOpenEndedHint')}</p>

          {amounts.length > 0 ? (
            <>
              <p className="text-sm text-foreground-muted">{t('pos.discountQuickPicks')}</p>

              <div
                className="grid grid-cols-2 gap-2"
                role="group"
                aria-label={t('pos.discountQuickPicks')}
              >
                {amounts.map((option) => (
                  <Button
                    key={option}
                    variant="outline"
                    className="min-h-12 justify-between"
                    onClick={() => {
                      setValue(formatMinorMoneyInput(option))
                      setError(null)
                    }}
                  >
                    <MoneyDisplay amount={option} className="font-bold" />
                  </Button>
                ))}
              </div>
            </>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t('app.cancel')}
            </Button>

            {initial.mode !== null ? (
              <Button
                variant="ghost"
                disabled={busy}
                loading={busy}
                onClick={() => apply(null, null)}
              >
                <X size={16} aria-hidden />
                {t('pos.clearDiscount')}
              </Button>
            ) : null}

            <Button disabled={busy} onClick={confirm}>
              <Tag size={16} aria-hidden />
              {t('pos.discountContinue')}
            </Button>
          </div>
        </div>
      </Dialog>

      {amount !== null ? (
        <DiscountAuthorizationDialog
          amount={amount}
          busy={busy}
          error={error}
          onSubmit={authorize}
          onCancel={() => {
            setError(null)
            setAmount(null)
          }}
        />
      ) : null}
    </>
  )
}
