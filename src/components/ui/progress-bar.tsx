import { cn } from '@/lib/utils'

/**
 * Indeterminate progress hairline — the visual language for "this surface is
 * refreshing" without destroying what is already on screen. The animation is a
 * physical transform only, so it is direction-agnostic and unaffected by RTL,
 * and it is disabled under `prefers-reduced-motion`. The element is an
 * `<output>`, whose implicit `status` role gives assistive technology the busy
 * signal; the label is required so the animation is never silent.
 */
export function ProgressBar({ label, className }: { label: string; className?: string }) {
  return (
    <output
      aria-label={label}
      className={cn('relative block h-0.5 w-full overflow-hidden bg-chart-grid', className)}
    >
      <div className="progress-sweep absolute inset-y-0 w-1/3 bg-primary" />
    </output>
  )
}
