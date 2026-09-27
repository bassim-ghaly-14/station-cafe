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
import { Button, Dialog, useToast } from '@/components/ui'
import { Maximize2, RotateCcw, X } from '@/components/ui/icon'
import { DocumentPreviewState } from '@/components/states'
import { useErrText } from '@/lib/err'
import { printDocumentLabel } from '@/lib/print-presentation'
import { api, isPrintPreview, type PrintOutcome, type PrintPreview } from '@/services/posApi'
import { ThermalReceipt } from './ThermalReceipt'

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

export function PrintPreviewDialog({
  target,
  onClose,
}: {
  target: PrintPreviewTarget
  onClose: () => void
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
    // Invalidate anything still in flight when the dialog goes away.
    return () => {
      requestId.current++
    }
  }, [load])

  const canReprint = target.kind !== 'order'
  // The paper remains 80mm. This layer is the single display-scale boundary:
  // CSS zoom reserves the complete scaled layout bounds for centering/scrolling.
  const previewScale = expanded ? 2 : 1.3

  const reprint = () => {
    if (!canReprint) return
    setPrinting(true)
    const request: Promise<PrintOutcome> =
      target.kind === 'invoice'
        ? api.printInvoice(target.invoice_id)
        : target.kind === 'shift_report'
          ? api.printShift(target.shift_id)
          : target.kind === 'day_report'
            ? api.printDay(target.day_id)
            : api.printTicket(target.order_id)
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

  const preview = state.status === 'ready' ? state.preview : null

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('print.previewTitle')}
      className={
        expanded
          ? 'w-[min(calc(100vw-1rem),42rem)] max-h-[calc(100vh-1rem)] max-w-2xl'
          : 'w-[min(calc(100vw-1rem),30rem)] max-w-120'
      }
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-foreground-subtle">
          {t('print.previewHint', { paper: preview?.paper_mm ?? 80 })}
          {preview ? (
            <>
              {' · '}
              <span className="font-medium text-foreground-muted">
                {printDocumentLabel(t, preview.doc_type)}
              </span>
            </>
          ) : null}
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t(expanded ? 'print.collapse' : 'print.expand')}
          title={t(expanded ? 'print.collapse' : 'print.expand')}
          onClick={() => setExpanded((value) => !value)}
        >
          <Maximize2 size={16} aria-hidden />
        </Button>
      </div>
      {/* The one state vocabulary for every document preview in the app: the
          POS order, an invoice, a wash ticket, a shift report, a day report.
          `onRetry` is the single reload entry point, so a retry always runs
          exactly one request for the CURRENT target — the callback is rebuilt
          whenever the target changes, and the request token discards answers
          that belong to a target that is no longer on screen. */}
      {state.status === 'error' ? (
        <DocumentPreviewState variant="error" reason={state.reason} onRetry={load} />
      ) : state.status === 'empty' ? (
        /* The command succeeded and the document carries nothing printable.
           Every Station template emits a header, so this is a defensive state,
           not a routine one — it is a calm "nothing here", visibly distinct from
           the failure above, and re-reading the document is the only meaningful
           next step. */
        <DocumentPreviewState variant="empty" docType={state.docType} onRetry={load} />
      ) : state.status === 'loading' ? (
        <DocumentPreviewState variant="loading" />
      ) : (
        <div
          dir="ltr"
          data-testid="print-preview-viewer"
          className="viewer w-full min-h-0 overflow-x-hidden overflow-y-auto rounded-md bg-surface-muted p-3 shadow-inner"
        >
          <div
            data-testid="print-preview-centering"
            dir="ltr"
            className="flex min-w-max justify-center"
          >
            <div
              data-testid="print-preview-scaling"
              data-preview-scale={previewScale}
              className="receipt-scaling-layer shrink-0"
              style={{ zoom: previewScale }}
            >
              <ThermalReceipt preview={state.preview} />
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
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
      </div>
    </Dialog>
  )
}
