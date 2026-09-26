/**
 * Discount-authorization dialog (staff screen, MANAGER+).
 *
 * The relationship it manages is explicit: this CASHIER's discount
 * authorization credential. The value is write-only — it is sent once, hashed
 * by the backend with the project's existing Argon2id hashing, and never read
 * back — so this screen can only ever show WHETHER one is configured.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, PasswordInput } from '@/components/ui/input'
import { Save } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { staffApi } from '@/services/posApi'

export function DiscountAuthorizationDialog({
  open,
  userId,
  staffName,
  configured,
  onClose,
  onSaved,
}: {
  open: boolean
  userId: number
  staffName: string
  /** Whether a credential already exists (never its value). */
  configured: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (password.length < 5) {
      setError(t('errors.user.password_too_short'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await staffApi.setDiscountPassword(userId, password)
      // The credential is dropped from component state on success and is never
      // read back from the backend.
      setPassword('')
      toast(t('staff.discountAuthorizationSaved'), 'success')
      onSaved()
      onClose()
    } catch (e) {
      setError(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('staff.discountAuthorization')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm font-bold text-foreground-strong">{staffName}</p>
        <p className="text-caption text-foreground-subtle">
          {t('staff.discountAuthorizationHint')}
        </p>

        <Field label={t('staff.discountPassword')} htmlFor="staff-discount-password" error={error}>
          <PasswordInput
            id="staff-discount-password"
            data-dialog-autofocus
            autoComplete="new-password"
            value={password}
            placeholder={configured ? t('dev.passwordConfigured') : ''}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button onClick={save} disabled={busy || password.length === 0} loading={busy}>
            {!busy ? <Save size={16} aria-hidden /> : null}
            {busy ? t('app.loading') : t('app.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
