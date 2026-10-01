/**
 * The monthly TARGET progress — ONE read, independent of the page filter.
 *
 * WHY A SEPARATE HOOK from `useSalesData`: the page's date picker scopes what
 * happened in an arbitrary range; a monthly target is a statement about THE
 * MONTH BEING TRADED IN. Slicing the target progress by the picker would make a
 * "monthly achievement" out of three selected days, which is not a number the
 * owner configured anything for.
 *
 * So this is fetched from its own command — which accepts no filter at all — and
 * re-read on the same explicit refresh the rest of the page uses, so a new sale
 * updates the figures together with the invoice list rather than on a timer.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrText } from '@/lib/err'
import { salesApi, type MonthlyTargetProgress } from '@/services/salesApi'

export type TargetProgressState = {
  progress: MonthlyTargetProgress | null
  initialLoading: boolean
  refreshing: boolean
  error: string | null
  reload: () => void
}

export function useTargetProgress(revision = 0): TargetProgressState {
  const { t } = useTranslation()
  const errText = useErrText(t)
  const [progress, setProgress] = useState<MonthlyTargetProgress | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [localRevision, setLocalRevision] = useState(0)

  useEffect(() => {
    let active = true
    // oxlint-disable-next-line react/set-state-in-effect -- external async read.
    setLoading(true)
    salesApi
      .targetProgress()
      .then((response) => {
        if (!active) return
        setProgress(response)
        setError(null)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(errText(cause))
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [revision, localRevision, errText])

  const reload = useCallback(() => setLocalRevision((value) => value + 1), [])
  const hasProgress = progress !== null
  return {
    progress,
    initialLoading: loading && !hasProgress,
    refreshing: loading && hasProgress,
    error,
    reload,
  }
}
