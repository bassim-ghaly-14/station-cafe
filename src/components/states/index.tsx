/**
 * Shared loading / empty / error states.
 * Every data-driven screen must use these — never ship a blank screen.
 */
export function LoadingState({ label }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center gap-3">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
      {label ? <p className="text-sm text-brand-700">{label}</p> : null}
    </div>
  )
}

export function EmptyState({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-brand-200 p-8 text-center">
      <p className="font-medium text-brand-800">{title}</p>
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
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-6 text-center"
    >
      <p className="font-medium text-red-800">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md bg-brand-600 px-4 py-2 text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-brand-800"
        >
          {retryLabel ?? '↻'}
        </button>
      ) : null}
    </div>
  )
}
