/** Live order panel: product pad with department filter + fast search. */
import { useTranslation } from 'react-i18next'
import { Button, MoneyDisplay } from '@/components/ui'
import { Input } from '@/components/ui/input'
import { QtyStepper } from './QtyStepper'
import type { Product } from '@/services/posApi'

export function ProductPad({
  dept,
  setDept,
  query,
  setQuery,
  qty,
  setQty,
  items,
  onAdd,
}: {
  dept: 'CAFE' | 'WASH'
  setDept: (d: 'CAFE' | 'WASH') => void
  query: string
  setQuery: (q: string) => void
  qty: number
  setQty: (q: number) => void
  items: Product[]
  onAdd: (p: Product) => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <div className="mb-2 flex gap-2">
        <Button
          variant={dept === 'CAFE' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setDept('CAFE')}
        >
          {t('pos.cafe')}
        </Button>
        <Button
          variant={dept === 'WASH' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setDept('WASH')}
        >
          {t('pos.wash')}
        </Button>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('pos.searchItems')}
          aria-label={t('pos.searchItems')}
        />
      </div>
      <div className="mb-2 flex items-center gap-2 text-sm">
        <span>{t('pos.qty')}</span>
        <QtyStepper qty={qty} min={1} onChange={setQty} big />
      </div>
      <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto">
        {items.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onAdd(p)}
            className="flex min-h-16 flex-col items-start justify-center gap-0.5 rounded-lg border border-brand-200 bg-surface-raised p-2 text-right hover:bg-brand-50"
          >
            <span className="w-full truncate text-sm font-medium">{p.name}</span>
            <span className="text-sm font-bold text-brand-700">
              <MoneyDisplay amount={p.price_minor} />
            </span>
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="py-3 text-center text-xs text-brand-500">{t('pos.noItems')}</p>
      ) : null}
    </>
  )
}
