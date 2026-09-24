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
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, useToast } from '@/components/ui'
import { Maximize2, RotateCcw, X } from '@/components/ui/icon'
import { ErrorState } from '@/components/states'
import { api, type PrintOutcome, type PrintPreview } from '@/services/posApi'
import { ThermalReceipt } from './ThermalReceipt'

/** A persisted document or the current read-only order snapshot. */
export type PrintPreviewTarget =
  | {
      kind: 'order'
      order_id: number
      discount_mode?: string | null
      discount_value?: number | null
    }
  | { kind: 'invoice'; invoice_id: number }
  | { kind: 'shift_report'; shift_id: number }
  | { kind: 'day_report'; day_id: number }
  | { kind: 'wash_ticket'; order_id: number }

export function PrintPreviewDialog({
  target,
  onClose,
}: {
  target: PrintPreviewTarget
  onClose: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [preview, setPreview] = useState<PrintPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [printing, setPrinting] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const reportError = useCallback(
    (e: unknown) => t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']),
    [t],
  )

  const load = useCallback(() => {
    const request: Promise<PrintPreview> =
      target.kind === 'order'
        ? api.printPreviewOrder(target.order_id, target.discount_mode, target.discount_value)
        : target.kind === 'invoice'
          ? api.printPreviewInvoice(target.invoice_id)
          : target.kind === 'shift_report'
            ? api.printPreviewShift(target.shift_id)
            : target.kind === 'day_report'
              ? api.printPreviewDay(target.day_id)
              : api.printPreviewTicket(target.order_id)
    // State is only touched from the async result — the dialog owns a single
    // target for its lifetime, so there is nothing to reset synchronously.
    request
      .then((p) => {
        setPreview(p)
        setError(null)
      })
      .catch((e) => setError(reportError(e)))
  }, [target, reportError])

  useEffect(() => {
    load()
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
      .catch((e) => toast(reportError(e), 'error'))
      .finally(() => setPrinting(false))
  }

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
          {t('print.previewHint', { paper: preview?.paper_mm ?? 80 })} ·{' '}
          <span className="font-medium text-foreground-muted">
            {preview ? t([`print.docType.${preview.doc_type}`, preview.doc_type]) : ''}
          </span>
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
      {error ? (
        <ErrorState message={error} onRetry={load} retryLabel={t('app.retry')} />
      ) : !preview ? (
        <p>{t('app.loading')}</p>
      ) : (
        <div
          dir="ltr"
          data-testid="print-preview-viewer"
          className="viewer w-full min-h-0 overflow-x-hidden overflow-y-auto rounded-md bg-[#eee8df] p-3 shadow-inner"
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
              <ThermalReceipt preview={preview} />
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
          <Button onClick={reprint} disabled={!preview || printing} loading={printing}>
            {!printing ? <RotateCcw size={16} aria-hidden /> : null}
            {printing ? t('app.loading') : t('print.reprint')}
          </Button>
        ) : null}
      </div>
    </Dialog>
  )
}
