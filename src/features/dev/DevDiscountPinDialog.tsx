/**
 * The shared discount PIN dialog.
 *
 * The PIN is WRITE-ONLY: it is sent once, hashed by the backend, and never read
 * back, so this screen only ever shows whether one is configured. That makes the
 * form a one-shot affair, and the rules it carries are the reason it is its own
 * component rather than a block in the page: typing clears the previous error
 * instead of leaving a stale complaint under a corrected field, closing always
 * discards the draft, and the submit button stays disabled until the entry is
 * actually a valid PIN.
 */
import { useTranslation } from 'react-i18next'

import {
  Button,
  Dialog,
  Field,
  PinInput,
  isValidDiscountPin,
  DISCOUNT_PIN_LENGTH,
} from '@/components/ui'
import { Save } from '@/components/ui/icon'

export function DevDiscountPinDialog({
  open,
  value,
  error,
  busy,
  onClose,
  onValueChange,
  onSubmit,
}: {
  readonly open: boolean
  readonly value: string
  readonly error: string | null
  /** Whether the PIN is being sent right now. */
  readonly busy: boolean
  readonly onClose: () => void
  /** Called with the raw entry; the parent also clears the error. */
  readonly onValueChange: (next: string) => void
  readonly onSubmit: () => void
}) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onClose={onClose} title={t('dev.discountPin')}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit()
        }}
      >
        <p className="text-sm text-foreground-muted">{t('dev.discountPinHelp')}</p>

        <Field
          label={t('dev.discountPin')}
          htmlFor="shared-discount-pin"
          hint={t('dev.discountPinFormatHint', {
            length: DISCOUNT_PIN_LENGTH,
          })}
          error={error}
        >
          <PinInput
            id="shared-discount-pin"
            data-dialog-autofocus
            value={value}
            disabled={busy}
            onValueChange={onValueChange}
          />
        </Field>

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>

          <Button type="submit" loading={busy} disabled={busy || !isValidDiscountPin(value)}>
            {busy ? null : <Save size={16} aria-hidden />}
            {busy ? t('app.loading') : t('app.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
