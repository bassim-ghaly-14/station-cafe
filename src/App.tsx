import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { LogoPlaceholder } from '@/components/branding/LogoPlaceholder'
import { LoadingState, ErrorState } from '@/components/states'

interface DbStatus {
  ok: boolean
  schema_version: number
}

/**
 * Foundation shell. Real layout/routing arrives in Phase 1.
 * Verifies the backend/database bridge during startup.
 */
export default function App() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<DbStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setStatus(null)
    setError(null)
    invoke<DbStatus>('db_status')
      .then((s) => !cancelled && setStatus(s))
      .catch((e) => !cancelled && setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [tick])

  return (
    <main
      dir="rtl"
      className="flex h-screen flex-col items-center justify-center gap-6 bg-surface text-brand-950"
    >
      <LogoPlaceholder />
      <h1 className="text-3xl font-bold">{t('app.name')}</h1>
      {error ? (
        <ErrorState
          message={error}
          onRetry={() => setTick((x) => x + 1)}
          retryLabel={t('app.retry')}
        />
      ) : status ? (
        <p className="text-brand-700">
          {t('app.dbReady')} — schema v{status.schema_version}
        </p>
      ) : (
        <LoadingState label={t('app.loading')} />
      )}
    </main>
  )
}
