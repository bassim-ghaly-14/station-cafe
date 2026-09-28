/**
 * Lightweight app router — a desktop app with a fixed set of views; the
 * browser/webview URL is the source of truth for the current view.
 * Routes: view name → component.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export type View =
  | 'pos'
  | 'today-invoices'
  | 'customers'
  | 'employees'
  | 'catalog'
  | 'inventory'
  | 'expenses'
  | 'sales'
  | 'reports'
  | 'dev-settings'

interface RouterCtx {
  view: View
  params: Record<string, unknown>
  navigate: (view: View, params?: Record<string, unknown>) => void
}

const Ctx = createContext<RouterCtx | null>(null)

const VIEW_PATHS: Record<View, string> = {
  pos: '/pos',
  'today-invoices': '/pos/invoices',
  customers: '/customers',
  employees: '/employees',
  catalog: '/catalog',
  inventory: '/inventory',
  expenses: '/expenses',
  sales: '/sales',
  reports: '/reports',
  'dev-settings': '/dev-settings',
}

const PATH_VIEWS: Record<string, View> = Object.fromEntries(
  Object.entries(VIEW_PATHS).map(([view, path]) => [path, view as View]),
)

// Linear alternative to replacing a trailing-slash run: a regex like /\/+$/ can
// backtrack on long inputs that do not match, so trim from the end instead.
const trimTrailingSlashes = (pathname: string): string => {
  let end = pathname.length
  while (end > 0 && pathname[end - 1] === '/') end -= 1
  return end === pathname.length ? pathname : pathname.slice(0, end)
}

function readRoute() {
  const pathname = trimTrailingSlashes(window.location.pathname)
  const segments = pathname.split('/').filter(Boolean)
  const view = PATH_VIEWS[pathname] ?? PATH_VIEWS[`/${segments[0] ?? ''}`] ?? 'pos'
  return { view, params: segments.length > 1 ? { segments: segments.slice(1) } : {} }
}

export function RouterProvider({ children }: Readonly<{ readonly children: ReactNode }>) {
  const [route, setRoute] = useState(readRoute)

  useEffect(() => {
    const normalizeRoot = () => {
      if (window.location.pathname === '/') {
        window.history.replaceState(null, '', VIEW_PATHS.pos)
        setRoute({ view: 'pos', params: {} })
        return
      }
      setRoute(readRoute())
    }
    normalizeRoot()
    window.addEventListener('popstate', normalizeRoot)
    return () => window.removeEventListener('popstate', normalizeRoot)
  }, [])

  const navigate = useCallback((next: View, p?: Record<string, unknown>) => {
    window.history.pushState(null, '', VIEW_PATHS[next])
    setRoute({ view: next, params: p ?? {} })
  }, [])

  const value = useMemo(
    () => ({ view: route.view, params: route.params, navigate }),
    [route, navigate],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useRouter(): RouterCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useRouter must be used inside RouterProvider')
  return ctx
}
