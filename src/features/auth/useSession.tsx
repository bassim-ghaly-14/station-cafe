/** Session context: current user + login/logout actions. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { call, callPublic, onUnauthorized } from '@/services/ipc'
import { roleRank, type UserRole } from '@/lib/roles'
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

export function SessionProvider({ children }: Readonly<{ readonly children: ReactNode }>) {
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

  /**
   * A 401 from ANY command drops the session.
   *
   * Without this, a phone whose session was revoked mid-session would keep
   * rendering the last successful page and fail silently on every action. The
   * user is returned to the Station login screen, which is the same screen the
   * desktop shows. A 403 is NOT routed here: a role refusal is a real answer
   * and must stay visible on the page.
   */
  useEffect(
    () =>
      onUnauthorized(() => {
        setSessionToken(null)
        setUser(null)
      }),
    [],
  )

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

/**
 * The session, or `null` when there is no provider.
 *
 * For screens that must render a SAFE default before/without a resolved session
 * — role-gated presentation, for instance — where throwing would take the whole
 * page down over a missing context. Anything that genuinely requires a session
 * must keep using {@link useSession}, which still fails loudly.
 */
export function useOptionalSession(): SessionCtx | null {
  return useContext(Ctx)
}

/** Role helpers — UI convenience only; the backend is the real gate. */
export function atLeast(role: UserRole | undefined, min: UserRole): boolean {
  return roleRank(role) >= roleRank(min)
}
