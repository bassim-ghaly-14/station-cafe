/**
 * The one state vocabulary for every DOCUMENT preview in Station.
 *
 * A preview here is never an invoice specifically — it is a rendered 80mm
 * document: cafe / wash / hybrid / takeaway invoice, wash ticket, shift report,
 * day report — produced by the same `preview_*` commands and rendered by the
 * same `ThermalReceipt`. Those three situations are therefore the only ones a
 * preview can be in, and every surface (POS, invoices page, sales drill-down,
 * reports page) presents them identically so a preview never changes
 * personality with its host:
 *
 *   loading → the document is being assembled
 *   empty   → the request resolved and the document carries nothing to show
 *   error   → the document was requested but could not be rendered
 *
 * Wording is document-aware where it can be: the EMPTY state knows the
 * `doc_type` it received, so a shift report never reads "لا توجد فاتورة". The
 * loading and error copy is deliberately document-neutral, because those states
 * are reached before the document type is known (or because it is unknown) and
 * a wrong noun is worse than a generic one.
 *
 * Empty and error are deliberately NOT the same picture. "Nothing to preview"
 * is a calm, intentional state; "preview failed" is a problem. They are
 * distinguished by icon, wording AND surface treatment, never by colour alone.
 *
 * This extends the shared `components/states` primitives rather than replacing
 * them: the generic `ErrorState` has no title/body split and no icon, which is
 * right for a one-line inline message and wrong for a preview surface.
 *
 * Copy is Arabic via i18next — nothing user-visible is hardcoded here.
 */
import { useTranslation } from 'react-i18next'
import { Button, Skeleton } from '@/components/ui'
import { RefreshCw, TriangleAlert } from '@/components/ui/icon'
import { printDocumentFamily } from '@/lib/print-presentation'
import { cn } from '@/lib/utils'

export type DocumentPreviewStateVariant = 'loading' | 'empty' | 'error'

export interface DocumentPreviewStateProps {
  variant: DocumentPreviewStateVariant
  /**
   * The backend document type (`print_jobs.doc_type` vocabulary). Only the
   * empty state needs it, to name the document that came back empty.
   */
  docType?: string | null
  /**
   * Error only: a short, ALREADY TRANSLATED business reason (for example "the
   * wash ticket was not issued yet"). Rendered as a secondary line, never as
   * the primary message, so a specific cause adds context without displacing
   * the calm headline. An unrecognised code must be passed as `null` — raw
   * backend strings never belong here.
   */
  reason?: string | null
  /** Re-runs the request. Omitted when there is nothing to re-run. */
  onRetry?: () => void
  className?: string
}

export function DocumentPreviewState({
  variant,
  docType,
  reason,
  onRetry,
  className,
}: Readonly<DocumentPreviewStateProps>) {
  const { t } = useTranslation()

  if (variant === 'loading') {
    return (
      <output
        aria-busy="true"
        aria-label={t('documentPreview.loading')}
        className={cn(
          'flex min-h-64 items-start justify-center overflow-hidden rounded-md bg-surface-muted p-3',
          className,
        )}
      >
        <DocumentSkeleton />
      </output>
    )
  }

  const failed = variant === 'error'
  const family = printDocumentFamily(docType)

  return (
    <div
      // An error is worth interrupting for; an empty preview is static
      // information and must not steal focus or announce itself repeatedly.
      role={failed ? 'alert' : undefined}
      className={cn(
        'flex flex-col items-center justify-center gap-4 px-5 py-8 text-center',
        failed
          ? 'rounded-md border border-destructive-border bg-destructive-soft'
          : 'rounded-md border border-border-subtle bg-surface-card',
        className,
      )}
    >
      {failed ? <ErrorGlyph /> : <DocumentPaperMotif />}

      {/* The dialog already owns an `h2` title, so the state steps down one
          level to keep the document outline correct. */}
      <div className="flex max-w-sm flex-col gap-1.5">
        <h3
          className={cn(
            'text-base font-bold text-balance',
            failed ? 'text-destructive-soft-foreground' : 'text-foreground-strong',
          )}
        >
          {failed ? t('documentPreview.error.title') : t(`documentPreview.empty.${family}.title`)}
        </h3>
        <p
          className={cn(
            'text-pretty text-sm leading-relaxed',
            failed ? 'text-destructive-soft-foreground' : 'text-foreground-muted',
          )}
        >
          {failed ? t('documentPreview.error.body') : t(`documentPreview.empty.${family}.body`)}
        </p>
        {failed && reason ? (
          <p className="text-pretty text-xs leading-relaxed text-destructive-soft-foreground opacity-80">
            {reason}
          </p>
        ) : null}
      </div>

      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw size={16} aria-hidden />
          {t('app.retry')}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * The failure mark.
 *
 * Icon + surface + wording all change, so the state is never communicated by
 * colour alone. `aria-hidden` because `role="alert"` already announces the
 * headline and the icon carries no information the text does not.
 */
function ErrorGlyph() {
  return (
    <div
      aria-hidden
      className="flex size-11 shrink-0 items-center justify-center rounded-full border border-destructive-border bg-surface-card"
    >
      <TriangleAlert size={22} className="text-destructive" />
    </div>
  )
}

/**
 * The document placeholder shown while the preview loads.
 *
 * A receipt-shaped skeleton, not a centred spinner: it reserves the geometry the
 * real paper will occupy, so `loading → content` does not reflow the dialog. The
 * rules are decorative (`accessibilityLabel=""` → `aria-hidden`) and the single
 * `<output>` above them is what a screen reader hears.
 */
function DocumentSkeleton() {
  return (
    <div className="w-64 space-y-4 rounded-sm bg-surface p-4 shadow-sm" aria-hidden="true">
      <Skeleton variant="text" className="mx-auto w-24" accessibilityLabel="" />
      <Skeleton variant="text" className="w-full" accessibilityLabel="" />
      <Skeleton variant="text" className="w-4/5" accessibilityLabel="" />
      <div className="space-y-2 border-t border-border-subtle pt-4">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} variant="text" className="w-full" accessibilityLabel="" />
        ))}
      </div>
    </div>
  )
}

/**
 * A ruled document frame, drawn from the Station chart tokens so it follows
 * light and dark with no page-specific colour. Decorative only: it carries no
 * text, no amounts and encodes no records, so it can never be read as data.
 *
 * Shared with the invoices-page empty state — the "document" metaphor must look
 * the same everywhere a document is expected.
 */
export function DocumentPaperMotif({ className }: Readonly<{ readonly className?: string }>) {
  return (
    <div aria-hidden dir="ltr" className={cn('w-full max-w-48', className)}>
      <svg viewBox="0 0 224 120" className="h-auto w-full" focusable="false">
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
