/** Shared error-to-translation mapping used by every manager page. */
import type { TFunction } from 'i18next'
import { useCallback } from 'react'

export function useErrText(t: TFunction): (e: unknown) => string {
  // Stable identity: pages put this callback in `useCallback`/effect deps of
  // their data loaders; a fresh closure each render would retrigger loads.
  return useCallback(
    (e: unknown) =>
      t([
        `errors.${(e as { message?: string }).message ?? 'internal_error'}`,
        'errors.internal_error',
      ]),
    [t],
  )
}
