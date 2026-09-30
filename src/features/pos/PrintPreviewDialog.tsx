/**
 * Print preview + reprint for an EXISTING document.
 *
 * Preview and reprint are two readings of one authoritative document:
 *   preview → `preview_*` (same Rust template run, rendered on screen)
 *   reprint → `print_*`   (same template → existing printer pipeline)
 *
 * Nothing is created, printed twice or mutated by the preview itself, and the
 * document is always addressed by its own id (invoice / order).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, DialogActions, useToast } from '@/components/ui'
import { Maximize2, RotateCcw, X } from '@/components/ui/icon'
import { DocumentPreviewState } from '@/components/states'
import { useErrText } from '@/lib/err'
import { printDocumentLabel } from '@/lib/print-presentation'
import { api, isPrintPreview, type PrintOutcome, type PrintPreview } from '@/services/posApi'
import { fitPreviewScale, useMeasuredWidth } from './preview-scale'
import { ThermalReceipt } from './ThermalReceipt'

/**
 * The paper every Station template prints on, used for the hint line and for
 * the display fit before a document has answered. The authoritative value is
 * always the one the preview itself carries (`preview.paper_mm`); this is only
 * what the dialog can say before then.
 */
const DEFAULT_PAPER_MM = 80

/** A persisted document or the current read-only order snapshot. */
export type PrintPreviewTarget =
  | {
      kind: 'order'
      order_id: number
      discount_mode?: string | null
      discount_value?: number | null
      service_charge_minor?: number
    }
  | { kind: 'invoice'; invoice_id: number }
  | { kind: 'shift_report'; shift_id: number }
  | { kind: 'day_report'; day_id: number }
  | { kind: 'wash_ticket'; order_id: number }

/** The one read-only command that renders a target on screen. */
function previewRequest(target: PrintPreviewTarget): Promise<unknown> {
  switch (target.kind) {
    case 'order':
      return api.printPreviewOrder(
        target.order_id,
        target.discount_mode,
        target.discount_value,
        target.service_charge_minor,
      )
    case 'invoice':
      return api.printPreviewInvoice(target.invoice_id)
    case 'shift_report':
      return api.printPreviewShift(target.shift_id)
    case 'day_report':
      return api.printPreviewDay(target.day_id)
    case 'wash_ticket':
      return api.printPreviewTicket(target.order_id)
  }
}

/**
 * The preview is a discriminated union, not three loosely related flags: a
 * settled state can never coexist with a stale one, so "stale data after a
 * failed retry", "stale error after a successful retry" and "empty while
 * loading" are unrepresentable rather than merely unlikely.
 *
 *   loading → the request is in flight; nothing else is on screen
 *   ready   → a well-formed document with at least one operation
 *   empty   → a well-formed document with zero operations (see below)
 *   error   → the request failed, or answered with a malformed payload
 */
type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; preview: PrintPreview }
  | { status: 'empty'; docType: string }
  | { status: 'error'; reason: string | null }

/**
 * The print command for a document that can be reprinted.
 *
 * A reprintable target is a persisted document, never the live order — an order
 * is printed once, from checkout, and re-printing it here would produce a
 * second copy of a ticket the customer already has. `order` and `wash_ticket`
 * share `order_id` and reach the same ticket command, which is why the final
 * branch covers both rather than naming a fifth case.
 */
function reprintRequest(target: PrintPreviewTarget): Promise<PrintOutcome> {
  if (target.kind === 'invoice') return api.printInvoice(target.invoice_id)
  if (target.kind === 'shift_report') return api.printShift(target.shift_id)
  if (target.kind === 'day_report') return api.printDay(target.day_id)
  return api.printTicket(target.order_id)
}

/**
 * What "expanded" means, in one place: the shell's own measurements, the
 * largest display scale the document may be shown at, and the label of the
 * control that undoes it. The three readings can never disagree, because they
 * are one decision.
 *
 * Both shells are the shared `Dialog` — a phone sheet below `sm`, a centred
 * card from `sm` up — and only the EXPANDED one stops being a sheet on a phone:
 * full bleed to every edge, the top safe-area inset respected, no rounded
 * corners and no border, because a surface that fills the screen has no edge to
 * round. The desktop measurement is byte-for-byte what it always was, and the
 * `sm:` prefix on each of those classes is what keeps it that way (the shared
 * dialog declares its own `sm:max-h`, which a bare class would otherwise
 * override at every width).
 *
 * `maxScale` is a CEILING, not the scale: the real scale is the largest one
 * that still fits the measured width, so a phone shows the whole document
 * instead of a cropped middle of it. See `./preview-scale`.
 */
function expandedPresentation(expanded: boolean): {
  readonly sizeClass: string
  readonly maxScale: number
  readonly toggleLabel: 'print.collapse' | 'print.expand'
} {
  if (expanded) {
    return {
      sizeClass: [
        'w-full max-w-none max-h-dvh rounded-none border-0 pt-[env(safe-area-inset-top)]',
        'sm:w-[min(calc(100vw-1rem),42rem)] sm:max-w-2xl sm:max-h-[calc(100dvh-1rem)] sm:rounded-lg sm:border sm:pt-0',
      ].join(' '),
      maxScale: 2,
      toggleLabel: 'print.collapse',
    }
  }

  return {
    // A near-full-width sheet with a real margin on each side, so the document
    // is framed rather than bleeding off both edges of a 320px screen.
    sizeClass: 'w-[min(calc(100vw-1rem),30rem)] max-w-120',
    maxScale: 1.3,
    toggleLabel: 'print.expand',
  }
}

/**
 * The preview body for one state of the discriminated union.
 *
 * A presentational reading of the state: it renders the receipt, or the calm
 * loading / empty / failure view, and never touches the request. `onRetry` is
 * passed straight through, so a retry always runs the caller's own load.
 *
 * `measureRef` is the element the caller's display scale is fitted to: the
 * centering row, whose width IS the space the document may occupy.
 */
function PreviewContent({
  state,
  scale,
  onRetry,
  measureRef,
}: {
  readonly state: PreviewState
  readonly scale: number
  readonly onRetry: () => void
  readonly measureRef: (element: HTMLDivElement | null) => void
}) {
  if (state.status === 'error') {
    return <DocumentPreviewState variant="error" reason={state.reason} onRetry={onRetry} />
  }

  /* The command succeeded and the document carries nothing printable.
     Every Station template emits a header, so this is a defensive state,
     not a routine one — it is a calm "nothing here", visibly distinct from
     the failure above, and re-reading the document is the only meaningful
     next step. */
  if (state.status === 'empty') {
    return <DocumentPreviewState variant="empty" docType={state.docType} onRetry={onRetry} />
  }

  if (state.status === 'loading') return <DocumentPreviewState variant="loading" />

  return (
    <div
      dir="ltr"
      data-testid="print-preview-viewer"
      /*
       * NOT a scroll container. The dialog body is the single scroll owner of
       * this surface (that is the shared `Dialog`'s contract), and a second
       * one here could only ever have scrolled in a phone-sized box inside a
       * phone-sized box — two scrollbars for one document. The viewer is
       * therefore just the paper's frame, as tall as the document.
       *
       * `overflow-x-hidden` is a rounding guard, not the fitting mechanism: the
       * scale below is floored to the measured width, so the document is never
       * wider than this box, and the guard only stops a sub-pixel rounding
       * remainder from turning into a horizontal scrollbar on the dialog.
       *
       * The padding steps down on a phone (8px instead of 12px on each side):
       * at 320px those 8 extra pixels are 5% of the width the document has to
       * be shown in.
       */
      className="viewer w-full min-w-0 overflow-x-hidden rounded-md bg-surface-muted p-2 shadow-inner sm:p-3"
    >
      <div
        ref={measureRef}
        data-testid="print-preview-centering"
        dir="ltr"
        className="flex w-full justify-center"
      >
        <div
          data-testid="print-preview-scaling"
          data-preview-scale={scale}
          className="receipt-scaling-layer shrink-0"
          style={{ zoom: scale }}
        >
          <ThermalReceipt preview={state.preview} />
        </div>
      </div>
    </div>
  )
}

export function PrintPreviewDialog({
  target,
  onClose,
}: {
  readonly target: PrintPreviewTarget
  readonly onClose: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [state, setState] = useState<PreviewState>({ status: 'loading' })
  const [printing, setPrinting] = useState(false)
  const [expanded, setExpanded] = useState(false)

  /**
   * Monotonic request token. Every load claims the next number and only the
   * holder of the current number may settle the state, so a slow answer for a
   * previous target can never paint over the current one (document A → close →
   * document B, or a target change mid-flight). Closing the dialog invalidates
   * in-flight answers as well, so nothing is set on an unmounted dialog.
   */
  const requestId = useRef(0)

  /**
   * The specific, already-translated business reason — or `null` when the code
   * has no translation of its own. An unmapped code (a SQL message, a Rust
   * `Display` string, an IPC failure) therefore yields no detail at all rather
   * than a technical line under a calm headline.
   */
  const businessReason = useCallback(
    (e: unknown): string | null => {
      const code = (e as { message?: unknown } | null)?.message
      if (typeof code !== 'string') return null
      return t(`errors.${code}`, { defaultValue: '' }) || null
    },
    [t],
  )

  const load = useCallback(() => {
    const id = ++requestId.current
    // Reset to loading BEFORE the request: a retry replaces the error state (and
    // the retry button with it, so it cannot be clicked twice) instead of
    // leaving the failure on screen until the answer arrives.
    setState({ status: 'loading' })
    previewRequest(target).then(
      (value) => {
        if (requestId.current !== id) return
        if (!isPrintPreview(value)) {
          // A malformed payload is a failure, not an empty document: rendering
          // it as "nothing to preview" would hide a real backend bug.
          setState({ status: 'error', reason: t('errors.preview.malformed') })
          return
        }
        setState(
          value.ops.length === 0
            ? { status: 'empty', docType: value.doc_type }
            : { status: 'ready', preview: value },
        )
      },
      (e: unknown) => {
        if (requestId.current !== id) return
        setState({ status: 'error', reason: businessReason(e) })
      },
    )
  }, [target, businessReason, t])

  useEffect(() => {
    load()
    // Invalidate anything still in flight when the dialog goes away: closing
    // must guarantee nothing is set on an unmounted dialog, so the token has to
    // be bumped in cleanup. This is deliberate, not an accidental ref read.
    return () => {
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- deliberate.
      requestId.current++
    }
  }, [load])

  const canReprint = target.kind !== 'order'
  // The paper remains 80mm. This layer is the single display-scale boundary:
  // CSS zoom reserves the complete scaled layout bounds for centering.
  const presentation = expandedPresentation(expanded)
  const preview = state.status === 'ready' ? state.preview : null
  /*
   * The scale is fitted to the width actually on screen, so the same dialog
   * shows the whole document on a 320px phone and the desktop's full 1.3 / 2
   * on a desktop. The ref points at the centering row, whose width is exactly
   * the space the document may occupy; until it has been measured (and in a
   * layout-less environment) the presentation's own scale is used.
   */
  const { ref: measureRef, width: availableWidth } = useMeasuredWidth()
  const scale = fitPreviewScale(
    presentation.maxScale,
    availableWidth,
    preview?.paper_mm ?? DEFAULT_PAPER_MM,
  )

  const reprint = () => {
    if (!canReprint) return
    setPrinting(true)
    const request: Promise<PrintOutcome> = reprintRequest(target)
    request
      .then((outcome) =>
        toast(
          outcome.duplicate_suppressed ? t('print.duplicateSuppressed') : t('print.done'),
          'success',
        ),
      )
      .catch((e) => toast(errText(e), 'error'))
      .finally(() => setPrinting(false))
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('print.previewTitle')}
      className={presentation.sizeClass}
      /*
       * The expand/collapse control lives in the sticky header, beside the
       * close button, and not at the top of the scrolling body. On a phone the
       * body is a long document: a control down there is a control the user has
       * to scroll back to the top to reach, in the one presentation where the
       * document is taller than the screen. The title is `min-w-0` and this is
       * `shrink-0`, so an Arabic title shrinks rather than pushing either
       * control past the edge of a 320px screen.
       */
      headerActions={
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label={t(presentation.toggleLabel)}
          title={t(presentation.toggleLabel)}
          onClick={() => setExpanded((value) => !value)}
        >
          <Maximize2 size={16} aria-hidden />
        </Button>
      }
    >
      <p className="mb-3 text-xs text-foreground-subtle">
        {t('print.previewHint', { paper: preview?.paper_mm ?? DEFAULT_PAPER_MM })}
        {preview ? (
          <>
            {' · '}
            <span className="font-medium text-foreground-muted">
              {printDocumentLabel(t, preview.doc_type)}
            </span>
          </>
        ) : null}
      </p>
      {/* The one state vocabulary for every document preview in the app: the
          POS order, an invoice, a wash ticket, a shift report, a day report.
          `onRetry` is the single reload entry point, so a retry always runs
          exactly one request for the CURRENT target — the callback is rebuilt
          whenever the target changes, and the request token discards answers
          that belong to a target that is no longer on screen. */}
      <PreviewContent state={state} scale={scale} onRetry={load} measureRef={measureRef} />

      <DialogActions className="mt-4">
        <Button variant="outline" onClick={onClose}>
          <X size={16} aria-hidden />
          {t('app.close')}
        </Button>
        {canReprint ? (
          // Reprint is only offered for a document that is actually on screen.
          <Button onClick={reprint} disabled={!preview || printing} loading={printing}>
            {!printing ? <RotateCcw size={16} aria-hidden /> : null}
            {printing ? t('app.loading') : t('print.reprint')}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  )
}
