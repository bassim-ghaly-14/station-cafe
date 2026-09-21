/**
 * Root: db bridge check → SessionProvider → Login / AppShell + routed views.
 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { Logo } from '@/components/branding/LogoPlaceholder'
import { LoadingState, ErrorState } from '@/components/states'
import { ToastProvider } from '@/components/ui'
import { SessionProvider, useSession } from '@/features/auth/useSession'
import LoginPage from '@/features/auth/LoginPage'
import AppShell from '@/app/AppShell'
import { RouterProvider, useRouter } from '@/app/router'
import StaffPage from '@/features/staff/StaffPage'
import PosPage from '@/features/pos/PosPage'

interface DbStatus {
  ok: boolean
  schema_version: number
}

function RoutedViews() {
  const { view } = useRouter()
  switch (view) {
    case 'staff':
      return <StaffPage />
    case 'pos':
    default:
      return <PosPage />
  }
}

function Authed() {
  const { user, loading } = useSession()
  if (loading) return <BootScreen />
  if (!user) return <LoginPage />
  return (
    <RouterProvider>
      <AppShell>
        <RoutedViews />
      </AppShell>
    </RouterProvider>
  )
}

function BootScreen() {
  const { t } = useTranslation()
  return (
    <main dir="rtl" className="flex h-screen flex-col items-center justify-center gap-6 bg-surface">
      <Logo size={88} />
      <LoadingState label={t('app.loading')} />
    </main>
  )
}

export default function App() {
  const { t } = useTranslation()
  const [dbOk, setDbOk] = useState<boolean | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    invoke<DbStatus>('db_status')
      .then(() => !cancelled && setDbOk(true))
      .catch(() => !cancelled && setDbOk(false))
    return () => {
      cancelled = true
    }
  }, [tick])

  if (dbOk === null) return <BootScreen />
  if (!dbOk) {
    return (
      <main
        dir="rtl"
        className="flex h-screen flex-col items-center justify-center gap-6 bg-surface"
      >
        <Logo size={88} />
        <ErrorState
          message={t('errors.internal_error')}
          onRetry={() => setTick((x) => x + 1)}
          retryLabel={t('app.retry')}
        />
      </main>
    )
  }

  return (
    <ToastProvider>
      <SessionProvider>
        <Authed />
      </SessionProvider>
    </ToastProvider>
  )
}
