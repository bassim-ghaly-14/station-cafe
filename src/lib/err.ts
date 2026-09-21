/** Shared error-to-translation mapping used by every manager page. */
import type { TFunction } from 'i18next'

export function useErrText(t: TFunction): (e: unknown) => string {
  return (e: unknown) =>
    t([
      `errors.${(e as { message?: string }).message ?? 'internal_error'}`,
      'errors.internal_error',
    ])
}
