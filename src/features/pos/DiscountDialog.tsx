/** Order-level FIXED/PERCENT discount dialog (backend enforces limits). */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, useToast } from '@/components/ui'
import { Check } from '@/components/ui/icon'
import { Field, Input, PasswordInput } from '@/components/ui/input'
import { parseMajor } from '@/lib/utils'
import { api, type DiscountSel, type PosOrder } from '@/services/posApi'

export function DiscountDialog({
  initial,
  orderId,
  onClose,
  onApply,
}: {
  initial: DiscountSel
  orderId: number
  onClose: () => void
  onApply: (d: DiscountSel, refreshed?: PosOrder) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [mode, setMode] = useState<'FIXED' | 'PERCENT'>(
    initial.mode === 'FIXED' ? 'FIXED' : 'PERCENT',
  )
  const [value, setValue] = useState(() =>
    initial.mode === 'FIXED' && typeof initial.value === 'number'
      ? (initial.value / 100).toFixed(2)
      : initial.mode === 'PERCENT' && typeof initial.value === 'number'
        ? String(initial.value / 1000)
        : '10',
  )
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const persist = (d: DiscountSel) => {
    if (d.value !== null && password.length < 6) {
      setError(t('errors.discount.password_incorrect'))
      return
    }
    setPassword('')
    setBusy(true)
    api
      .setDiscount(orderId, d.mode, d.value, d.value === null ? null : password)
      .then((o) => onApply(d, o))
      .catch((e) =>
        toast(
          t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']),
          'error',
        ),
      )
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open onClose={onClose} title={t('pos.discount')}>
      <div className="flex flex-col gap-4">
        <div className="mb-3 flex gap-2" role="group" aria-label={t('pos.discount')}>
          <Button
            variant={mode === 'PERCENT' ? 'default' : 'outline'}
            size="sm"
            aria-pressed={mode === 'PERCENT'}
            onClick={() => setMode('PERCENT')}
          >
            %
          </Button>
          <Button
            variant={mode === 'FIXED' ? 'default' : 'outline'}
            size="sm"
            aria-pressed={mode === 'FIXED'}
            onClick={() => setMode('FIXED')}
          >
            {t('pos.fixed')}
          </Button>
        </div>
        <Field
          label={mode === 'PERCENT' ? t('pos.discountPercentHint') : t('pos.discountFixedHint')}
        >
          <Input
            dir="ltr"
            value={value}
            inputMode="decimal"
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <Field label={t('pos.discountAuthorizationPassword')}>
          <PasswordInput
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <p className="text-xs text-foreground-subtle">{t('pos.discountPasswordRequired')}</p>
        {error ? (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => persist({ mode: null, value: null })}
            disabled={busy}
          >
            {t('pos.clearDiscount')}
          </Button>
          <Button
            disabled={busy}
            loading={busy}
            onClick={() => {
              if (mode === 'PERCENT') {
                const n = parseFloat(value.replace(',', '.'))
                if (!Number.isFinite(n) || n < 0 || n > 100) {
                  setError(t('pos.invalidDiscount'))
                  return
                }
                persist({ mode, value: Math.round(n * 1000) })
                return
              }
              const minor = parseMajor(value || '0')
              if (minor === null) {
                setError(t('pos.invalidDiscount'))
                return
              }
              persist({ mode, value: minor })
            }}
          >
            <Check size={16} aria-hidden />
            {t('app.confirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
