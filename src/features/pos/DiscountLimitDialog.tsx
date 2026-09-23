/** Manager/Admin: view + edit the global discount ceiling. */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, MoneyDisplay } from '@/components/ui'
import { Field, Input } from '@/components/ui/input'
import { useToast } from '@/components/ui'
import { formatMinor, parseMajor } from '@/lib/utils'
import { settingsApi, type DiscountLimitConfig } from '@/services/posApi'

export function DiscountLimitDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [limit, setLimit] = useState<DiscountLimitConfig | null>(null)
  const [mode, setMode] = useState<'NONE' | 'PERCENT' | 'FIXED'>('PERCENT')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    settingsApi
      .discountLimit()
      .then((cfg) => {
        setLimit(cfg)
        setMode(cfg.mode)
        setValue(cfg.mode === 'FIXED' ? formatMinor(cfg.value) : String(cfg.value / 1000))
      })
      .catch((e) =>
        setError(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error'])),
      )
  }, [t])

  const save = () => {
    setError(null)
    let scaled = 0
    if (mode === 'PERCENT') {
      const n = parseFloat(value.replace(',', '.'))
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        setError(t('pos.invalidDiscountLimit'))
        return
      }
      scaled = Math.round(n * 1000)
    } else if (mode === 'FIXED') {
      const minor = parseMajor(value || '0')
      if (minor === null) {
        setError(t('pos.invalidDiscountLimit'))
        return
      }
      scaled = minor
    }
    setBusy(true)
    settingsApi
      .setDiscountLimit({ mode, value: scaled })
      .then(() => {
        toast(t('pos.discountLimitSaved'), 'success')
        onClose()
      })
      .catch((e) =>
        setError(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error'])),
      )
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open onClose={onClose} title={t('pos.discountLimitTitle')}>
      <p className="mb-3 text-sm text-foreground-muted">{t('pos.discountLimitHint')}</p>
      {limit ? (
        <p className="mb-3 text-xs text-foreground-subtle">
          {t('pos.discountLimitCurrent')}:{' '}
          {limit.mode === 'NONE'
            ? t('pos.discountLimitNone')
            : limit.mode === 'FIXED'
              ? ((<MoneyDisplay amount={limit.value} />) as unknown as string)
              : `${limit.value / 1000}%`}
        </p>
      ) : null}
      <div className="mb-3 flex gap-2" role="group" aria-label={t('pos.discountLimitTitle')}>
        {(['NONE', 'PERCENT', 'FIXED'] as const).map((m) => (
          <Button
            key={m}
            size="sm"
            variant={mode === m ? 'default' : 'outline'}
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
          >
            {t(`pos.discountLimitMode.${m}`)}
          </Button>
        ))}
      </div>
      {mode === 'PERCENT' ? (
        <Field label={t('pos.discountLimitValuePercent')}>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="15"
          />
        </Field>
      ) : null}
      {mode === 'FIXED' ? (
        <Field label={t('pos.discountLimitValueFixed')}>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0.00"
          />
        </Field>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          {t('app.cancel')}
        </Button>
        <Button onClick={save} loading={busy} disabled={busy}>
          {t('app.save')}
        </Button>
      </div>
    </Dialog>
  )
}
