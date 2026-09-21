/**
 * The single branding entry point. Every logo usage in the app goes through
 * this component — never reference the asset directly elsewhere.
 * Renders the real logo from public/ with a graceful fallback mark.
 */
import { useState } from 'react'

export function Logo({
  size = 64,
  withWordmark = false,
}: {
  size?: number
  withWordmark?: boolean
}) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <div
        role="img"
        aria-label="Station Cafe"
        className="flex items-center justify-center rounded-lg bg-brand-100 font-bold text-brand-700 select-none"
        style={{ width: size, height: size, fontSize: size * 0.3 }}
      >
        <span dir="ltr">S</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <img
        role="img"
        aria-label="Station Cafe"
        src="/station-cafe.png"
        alt=""
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className="select-none object-contain"
        style={{ width: size, height: size }}
      />
      {withWordmark ? (
        <span dir="ltr" className="text-xl font-bold text-brand-900">
          Station Cafe
        </span>
      ) : null}
    </div>
  )
}

/** Backwards-compatible alias (foundation name). Use `Logo` in new code. */
export const LogoPlaceholder = Logo
