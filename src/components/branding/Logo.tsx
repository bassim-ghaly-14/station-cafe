/**
 * The single branding entry point. Every logo usage in the app goes through
 * this component — never reference the asset directly elsewhere.
 * Renders the real logo from public/ with a graceful fallback mark.
 *
 * Sizing: width/height attributes pin the intrinsic ratio (no layout shift)
 * while the rendered size resolves from `--logo-size` when an ancestor sets
 * it (e.g. the boot screen's responsive clamp), falling back to `size` px.
 */
import { useState } from 'react'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

export function Logo({
  size = 64,
  withWordmark = false,
  className,
}: {
  readonly size?: number
  readonly withWordmark?: boolean
  readonly className?: string
}) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <div
        role="img"
        aria-label="Station Cafe"
        className={cn(
          'flex items-center justify-center rounded-lg bg-accent font-bold text-foreground-muted select-none',
          className,
        )}
        style={
          {
            width: `var(--logo-size, ${size}px)`,
            height: `var(--logo-size, ${size}px)`,
            fontSize: `calc(var(--logo-size, ${size}px) * 0.3)`,
          } as CSSProperties
        }
      >
        <span dir="ltr">S</span>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <img
        role="img"
        aria-label="Station Cafe"
        src="/station-cafe.png"
        alt=""
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className={cn('select-none object-contain', className)}
        style={
          {
            width: `var(--logo-size, ${size}px)`,
            height: `var(--logo-size, ${size}px)`,
          } as CSSProperties
        }
      />
      {withWordmark ? (
        <span dir="ltr" className="text-xl font-bold text-foreground-strong">
          Station Cafe
        </span>
      ) : null}
    </div>
  )
}
