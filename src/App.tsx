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
import CatalogPage from '@/features/catalog/CatalogPage'
import ExpensesPage from '@/features/expenses/ExpensesPage'
import InventoryPage from '@/features/inventory/InventoryPage'
import ReportsPage from '@/features/reports/ReportsPage'
import DevSettingsPage from '@/features/dev/DevSettingsPage'

interface DbStatus {
  ok: boolean
  schema_version: number
}

function RoutedViews() {
  const { view } = useRouter()
  switch (view) {
    case 'staff':
      return <StaffPage />
    case 'catalog':
      return <CatalogPage />
    case 'expenses':
      return <ExpensesPage />
    case 'inventory':
      return <InventoryPage />
    case 'reports':
      return <ReportsPage />
    case 'dev-settings':
      return <DevSettingsPage />
    case 'audit':
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
    <main
      dir="rtl"
      className="flex h-screen flex-col items-center justify-center gap-6 bg-background"
    >
      <Logo size={88} />
      <LoadingState label={t('app.loading')} />
    </main>
  )
}

export default function App() {
  const { t } = useTranslation()
  // The app is a Tauri desktop application: the backend (SQLite, commands)
  // only exists inside the Tauri shell. When opened from a plain browser
  // (e.g. bare `pnpm dev`), there is no IPC runtime and db_status can never
  // succeed — surface that explicitly instead of a generic error.
  const inTauri = '__TAURI_INTERNALS__' in window
  const [dbOk, setDbOk] = useState<boolean | null>(inTauri ? null : false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!inTauri) return
    let cancelled = false
    invoke<DbStatus>('db_status')
      .then(() => !cancelled && setDbOk(true))
      .catch(() => !cancelled && setDbOk(false))
    return () => {
      cancelled = true
    }
  }, [inTauri, tick])

  if (dbOk === null) return <BootScreen />
  if (!dbOk) {
    return (
      <main
        dir="rtl"
        className="flex h-screen flex-col items-center justify-center gap-6 bg-background"
      >
        <Logo size={88} />
        <ErrorState
          message={t(inTauri ? 'errors.internal_error' : 'errors.tauri_required')}
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
