/**
 * Session token storage — module-level singleton kept deliberately tiny.
 * The token lives in localStorage (offline desktop app); the backend remains
 * the security boundary and revokes/validates every token server-side.
 */
const KEY = 'station.session.token'

export function sessionToken(): string | null {
  return localStorage.getItem(KEY)
}

export function setSessionToken(token: string | null): void {
  if (token) {
    localStorage.setItem(KEY, token)
  } else {
    localStorage.removeItem(KEY)
  }
}
