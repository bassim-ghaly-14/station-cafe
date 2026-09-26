/**
 * Root: db bridge check → SessionProvider → Login / AppShell + routed views.
 */
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { Logo } from '@/components/branding/Logo'
import { BootLoadingIndicator, ErrorState } from '@/components/states'
import {
  BOOT_EXIT_DURATION_MS,
  BOOT_EXIT_REDUCED_MS,
  bootStartedAt,
  useMinimumBootDelayElapsed,
} from '@/app/boot'
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
import { TodayInvoicesPage } from '@/features/pos/TodayInvoicesPage'

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
    case 'pos':
      return <PosPage />
    case 'today-invoices':
      return <TodayInvoicesPage />
    default:
      return <PosPage />
  }
}

/**
 * Branded startup screen. The only visible copy is the Station brand statement
 * (`boot.statement`) — it is marketing, not a loading-status description; the
 * progress bar and `role="status"` carry the loading meaning. Initialization,
 * timing and the exit transition are unchanged.
 */
function BootScreen({ exiting }: { exiting?: boolean }) {
  const { t } = useTranslation()
  return (
    <main
      dir="rtl"
      aria-hidden={exiting || undefined}
      className={
        'boot-screen-overlay flex h-screen flex-col items-center justify-center gap-8 overflow-hidden bg-background px-6' +
        (exiting ? ' boot-screen-exit' : '')
      }
    >
      <div className="boot-screen-logo boot-logo-enter relative flex items-center justify-center">
        <div aria-hidden="true" className="boot-logo-halo" />
        {/* Intrinsic 88px pins aspect ratio; rendered size resolves from
            --logo-size (~3–3.5×, responsive clamp) defined in index.css. */}
        <Logo size={88} className="boot-logo-breathe" />
      </div>
      <BootLoadingIndicator statement={t('boot.statement')} />
    </main>
  )
}

/** Session/auth gate. Mounted only after the db bridge is up. */
function SessionGate({ onReady }: { onReady: (ready: boolean) => void }) {
  const { user, loading } = useSession()
  const ready = !loading
  useEffect(() => {
    onReady(ready)
  }, [ready, onReady])
  if (loading) return null
  if (!user) return <LoginPage />
  return (
    <RouterProvider>
      <AppShell>
        <RoutedViews />
      </AppShell>
    </RouterProvider>
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
  // Boot epoch: bumped on db retry so the 3s minimum replays for the new
  // lifecycle (a fresh boot experience, never a flash).
  const [bootEpoch, setBootEpoch] = useState(bootStartedAt)
  // Real initialization readiness: db bridge up. Session readiness is then
  // reported by SessionGate (mounted only once dbOk is true).
  const [sessionReady, setSessionReady] = useState(false)
  // Single boot clock shared by both phases (see src/app/boot.ts).
  const minDurationElapsed = useMinimumBootDelayElapsed(bootEpoch)
  // Exit sequencing: exiting (450ms fade) → exited (overlay unmounted).
  const [exiting, setExiting] = useState(false)
  const [exited, setExited] = useState(false)
  // Stable callback for the gate (declared before any early return: hooks
  // must run unconditionally in the same order on every render).
  const handleSessionReady = useCallback((ready: boolean) => {
    setSessionReady(ready)
  }, [])

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

  // Boot may exit only when BOTH hold: real init ready AND 3s minimum met.
  // Readiness is never faked — dbOk/sessionReady come from the real
  // db_status + useSession flows; the timer only adds the minimum delay.
  // `dbOk === false` (real failure) also counts as settled so the error
  // screen exits the same seamless way after the minimum.
  const initializationReady = dbOk === true && sessionReady
  const bootSettled = initializationReady || dbOk === false
  const canExit = bootSettled && minDurationElapsed

  useEffect(() => {
    if (!canExit || exiting) return
    setExiting(true)
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const id = window.setTimeout(
      () => setExited(true),
      reduced ? BOOT_EXIT_REDUCED_MS : BOOT_EXIT_DURATION_MS,
    )
    return () => window.clearTimeout(id)
  }, [canExit, exiting])

  // Retry from the error screen re-enters the boot lifecycle: reset so the
  // branded experience (and its 3s minimum) replays instead of flashing.
  function retryDb() {
    setDbOk(inTauri ? null : false)
    setSessionReady(false)
    setExiting(false)
    setExited(false)
    setBootEpoch(Date.now())
    setTick((x) => x + 1)
  }

  if (!dbOk) {
    // dbOk === null (still checking) keeps the boot brand on screen;
    // dbOk === false surfaces the real error — but only after the 3s
    // minimum, revealed by the same exit fade (never a flash or blank).
    const showError = dbOk === false && exited
    return (
      <>
        {showError ? (
          <main
            dir="rtl"
            className="flex h-screen flex-col items-center justify-center gap-6 bg-background"
          >
            <Logo size={88} />
            <ErrorState
              message={t(inTauri ? 'errors.internal_error' : 'errors.tauri_required')}
              onRetry={retryDb}
              retryLabel={t('app.retry')}
            />
          </main>
        ) : null}
        {!exited ? <BootScreen exiting={exiting} /> : null}
      </>
    )
  }

  // Auth/session states mount UNDER the boot overlay: the app is fully
  // rendered (LoginPage or AppShell) before the overlay fades, so there is
  // never a blank/flash frame between boot and content.
  return (
    <ToastProvider>
      <SessionProvider>
        <SessionGate onReady={handleSessionReady} />
      </SessionProvider>
      {!exited ? <BootScreen exiting={exiting} /> : null}
    </ToastProvider>
  )
}
