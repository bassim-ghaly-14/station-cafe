/**
 * Print status — the operational view of the printing pipeline.
 *
 * Read-only presentation: it lists the print jobs the printing service already
 * recorded (`list_print_jobs`), reports the printer configuration
 * (`get_print_config`) and can trigger the existing test print. No printing
 * logic, no SQL and no state of its own lives here, and no technical identifier
 * (document type, job status or error code) is ever rendered — see
 * `@/lib/print-presentation` for the mapping layer.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState } from '@/components/states'
import { Badge, Button, Card, CardHeader, TableSkeleton } from '@/components/ui'
import { DisplayDateTime } from '@/components/ui/display-datetime'
import { Printer, RefreshCw } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useErrText } from '@/lib/err'
import {
  printDocumentLabel,
  printDocumentPresentation,
  printJobErrorMessage,
  printErrorText,
  printJobStatusPresentation,
  printerIsConfigured,
} from '@/lib/print-presentation'
import { opsApi, type PrintConfig, type PrintJobRow } from '@/services/opsApi'
import { PrinterSettings } from './PrinterSettings'

/** Recent jobs shown; the printing service clamps the limit to 1..200. */
const RECENT_JOBS_LIMIT = 30

export function PrintStatusPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [jobs, setJobs] = useState<PrintJobRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // null = configuration not read (or unreadable): no printer state is claimed.
  const [printer, setPrinter] = useState<PrintConfig | null>(null)
  const [testing, setTesting] = useState(false)

  const load = useCallback(() => {
    setLoadError(null)
    opsApi
      .printJobs(RECENT_JOBS_LIMIT)
      .then(setJobs)
      .catch((e) => {
        setLoadError(errText(e))
        toast(errText(e), 'error')
      })
    // Configuration is informational: if it cannot be read, the notice stays
    // hidden instead of blocking the job history.
    opsApi
      .printConfig()
      .then(setPrinter)
      .catch(() => setPrinter(null))
  }, [errText, toast])

  useEffect(() => {
    load()
  }, [load])

  /** Existing test print command — duplicate protection stays backend-owned. */
  async function testPrint() {
    setTesting(true)
    try {
      const outcome = await opsApi.printTest()
      toast(
        outcome.duplicate_suppressed ? t('print.duplicateSuppressed') : t('print.done'),
        'success',
      )
      load()
    } catch (e) {
      toast(printErrorText(t, e), 'error')
    } finally {
      setTesting(false)
    }
  }

  const notConfigured = printer !== null && !printerIsConfigured(printer)

  return (
    <div className="flex flex-col gap-3">
      {/* Printer configuration problem ≠ print failure: it is reported once,
          separately from the jobs, and never as a failed job reason. */}
      {notConfigured ? (
        <div className="flex items-start gap-3 rounded-md border border-warning-border bg-warning-soft p-3 text-warning-foreground">
          <Printer size={18} aria-hidden className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-bold">{t('print.error.notConfigured')}</p>
            <p className="mt-0.5 text-sm">{t('print.printer.notConfiguredHint')}</p>
          </div>
        </div>
      ) : null}

      {/* Configuration is where a printer is actually SET UP, so it lives with
          the printing surface and not in a second place. It renders itself only
          for MANAGER+, which is also who the backend accepts the write from. */}
      {printer ? <PrinterSettings config={printer} onChanged={setPrinter} /> : null}

      {/* Existing operations only: send the test page, reload the recorded
          jobs. No per-job retry exists in the printing service, so none is
          offered here. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void testPrint()} loading={testing}>
          {!testing ? <Printer size={16} aria-hidden /> : null}
          {t('print.testPrint')}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('print.refresh')}
          title={t('print.refresh')}
          onClick={load}
          disabled={testing}
        >
          <RefreshCw size={16} aria-hidden />
        </Button>
      </div>

      <PrintJobsBody jobs={jobs} loadError={loadError} onRetry={load} />
    </div>
  )
}

/**
 * The job list in its three states: not loaded yet (error or skeleton), loaded
 * and empty, or loaded with rows.
 *
 * `jobs === null` means "no list yet" — a first load that failed shows the
 * error, and one still in flight shows the skeleton, so a failure is never
 * presented as an empty queue.
 */
function PrintJobsBody({
  jobs,
  loadError,
  onRetry,
}: Readonly<{
  jobs: PrintJobRow[] | null
  loadError: string | null
  onRetry: () => void
}>) {
  const { t } = useTranslation()
  if (jobs === null) {
    if (loadError) {
      return <ErrorState message={loadError} onRetry={onRetry} retryLabel={t('app.retry')} />
    }
    return <TableSkeleton rows={5} columns={3} />
  }
  if (jobs.length === 0) return <EmptyState title={t('print.empty')} />
  return (
    <Card>
      <CardHeader title={t('print.statusTitle')} subtitle={t('print.statusSubtitle')} />
      <div className="flex flex-col divide-y divide-border-subtle">
        {jobs.map((job) => (
          <PrintJobItem key={job.id} job={job} />
        ))}
      </div>
    </Card>
  )
}

/**
 * One recorded print job: human-readable document name, status badge (color +
 * icon + label, so color is never the only signal), when it happened, how many
 * attempts, and — on failure — the localized reason. The raw backend error stays
 * in the database for diagnostics and is never rendered.
 */
function PrintJobItem({ job }: Readonly<{ readonly job: PrintJobRow }>) {
  const { t } = useTranslation()
  const document = printDocumentPresentation(job.doc_type)
  const status = printJobStatusPresentation(job.status)
  const DocumentIcon = document.icon
  const message = printJobErrorMessage(t, job)

  return (
    // `flex-col` below `sm` so the icon, the document's identity and its
    // metadata are never squeezed into a 296px row by `min-w-48`; the value
    // floor is kept from `sm` up where the two-column layout has the width.
    <div className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:gap-3">
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-muted text-foreground-muted"
      >
        <DocumentIcon size={18} />
      </span>

      <div className="min-w-0 flex-1 sm:min-w-48">
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-body font-bold text-foreground-strong">
            {printDocumentLabel(t, job.doc_type)}
          </span>
          <Badge variant={status.variant} size="sm" icon={status.icon} dot>
            {t(status.labelKey)}
          </Badge>
        </p>

        <p className="text-caption mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <DisplayDateTime value={job.created_at} separator="" />
          <span aria-hidden className="shrink-0 text-foreground-faint select-none">
            ·
          </span>
          <span>
            {t('print.jobNumber')}{' '}
            <span className="tabular-nums" dir="ltr">
              #{job.id}
            </span>
          </span>
          <span aria-hidden className="shrink-0 text-foreground-faint select-none">
            ·
          </span>
          <span>
            {t('print.attempts')}: <span className="tabular-nums">{job.attempts}</span>
          </span>
        </p>

        <PrintJobNote message={message} hintKey={status.hintKey} />
      </div>
    </div>
  )
}

/**
 * The one line under a job's metadata: the failure reason if there is one,
 * otherwise the status hint, otherwise nothing.
 *
 * A failure always wins over a hint, so a job never shows both a red reason and
 * a quiet suggestion about what to do next.
 */
function PrintJobNote({
  message,
  hintKey,
}: Readonly<{ readonly message: string | null; readonly hintKey: string | null }>) {
  const { t } = useTranslation()
  if (message) return <p className="mt-1 text-sm font-medium text-destructive">{message}</p>
  if (hintKey) return <p className="text-caption mt-1">{t(hintKey)}</p>
  return null
}
