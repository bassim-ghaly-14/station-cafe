/**
 * Boot lifecycle timing — the single source of truth for the minimum branded
 * startup duration. The boot clock starts once (module scope) when this module
 * is first evaluated, i.e. at application startup before the first render,
 * so both the db-bridge phase and the session phase share one `bootStartedAt`.
 *
 * Exit rule: BootScreen may exit only when
 *   initializationReady && elapsedTime >= BOOT_MIN_DURATION_MS
 */
import { useEffect, useState } from 'react'

/** Minimum time the BootScreen stays visible (branded startup experience). */
export const BOOT_MIN_DURATION_MS = 3000

/** Duration of the polished boot exit transition (fade/scale to the app). */
export const BOOT_EXIT_DURATION_MS = 450

/** Shorter exit fade used when the user prefers reduced motion. */
export const BOOT_EXIT_REDUCED_MS = 120

/** Single boot start timestamp for the whole application lifetime. */
export const bootStartedAt: number = Date.now()

function remainingBootDelay(from: number = bootStartedAt): number {
  return Math.max(0, BOOT_MIN_DURATION_MS - (Date.now() - from))
}

/**
 * Resolves `true` once at least BOOT_MIN_DURATION_MS have elapsed since
 * `from` (defaults to the shared `bootStartedAt`). Exactly one timeout per
 * mounted consumer; no polling. The `from` parameter exists for tests and
 * for explicit lifecycle restarts (db retry) — production boot uses the
 * default shared clock.
 */
export function useMinimumBootDelayElapsed(from: number = bootStartedAt): boolean {
  const [elapsed, setElapsed] = useState(() => remainingBootDelay(from) === 0)
  useEffect(() => {
    // A new epoch (retry) must re-arm even if a previous epoch elapsed.
    // `from` is a boot epoch chosen by the caller, so this re-arms an external
    // timer on an external change; deriving it during render cannot restart a
    // timeout without also firing during render.
    // oxlint-disable-next-line react/set-state-in-effect -- epoch re-arm.
    setElapsed(remainingBootDelay(from) === 0)
    const remaining = remainingBootDelay(from)
    if (remaining === 0) return
    const id = window.setTimeout(() => setElapsed(true), remaining)
    return () => window.clearTimeout(id)
  }, [from])
  return elapsed
}
