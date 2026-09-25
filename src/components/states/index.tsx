/**
 * Shared empty / error states and the specialized boot progress indicator.
 */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { RefreshCw } from '@/components/ui/icon'

/**
 * Boot-screen progress indicator — the restrained companion to the large
 * Station logo on application startup. A thin indeterminate bar sweep
 * (theme tokens only) instead of a competing circular spinner.
 * Language-independent: the sweep uses physical transforms only.
 */
export function BootLoadingIndicator({ label }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="boot-loading-block flex w-full max-w-60 flex-col items-center gap-3"
    >
      <div aria-hidden="true" dir="ltr" className="boot-progress-track">
        <div className="boot-progress-bar" />
      </div>
      {label ? <p className="text-sm text-foreground-muted">{label}</p> : null}
    </div>
  )
}

export function EmptyState({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
      <p className="font-medium text-foreground-muted">{title}</p>
      {action}
    </div>
  )
}

export function ErrorState({
  message,
  onRetry,
  retryLabel,
}: {
  message: string
  onRetry?: () => void
  retryLabel?: string
}) {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-lg border border-destructive-border bg-destructive-soft p-6 text-center"
    >
      <p className="font-medium text-destructive-soft-foreground">{message}</p>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw size={16} aria-hidden />
          {retryLabel ?? t('app.retry')}
        </Button>
      ) : null}
    </div>
  )
}
