import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import { FilterX } from '@/components/ui/icon'
import { cn } from '@/lib/utils'

/**
 * OperationEmptyState — the two "nothing here" states of the operations log.
 *
 * These are genuinely different situations and collapsing them into one
 * message is what makes an operations screen untrustworthy:
 *
 *  - `no-data`    the log itself is empty. There is nothing to look at and
 *                 nothing to clear. The only useful message is what will
 *                 appear later, and when.
 *  - `no-results` the log HAS records but the current search/filters exclude
 *                 all of them. The fix is one click, so the reset control is
 *                 offered directly rather than making the user undo each
 *                 filter by hand.
 *
 * The visual is a quiet log motif — ruled lines in a list frame — matching the
 * table it replaces, and it is decorative only.
 */
export function OperationEmptyState({
  variant,
  total = 0,
  onReset,
  className,
}: {
  readonly variant: 'no-data' | 'no-results'
  /** Size of the unfiltered log, used to make the "no results" copy concrete. */
  readonly total?: number
  readonly onReset?: () => void
  readonly className?: string
}) {
  const { t } = useTranslation()
  const noResults = variant === 'no-results'

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-4 rounded-lg border border-border-subtle bg-surface-card px-5 py-12 text-center',
        className,
      )}
    >
      <LogMotif />

      <div className="flex max-w-md flex-col gap-1.5">
        <h3 className="text-section text-balance">
          {noResults ? t('audit.states.noResultsTitle') : t('audit.states.noDataTitle')}
        </h3>
        <p className="text-pretty text-sm leading-relaxed text-foreground-muted">
          {noResults ? t('audit.states.noResultsBody', { total }) : t('audit.states.noDataBody')}
        </p>
      </div>

      {noResults && onReset ? (
        <Button onClick={onReset}>
          <FilterX size={16} aria-hidden />
          {t('audit.filters.reset')}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * A ruled-list frame. Purely decorative: the rules are evenly spaced, carry no
 * text and encode no records, and the whole block is hidden from assistive
 * technology because the state is announced by the heading above it.
 */
function LogMotif() {
  return (
    <div aria-hidden dir="ltr" className="w-full max-w-64">
      <svg viewBox="0 0 256 96" className="h-auto w-full" focusable="false">
        <rect
          x="8"
          y="8"
          width="240"
          height="80"
          rx="8"
          fill="none"
          stroke="var(--chart-frame)"
          strokeWidth="1.25"
          strokeDasharray="4 4"
        />
        {[28, 48, 68].map((y) => (
          <g key={y}>
            <rect x="24" y={y - 6} width="14" height="12" rx="3" fill="var(--chart-motif-strong)" />
            <rect x="48" y={y - 3} width="86" height="6" rx="3" fill="var(--chart-grid)" />
            <rect x="182" y={y - 3} width="50" height="6" rx="3" fill="var(--chart-grid)" />
          </g>
        ))}
      </svg>
    </div>
  )
}
