/**
 * useMediaQuery — the one place this app asks about a viewport width.
 *
 * A screen that swaps its whole layout (a table for stacked records, say) must
 * NOT render both and hide one with CSS: the hidden copy is still in the
 * accessibility tree, still read out by a screen reader, still parsed by tests,
 * and still mounted twice in memory. Rendering exactly one representation and
 * swapping it on the breakpoint is both cheaper and honest.
 *
 * Defaults to `false` when `matchMedia` is unavailable (server-side rendering,
 * a bare test environment), which keeps the wide/desktop layout as the safe
 * baseline rather than a blank screen.
 */
import { useEffect, useState } from 'react'

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches)
    // Re-syncing only on a real change avoids a pointless render on mount.
    if (list.matches !== matches) setMatches(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query, matches])

  return matches
}

/** The `md` breakpoint of the shared Tailwind scale (768px). */
export const MD_MEDIA_QUERY = '(min-width: 48rem)'

/** True on the table-capable widths; false on phone-sized viewports. */
export function useIsWide(): boolean {
  return useMediaQuery(MD_MEDIA_QUERY)
}
