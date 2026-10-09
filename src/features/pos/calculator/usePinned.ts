/**
 * A persisted PIN preference — the same primitive the app-wide Sidebar uses.
 *
 * The distinction this file enforces, exactly as the Sidebar models it:
 *   - PIN is a durable USER PREFERENCE ("keep this panel always-on") and is the
 *     only thing persisted here, to `localStorage`, under a single key.
 *   - VISIBILITY is transient and is deliberately NOT persisted. Opening or
 *     closing the panel never touches storage; a reload starts closed unless the
 *     caller explicitly re-opens it.
 *
 * Because the store is module-level (not component state) the pinned preference
 * is shared and survives the panel unmounting/remounting, and multiple callers
 * keyed by the same `key` observe one value. Reactivity is through
 * `useSyncExternalStore`, matching the app's other preference stores.
 */

import { useCallback, useSyncExternalStore } from 'react'

type Listener = () => void

/** One module-level subscription set per key, so unrelated panels never share state. */
const stores = new Map<string, { value: boolean; listeners: Set<Listener> }>()

function storeFor(key: string) {
  let store = stores.get(key)
  if (!store) {
    store = { value: readStored(key), listeners: new Set() }
    stores.set(key, store)
  }
  return store
}

function storageKey(key: string): string {
  return `station.pinned.${key}`
}

/** Read the persisted pin, defaulting to unpinned on any error or bad value. */
function readStored(key: string): boolean {
  try {
    return window.localStorage.getItem(storageKey(key)) === 'true'
  } catch {
    return false
  }
}

function subscribe(key: string) {
  return (onChange: Listener): (() => void) => {
    const store = storeFor(key)
    store.listeners.add(onChange)
    return () => {
      store.listeners.delete(onChange)
    }
  }
}

function getSnapshot(key: string) {
  return () => storeFor(key).value
}

function write(key: string, next: boolean) {
  const store = storeFor(key)
  if (store.value === next) return
  store.value = next
  try {
    window.localStorage.setItem(storageKey(key), String(next))
  } catch {
    // Persistence is best-effort; the in-memory preference still applies.
  }
  for (const listener of store.listeners) listener()
}

/**
 * Reset the in-memory pin cache for one key, or every key when omitted.
 *
 * The store caches its value in a module-level Map so a preference survives a
 * panel unmounting/remounting, which is the whole point. That same cache would
 * otherwise leak one suite's pin into the next, so tests clear it the same way
 * `resetFormattingPreferences` clears the formatting store. Clearing drops the
 * cached entry; the next `storeFor` re-reads it from localStorage.
 */
export function resetPinned(key?: string): void {
  if (key === undefined) stores.clear()
  else stores.delete(key)
}

/**
 * The pinned state of a named UI element plus a stable setter.
 *
 * Mirrors the Sidebar's pinning contract: only the preference is durable, and
 * callers pair it with their own transient visibility state.
 */
export function usePinned(key: string): readonly [boolean, (next: boolean) => void] {
  const subscribeToKey = useCallback((onChange: Listener) => subscribe(key)(onChange), [key])
  const readSnapshot = useCallback(() => getSnapshot(key)(), [key])
  const pinned = useSyncExternalStore(subscribeToKey, readSnapshot, () => false)
  const setPinned = useCallback((next: boolean) => write(key, next), [key])
  return [pinned, setPinned]
}
