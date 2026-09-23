/** Live order panel: order-level FIXED/PERCENT discount dialog. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog } from '@/components/ui'
import { Check } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import type { DiscountSel } from './OrderPanel'

export function DiscountDialog({
  onClose,
  onApply,
}: {
  onClose: () => void
  onApply: (d: DiscountSel) => void
}) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'FIXED' | 'PERCENT'>('PERCENT')
  const [value, setValue] = useState('10')
  const [error, setError] = useState<string | null>(null)

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
        <Input
          dir="ltr"
          value={value}
          inputMode="decimal"
          onChange={(e) => setValue(e.target.value)}
        />
        {error ? (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button variant="ghost" onClick={() => onApply({ mode: null, value: null })}>
            {t('pos.clearDiscount')}
          </Button>
          <Button
            onClick={() => {
              const n = parseFloat(value.replace(',', '.'))
              if (!Number.isFinite(n) || n < 0) {
                setError(t('pos.invalidDiscount'))
                return
              }
              // Backend re-validates; PERCENT uses the ×1000 fixed-point scale.
              const scaled = mode === 'PERCENT' ? Math.round(n * 1000) : Math.round(n * 100)
              if (mode === 'PERCENT' && scaled > 100_000) {
                setError(t('pos.invalidDiscount'))
                return
              }
              onApply({ mode, value: scaled })
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
