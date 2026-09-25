/**
 * Discount selector.
 *
 * The POS can only pick from the FIXED amounts an admin configured in Dev
 * Settings: there is no percentage mode, no free amount field, and no way to
 * invent a value. Picking an option asks for the authorization password before
 * anything is applied, and the actual amount is persisted on the order.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, MoneyDisplay, useToast } from '@/components/ui'
import { Check, Tag, X } from '@/components/ui/icon'
import { Field, PasswordInput } from '@/components/ui/input'
import { api, type DiscountSel, type PosOrder } from '@/services/posApi'

export function DiscountDialog({
  initial,
  orderId,
  amounts,
  onClose,
  onApply,
}: {
  initial: DiscountSel
  orderId: number
  /** Admin-configured fixed options, in minor units. */
  amounts: number[]
  onClose: () => void
  onApply: (d: DiscountSel, refreshed?: PosOrder) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [amount, setAmount] = useState<number | null>(
    initial.mode === 'FIXED' ? initial.value : null,
  )
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const apply = (value: number | null, withPassword: string) => {
    setBusy(true)
    setError(null)
    api
      .setDiscount(orderId, value, value === null ? null : withPassword)
      .then((order) => onApply({ mode: value === null ? null : 'FIXED', value }, order))
      .catch((e) => {
        const message = t([`errors.${(e as { message: string }).message}`, 'errors.internal_error'])

        setError(message)
        toast(message, 'error')
      })
      .finally(() => setBusy(false))
  }

  const clear = () => {
    if (initial.mode === null) return
    apply(null, '')
  }

  return (
    <Dialog open onClose={onClose} title={t('pos.addDiscount')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-foreground-muted">{t('pos.discountOptions')}</p>

        <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('pos.discountOptions')}>
          {amounts.map((option) => (
            <Button
              key={option}
              variant={amount === option ? 'default' : 'outline'}
              aria-pressed={amount === option}
              className="min-h-12 justify-between"
              onClick={() => setAmount(option)}
            >
              <span className="font-bold">
                <MoneyDisplay amount={option} />
              </span>

              {amount === option ? <Check size={16} aria-hidden /> : null}
            </Button>
          ))}
        </div>

        {/* Authorization is asked for only once an option is chosen. */}
        <Field label={t('pos.discountAuthorizationPassword')} htmlFor="discount-authorization">
          <PasswordInput
            id="discount-authorization"
            data-dialog-autofocus
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <p className="text-xs text-foreground-subtle">{t('pos.discountPasswordRequired')}</p>

        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>

          {initial.mode !== null ? (
            <Button variant="ghost" onClick={clear} disabled={busy} loading={busy}>
              <X size={16} aria-hidden />
              {t('pos.clearDiscount')}
            </Button>
          ) : null}

          <Button
            disabled={busy || amount === null || password.length < 6}
            loading={busy}
            onClick={() => amount !== null && apply(amount, password)}
          >
            <Tag size={16} aria-hidden />
            {t('app.confirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
