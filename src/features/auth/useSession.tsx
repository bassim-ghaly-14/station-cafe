/** Session context: current user + login/logout actions. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { call, callPublic } from '@/services/ipc'
import type { UserRole } from '@/lib/roles'
import { sessionToken, setSessionToken } from './session'

export interface User {
  id: number
  name: string
  phone: string | null
  role: UserRole
  status: string
  created_at: string
  updated_at: string
}

interface SessionCtx {
  user: User | null
  loading: boolean
  login: (name: string, password: string) => Promise<void>
  logout: () => Promise<void>
  clearSessionToken: () => void
  clearLocalSession: () => void
}

const Ctx = createContext<SessionCtx | null>(null)

interface LoginResponse {
  token: string
  user: User
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const token = sessionToken()
    if (!token) {
      setLoading(false)
      return
    }
    call<User>('me')
      .then((u) => !cancelled && setUser(u))
      .catch(() => !cancelled && setSessionToken(null))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (name: string, password: string) => {
    const res = await callPublic<LoginResponse>('login', { input: { name, password } })
    setSessionToken(res.token)
    setUser(res.user)
  }, [])

  const logout = useCallback(async () => {
    try {
      await call<void>('logout')
    } finally {
      setSessionToken(null)
      setUser(null)
    }
  }, [])

  const clearSessionToken = useCallback(() => {
    setSessionToken(null)
  }, [])

  const clearLocalSession = useCallback(() => {
    setSessionToken(null)
    setUser(null)
  }, [])

  const value = useMemo(
    () => ({ user, loading, login, logout, clearSessionToken, clearLocalSession }),
    [user, loading, login, logout, clearSessionToken, clearLocalSession],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSession(): SessionCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useSession must be used inside SessionProvider')
  return ctx
}

/** Role helpers — UI convenience only; the backend is the real gate. */
export function atLeast(role: UserRole | undefined, min: UserRole): boolean {
  const rank = (r: string | undefined) =>
    r === 'ADMIN' ? 3 : r === 'MANAGER' ? 2 : r === 'STAFF' ? 1 : 0
  return rank(role) >= rank(min)
}
