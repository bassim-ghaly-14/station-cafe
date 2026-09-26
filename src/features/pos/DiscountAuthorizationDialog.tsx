/**
 * Discount authorization dialog — the compact, cashier-facing gate.
 *
 * It appears BEFORE any discount is applied and says so: the discount is not
 * applied until the backend accepts the credential. The dialog authorizes
 * nothing itself; it only carries the credential into the same service call
 * that applies the discount, so a modified client gains nothing here.
 *
 * The amount is shown and held fixed for this authorization — going back means
 * choosing a new amount, so an authorization can never silently cover a
 * different discount.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, MoneyDisplay } from '@/components/ui'
import { Lock } from '@/components/ui/icon'
import { Field, PasswordInput } from '@/components/ui/input'
import type { Money } from '@/lib/utils'

export function DiscountAuthorizationDialog({
  amount,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  /** The exact amount this authorization covers, in minor units. */
  amount: Money
  busy: boolean
  error: string | null
  onSubmit: (password: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')

  return (
    <Dialog open onClose={onCancel} title={t('pos.discountNeedsAuthorization')}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy && password) onSubmit(password)
        }}
      >
        <p className="text-sm text-foreground-muted">{t('pos.discountAuthorizationHint')}</p>

        <div className="flex items-center justify-between rounded-md border border-border-subtle bg-surface-muted px-3 py-2">
          <span className="text-sm text-foreground-muted">{t('pos.discountAmount')}</span>
          <MoneyDisplay amount={amount} className="font-bold" />
        </div>

        <Field
          label={t('pos.discountAuthorizationPassword')}
          htmlFor="discount-authorization"
          error={error}
        >
          <PasswordInput
            id="discount-authorization"
            data-dialog-autofocus
            autoComplete="current-password"
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" disabled={busy || password.length === 0} loading={busy}>
            {!busy ? <Lock size={16} aria-hidden /> : null}
            {busy ? t('app.loading') : t('pos.discountAuthorize')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
