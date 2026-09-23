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
      {/* Department + Search */}
      <div className="mb-3 flex flex-wrap gap-2">
        <div
          className="flex shrink-0 items-center rounded-md border border-border bg-surface-muted p-1"
          role="group"
          aria-label={t('catalog.department')}
        >
          <Button
            variant={dept === 'CAFE' ? 'default' : 'ghost'}
            size="sm"
            aria-pressed={dept === 'CAFE'}
            onClick={() => setDept('CAFE')}
          >
            {t('pos.cafe')}
          </Button>

          <Button
            variant={dept === 'WASH' ? 'default' : 'ghost'}
            size="sm"
            aria-pressed={dept === 'WASH'}
            onClick={() => setDept('WASH')}
          >
            {t('pos.wash')}
          </Button>
        </div>

        <div className="min-w-0 flex-1">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('pos.searchItems')}
            aria-label={t('pos.searchItems')}
          />
        </div>
      </div>

      {/* Quantity */}
      <div className="mb-3 flex items-center justify-between border border-border-subtle bg-surface-muted px-3 py-2">
        <span className="text-sm font-medium text-foreground-muted">{t('pos.qty')}</span>

        <QtyStepper qty={qty} min={1} onChange={setQty} big />
      </div>

      {/* Products */}
      <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto">
        {items.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onAdd(p)}
            className="flex min-h-16 flex-col items-start justify-center gap-0.5 rounded-lg border border-border-strong bg-transparent p-2 text-start text-foreground transition-colors hover:border-border-accent-hover hover:bg-accent active:border-border-accent-hover active:bg-accent-hover"
          >
            <span className="w-full truncate text-sm font-medium">{p.name}</span>

            <span className="text-sm font-bold text-foreground-muted">
              <MoneyDisplay amount={p.price_minor} />
            </span>
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="py-3 text-center text-xs text-foreground-subtle">{t('pos.noItems')}</p>
      ) : null}
    </>
  )
}
