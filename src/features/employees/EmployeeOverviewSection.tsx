/**
 * The employees analytics band, mounted only for a role that may have it.
 *
 * A failed band read is REPORTED rather than hidden behind an empty set of
 * figures: a manager cannot tell "no employees yet" from "the numbers did not
 * load" if both render as zeroes, and only one of them is fixed by waiting.
 * Once a band has been read, a later refresh failure keeps showing the last
 * real figures rather than replacing them with an error.
 */
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/states'
import type { EmployeeOverview } from '@/services/employeesApi'

import { EmployeeKpiBand } from './EmployeeKpiBand'

export function EmployeeOverviewSection({
  visible,
  error,
  onRetry,
  overview,
  loading,
}: {
  readonly visible: boolean
  readonly error: string | null
  readonly onRetry: () => void
  readonly overview: EmployeeOverview | null
  readonly loading: boolean
}) {
  const { t } = useTranslation()

  if (!visible) {
    return null
  }

  if (error && !overview) {
    return <ErrorState message={error} onRetry={onRetry} retryLabel={t('app.retry')} />
  }

  return <EmployeeKpiBand overview={overview} loading={loading} />
}
