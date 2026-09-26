/**
 * The two "nothing here" states of the invoices page.
 *
 * They are genuinely different situations and must not look identical:
 *   - `no-data`    the selected day has no invoices at all. There is nothing to
 *                  search and nothing to clear; the useful message is what will
 *                  appear here and when.
 *   - `no-results` invoices exist but the current search/filters exclude all of
 *                  them. The fix is one click, so the reset is offered directly.
 *
 * The motif is a quiet receipt frame drawn from the Station chart tokens, so it
 * follows light and dark without any page-specific colour.
 */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import { FilterX } from '@/components/ui/icon'
import { cn } from '@/lib/utils'

export function InvoiceEmptyState({
  variant,
  onReset,
  className,
}: {
  variant: 'no-data' | 'no-results'
  onReset?: () => void
  className?: string
}) {
  const { t } = useTranslation()
  const noResults = variant === 'no-results'

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-4 px-5 py-12 text-center',
        'rounded-lg border border-border-subtle bg-surface-card',
        className,
      )}
    >
      <ReceiptMotif />

      <div className="flex max-w-md flex-col gap-1.5">
        <h2 className="text-section text-balance">
          {noResults
            ? t('invoicesPage.states.noResultsTitle')
            : t('invoicesPage.states.noDataTitle')}
        </h2>
        <p className="text-pretty text-sm leading-relaxed text-foreground-muted">
          {noResults ? t('invoicesPage.states.noResultsBody') : t('invoicesPage.states.noDataBody')}
        </p>
      </div>

      {noResults && onReset ? (
        <Button type="button" onClick={onReset}>
          <FilterX size={16} aria-hidden />
          {t('invoicesPage.filters.reset')}
        </Button>
      ) : null}
    </div>
  )
}

/** A ruled receipt frame. Decorative only: it encodes no records. */
function ReceiptMotif() {
  return (
    <div aria-hidden dir="ltr" className="w-full max-w-56">
      <svg viewBox="0 0 224 120" className="h-auto w-full" role="presentation" focusable="false">
        <rect
          x="8"
          y="8"
          width="208"
          height="104"
          rx="8"
          fill="none"
          stroke="var(--chart-frame)"
          strokeWidth="1.25"
          strokeDasharray="4 4"
        />
        {[32, 52, 72, 92].map((y, index) => (
          <g key={y}>
            <rect
              x="24"
              y={y - 6}
              width="14"
              height="12"
              rx="3"
              fill={index === 3 ? 'var(--chart-grid)' : 'var(--chart-motif-strong)'}
            />
            <rect
              x="48"
              y={y - 3}
              width={index === 3 ? 64 : 88 + index * 10}
              height="6"
              rx="3"
              fill="var(--chart-grid)"
            />
            <rect x="150" y={y - 3} width="46" height="6" rx="3" fill="var(--chart-grid)" />
          </g>
        ))}
      </svg>
    </div>
  )
}
