/**
 * The catalog grid and the three states it can be in.
 *
 * Loading, failure and "nothing matches" are genuinely different questions, and
 * each answers a different one: loading says "wait", failure says "retry", and
 * empty says "your filters hid everything" — which is why an empty grid offers
 * the clear-filters action and a failure does not. Keeping the decision in ONE
 * place is what stops the three from drifting into the same message.
 */
import { useTranslation } from 'react-i18next'

import { EmptyState, ErrorState } from '@/components/states'
import { Button, CardGridSkeleton } from '@/components/ui'

import { CatalogCard } from './CatalogCard'
import type { Product } from '@/services/posApi'

export function CatalogResults({
  items,
  loadError,
  filtered,
  hasFilters,
  canManageCatalog,
  canDeleteCatalog,
  onRetry,
  onClearFilters,
  onEdit,
  onToggle,
  onDelete,
}: {
  /** `null` while the first read is in flight. */
  readonly items: Product[] | null
  readonly loadError: string | null
  readonly filtered: Product[]
  readonly hasFilters: boolean
  readonly canManageCatalog: boolean
  readonly canDeleteCatalog: boolean
  readonly onRetry: () => void
  readonly onClearFilters: () => void
  readonly onEdit: (product: Product) => void
  readonly onToggle: (product: Product) => void
  readonly onDelete: (product: Product) => void
}) {
  const { t } = useTranslation()

  if (items === null) {
    return loadError ? (
      <ErrorState message={loadError} onRetry={onRetry} retryLabel={t('app.retry')} />
    ) : (
      <CardGridSkeleton cards={6} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" />
    )
  }

  if (filtered.length === 0) {
    return (
      <EmptyState
        title={hasFilters ? t('catalog.empty') : t('app.emptyTitle')}
        action={
          hasFilters ? (
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              {t('catalog.clearFilters')}
            </Button>
          ) : null
        }
      />
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {filtered.map((product) => (
        <CatalogCard
          key={product.id}
          product={product}
          canManage={canManageCatalog}
          canDelete={canDeleteCatalog}
          onEdit={() => onEdit(product)}
          onToggle={() => onToggle(product)}
          onDelete={() => onDelete(product)}
        />
      ))}
    </div>
  )
}
