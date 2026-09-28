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
 * The motif is the shared document frame drawn from the Station chart tokens, so
 * it follows light and dark without any page-specific colour and looks exactly
 * like the "no document" motif inside the preview dialog.
 */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import { DocumentPaperMotif } from '@/components/states'
import { FilterX } from '@/components/ui/icon'
import { cn } from '@/lib/utils'

export function InvoiceEmptyState({
  variant,
  onReset,
  className,
  copy,
}: {
  readonly variant: 'no-data' | 'no-results'
  readonly onReset?: () => void
  readonly className?: string
  /**
   * The message namespace to speak from. The invoices page passes nothing and
   * gets its own copy; a sibling record view (تذاكر المغسلة اليوم) passes its
   * own, so the frame, the motif and the reset affordance are implemented ONCE
   * instead of being copied into a lookalike empty state.
   */
  readonly copy?: string
}) {
  const { t } = useTranslation()
  const noResults = variant === 'no-results'
  const ns = copy ?? 'invoicesPage'

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-4 px-5 py-12 text-center',
        'rounded-lg border border-border-subtle bg-surface-card',
        className,
      )}
    >
      <DocumentPaperMotif className="max-w-40" />

      <div className="flex max-w-md flex-col gap-1.5">
        <h2 className="text-section text-balance">
          {noResults ? t(`${ns}.states.noResultsTitle`) : t(`${ns}.states.noDataTitle`)}
        </h2>
        <p className="text-pretty text-sm leading-relaxed text-foreground-muted">
          {noResults ? t(`${ns}.states.noResultsBody`) : t(`${ns}.states.noDataBody`)}
        </p>
      </div>

      {noResults && onReset ? (
        <Button type="button" onClick={onReset}>
          <FilterX size={16} aria-hidden />
          {t(`${ns}.filters.reset`)}
        </Button>
      ) : null}
    </div>
  )
}
