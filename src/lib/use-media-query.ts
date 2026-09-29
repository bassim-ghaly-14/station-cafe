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
import { useCallback, useSyncExternalStore } from 'react'

/** False whenever `matchMedia` cannot answer, which is the safe wide-layout default. */
function readMatches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(query).matches
}

function subscribeToQuery(query: string, onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return () => undefined
  const list = window.matchMedia(query)
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

export function useMediaQuery(query: string): boolean {
  // `matchMedia` is an EXTERNAL system, so it is read through
  // `useSyncExternalStore` — the same subscribe/notify shape this app already
  // uses for the formatting and category-visibility stores. That keeps the read
  // in sync with the browser at all times without a mirroring copy of the value
  // in state, and therefore without a "re-sync on mount" pass that would set
  // state during an effect and start a second render for a value that is
  // already correct.
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToQuery(query, onChange),
    [query],
  )
  const getSnapshot = useCallback(() => readMatches(query), [query])
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

/** The `md` breakpoint of the shared Tailwind scale (768px). */
export const MD_MEDIA_QUERY = '(min-width: 48rem)'

/** True on the table-capable widths; false on phone-sized viewports. */
export function useIsWide(): boolean {
  return useMediaQuery(MD_MEDIA_QUERY)
}
