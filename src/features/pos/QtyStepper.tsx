import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import { Minus, Plus } from '@/components/ui/icon'

export function QtyStepper({
  qty,
  min = 1,
  onChange,
  big,
}: {
  readonly qty: number
  readonly min?: number
  readonly onChange: (q: number) => void
  readonly big?: boolean
}) {
  const { t } = useTranslation()
  const size = big ? 'icon-lg' : 'icon-sm'
  return (
    <span className="inline-flex items-center gap-1.5">
      <Button
        variant="outline"
        size={size}
        aria-label={t('pos.decreaseQty')}
        onClick={() => onChange(Math.max(min, qty - 1))}
        disabled={qty <= min}
      >
        <Minus size={16} aria-hidden />
      </Button>
      <span className="w-8 text-center text-base font-bold tabular-nums" aria-live="polite">
        {qty}
      </span>
      <Button
        variant="outline"
        size={size}
        aria-label={t('pos.increaseQty')}
        onClick={() => onChange(qty + 1)}
      >
        <Plus size={16} aria-hidden />
      </Button>
    </span>
  )
}
