/**
 * Shared loading / empty / error states.
 * Every data-driven screen must use these — never ship a blank screen.
 */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { RefreshCw } from '@/components/ui/icon'
export function LoadingState({ label }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center gap-3">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
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
      className="flex flex-col items-center gap-3 rounded-lg border border-destructive-soft bg-destructive-soft/40 p-6 text-center"
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
