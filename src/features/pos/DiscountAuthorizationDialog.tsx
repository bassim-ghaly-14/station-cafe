/**
 * Discount authorization dialog — the compact, cashier-facing gate.
 *
 * Discount authorization is ONE shared 4-digit PIN for the whole cafe, not a
 * credential owned by the cashier who happens to be logged in: anyone who knows
 * the shared PIN may authorize a discount, and the authenticated session only
 * identifies the actor for the audit trail.
 *
 * The dialog appears BEFORE any discount is applied and says so: the discount is
 * not applied until the backend accepts the PIN. It authorizes nothing itself; it
 * only carries the PIN into the same service call that applies the discount, so a
 * modified client gains nothing here.
 *
 * The amount is shown and held fixed for this authorization — going back means
 * choosing a new amount, so an authorization can never silently cover a
 * different discount.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, MoneyDisplay, isValidDiscountPin } from '@/components/ui'
import { Lock } from '@/components/ui/icon'
import { DISCOUNT_PIN_LENGTH, Field, PinInput } from '@/components/ui/input'

export function DiscountAuthorizationDialog({
  amount,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  /** The exact amount this authorization covers, in minor units. */
  readonly amount: number
  readonly busy: boolean
  readonly error: string | null
  readonly onSubmit: (pin: string) => void
  readonly onCancel: () => void
}) {
  const { t } = useTranslation()
  const [pin, setPin] = useState('')
  const complete = isValidDiscountPin(pin)

  return (
    <Dialog open onClose={onCancel} title={t('pos.discountNeedsAuthorization')}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy && complete) onSubmit(pin)
        }}
      >
        <p className="text-sm text-foreground-muted">{t('pos.discountAuthorizationHint')}</p>

        <div className="flex items-center justify-between rounded-md border border-border-subtle bg-surface-muted px-3 py-2">
          <span className="text-sm text-foreground-muted">{t('pos.discountAmount')}</span>
          <MoneyDisplay amount={amount} className="font-bold" />
        </div>

        <Field
          label={t('pos.discountPin')}
          htmlFor="discount-authorization-pin"
          hint={t('pos.discountPinHint', { length: DISCOUNT_PIN_LENGTH })}
          error={error}
        >
          <PinInput
            id="discount-authorization-pin"
            data-dialog-autofocus
            value={pin}
            disabled={busy}
            onValueChange={setPin}
          />
        </Field>

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" disabled={busy || !complete} loading={busy}>
            {!busy ? <Lock size={16} aria-hidden /> : null}
            {busy ? t('app.loading') : t('pos.discountAuthorize')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
