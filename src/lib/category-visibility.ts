/**
 * Cashier category visibility — WHICH categories live in the catalog's primary
 * category bar.
 *
 * This is a workstation UI preference, not business data: it changes where a
 * chip is drawn, never what can be filtered, priced or sold. Every category
 * always stays reachable through the expanded bar and the manager, so no
 * category is ever deleted or made unreachable.
 *
 * Architecture
 * ------------
 * It follows the established local-preference pattern in this codebase
 * (`lib/theme.ts` for a plain key, `lib/formatting.ts` for a richer store):
 *   - ONE localStorage key, everything else is derived;
 *   - a module-level store + subscribe/notify + `useSyncExternalStore`, so every
 *     consumer re-renders the moment the preference changes;
 *   - persisted values are SANITIZED on read and on write, so a stale key, a
 *     hand-edited value or a deleted category can never break the catalog.
 *
 * No backend table and no migration: this is presentation state, and the
 * documented architecture keeps such state on the client.
 */
import { useSyncExternalStore } from 'react'

export const CATEGORY_VISIBILITY_STORAGE_KEY = 'station.catalog.categoryVisibility.v1'

/**
 * How many categories the primary bar shows before the cashier configures
 * anything. Chosen to fit the 1280×800 minimum window (plus the "All" chip)
 * on one or two wrapped rows without horizontal scrolling.
 */
export const DEFAULT_VISIBLE_LIMIT = 6

/** `{ visible: null }` = never customized; `{ visible: number[] }` = pinned. */
export interface CategoryVisibilityPreference {
  visible: number[] | null
}

export const DEFAULT_CATEGORY_VISIBILITY: CategoryVisibilityPreference = { visible: null }

function isValidId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** Keep only usable ids, in order, without duplicates. */
export function sanitizeVisibleIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    return []
  }

  const seen = new Set<number>()
  const result: number[] = []
  for (const value of raw) {
    if (isValidId(value) && !seen.has(value)) {
      seen.add(value)
      result.push(value)
    }
  }
  return result
}

/** Parse persisted JSON into a preference; never throws. */
export function sanitizeCategoryVisibility(raw: unknown): CategoryVisibilityPreference {
  if (typeof raw !== 'object' || raw === null) {
    return { visible: null }
  }

  const visible = (raw as { visible?: unknown }).visible
  return visible === null || visible === undefined
    ? { visible: null }
    : { visible: sanitizeVisibleIds(visible) }
}

function loadInitial(): CategoryVisibilityPreference {
  try {
    const raw = localStorage.getItem(CATEGORY_VISIBILITY_STORAGE_KEY)
    if (!raw) return { visible: null }
    return sanitizeCategoryVisibility(JSON.parse(raw))
  } catch {
    return { visible: null }
  }
}

let current: CategoryVisibilityPreference = loadInitial()
const listeners = new Set<() => void>()

function persist() {
  try {
    localStorage.setItem(CATEGORY_VISIBILITY_STORAGE_KEY, JSON.stringify(current))
  } catch {
    /* storage blocked/full — the choice still applies for this session */
  }
}

function notify() {
  for (const listener of listeners) listener()
}

export function getCategoryVisibility(): CategoryVisibilityPreference {
  return current
}

export function subscribeCategoryVisibility(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reactive hook — re-renders the caller on every visibility change. */
export function useCategoryVisibility(): CategoryVisibilityPreference {
  return useSyncExternalStore(subscribeCategoryVisibility, getCategoryVisibility)
}

/**
 * Replace the pinned order wholesale. An empty list is a legitimate, saved
 * state ("I only use All"), which is why "never configured" is `null` and not
 * `[]`.
 */
export function setVisibleCategoryIds(ids: readonly number[]): void {
  current = { visible: sanitizeVisibleIds(ids) }
  persist()
  notify()
}

/**
 * Pure list transforms over the RESOLVED visible order.
 *
 * They take the ids currently in the bar and return the next list, so the
 * drawer can compose them with `resolveVisibleCategories` and write the result
 * through `setVisibleCategoryIds` once. Operating on the raw preference instead
 * would be wrong in the untouched default state, where the bar already shows
 * categories that have never been "pinned".
 */

/** Pin or unpin one category, keeping the rest of the order intact. */
export function toggleCategoryInList(ids: readonly number[], id: number): number[] {
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id]
}

/**
 * Move a category one step toward the start (-1) or the end (+1).
 * A move that would fall off either end is a no-op, never a wrap-around.
 */
export function moveCategoryInList(ids: readonly number[], id: number, offset: -1 | 1): number[] {
  const from = ids.indexOf(id)
  if (from < 0) {
    return [...ids]
  }

  const to = from + offset
  if (to < 0 || to >= ids.length) {
    return [...ids]
  }

  const next = [...ids]
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}

/** Back to the untouched default: the catalog's own order, capped. */
export function resetCategoryVisibility(): void {
  current = { visible: null }
  persist()
  notify()
}

/** Re-read from storage (used by tests to simulate an application restart). */
export function reloadCategoryVisibility(): CategoryVisibilityPreference {
  current = loadInitial()
  notify()
  return current
}

/**
 * The categories the primary bar should render, in display order.
 *
 * `all` is the full, already-ordered category list from the catalog. The result
 * never contains an id that is not in `all` (so a deleted category disappears
 * from the bar) and never drops a pinned id that still exists.
 *
 * Default behaviour
 * -----------------
 * Until the cashier customizes anything the preference is `null` — "never
 * configured" — so an existing installation behaves sensibly with zero setup:
 * the bar shows the FIRST categories in the catalog's own order, capped at
 * {@link DEFAULT_VISIBLE_LIMIT}, "All" stays available, and every other
 * category is still one tap away in the expanded bar. Once customized, the
 * saved order is authoritative and a category created later is hidden from the
 * bar until it is pinned (still fully usable via "Show All").
 */
export function resolveVisibleCategories<T extends { id: number }>(
  all: readonly T[],
  preference: CategoryVisibilityPreference,
): T[] {
  if (preference.visible === null) {
    return all.slice(0, DEFAULT_VISIBLE_LIMIT)
  }

  const byId = new Map(all.map((category) => [category.id, category]))
  return preference.visible
    .map((id) => byId.get(id))
    .filter((category): category is T => category !== undefined)
}
