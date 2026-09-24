/**
 * Lightweight app router — a desktop app with a fixed set of views; a
 * hash-free state router keeps the dependency set minimal and RTL control
 * simple. Routes: view name → component.
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export type View =
  | 'pos'
  | 'dashboard'
  | 'staff'
  | 'catalog'
  | 'customers'
  | 'inventory'
  | 'expenses'
  | 'reports'
  | 'audit'
  | 'settings'
  | 'dev-settings'

interface RouterCtx {
  view: View
  params: Record<string, unknown>
  navigate: (view: View, params?: Record<string, unknown>) => void
}

const Ctx = createContext<RouterCtx | null>(null)

export function RouterProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>('pos')
  const [params, setParams] = useState<Record<string, unknown>>({})

  const navigate = useCallback((next: View, p?: Record<string, unknown>) => {
    setView(next)
    setParams(p ?? {})
  }, [])

  const value = useMemo(() => ({ view, params, navigate }), [view, params, navigate])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useRouter(): RouterCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useRouter must be used inside RouterProvider')
  return ctx
}
