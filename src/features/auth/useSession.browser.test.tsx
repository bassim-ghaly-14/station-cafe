/**
 * The Station session, exercised over the BROWSER transport.
 *
 * This is the flow a manager actually performs on a phone after scanning the QR:
 * the real Station login screen posts to the real `login` command, the returned
 * token is stored and reused, a revoked session drops back to the login screen,
 * and logging out clears it. It is the SAME `SessionProvider` the desktop uses —
 * only the transport differs.
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionProvider, useSession } from './useSession'
import { sessionToken } from './session'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const fetchMock = vi.fn()

const MANAGER = {
  id: 2,
  name: 'Manager',
  phone: null,
  role: 'MANAGER',
  status: 'ACTIVE',
  created_at: '',
  updated_at: '',
}

/** A login/gate probe: it shows the Station login screen whenever signed out. */
function Gate() {
  const { user, login, logout } = useSession()
  if (!user) {
    return (
      <button onClick={() => void login('manager', 'manager123')}>
        {user === null ? 'login' : 'loading'}
      </button>
    )
  }
  return (
    <div>
      <span data-testid="who">{user.name}</span>
      <button onClick={() => void logout()}>logout</button>
    </div>
  )
}

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}

beforeEach(() => {
  // Opt out of the desktop default so this suite drives the browser transport.
  delete window.__TAURI_INTERNALS__
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  invoke.mockReset()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Station session over the browser transport', () => {
  it('signs in through the real login command and stores the token', async () => {
    fetchMock.mockResolvedValue(reply(200, { token: 'browser-token', user: MANAGER }))

    render(
      <SessionProvider>
        <Gate />
      </SessionProvider>,
    )

    await screen.findByRole('button', { name: 'login' })
    await act(async () => screen.getByRole('button', { name: 'login' }).click())

    // The REAL login command, by name, over the LAN bridge.
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/cmd/login')
    expect(JSON.parse(init.body)).toEqual({
      input: { name: 'manager', password: 'manager123' },
    })
    // No credential in the address.
    expect(url).not.toContain('manager123')

    // The user reaches the real Station application, not a separate shell.
    await screen.findByTestId('who')
    expect(screen.getByTestId('who')).toHaveTextContent('Manager')
    expect(localStorage.getItem('station.session.token')).toBe('browser-token')
  })

  it('sends the stored token on subsequent calls', async () => {
    localStorage.setItem('station.session.token', 'browser-token')
    fetchMock.mockResolvedValue(reply(200, MANAGER))

    render(
      <SessionProvider>
        <Gate />
      </SessionProvider>,
    )

    await screen.findByTestId('who')
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer browser-token')
  })

  it('returns to the Station login screen when the session is revoked', async () => {
    localStorage.setItem('station.session.token', 'stale-token')
    fetchMock.mockResolvedValue(
      reply(401, { kind: 'unauthorized', message: 'auth.invalid_session' }),
    )

    render(
      <SessionProvider>
        <Gate />
      </SessionProvider>,
    )

    // A 401 must clear the token and land back on the login screen rather than
    // leaving a signed-in-looking app that fails on every action.
    await screen.findByRole('button', { name: 'login' })
    expect(sessionToken()).toBeNull()
  })

  it('keeps the session on a 403, because a role refusal is a real answer', async () => {
    localStorage.setItem('station.session.token', 'browser-token')
    fetchMock.mockResolvedValue(reply(200, MANAGER))
    fetchMock.mockResolvedValueOnce(reply(200, MANAGER))

    render(
      <SessionProvider>
        <Gate />
      </SessionProvider>,
    )
    await screen.findByTestId('who')

    // A subsequent command is refused for permissions, not for identity.
    fetchMock.mockResolvedValueOnce(reply(403, { kind: 'unauthorized', message: 'auth.forbidden' }))
    await act(async () => {
      await callForbidden()
    })

    // Still signed in: a 403 must never sign the user out.
    expect(screen.getByTestId('who')).toBeInTheDocument()
    expect(sessionToken()).toBe('browser-token')
  })

  it('logs out and clears the client session', async () => {
    localStorage.setItem('station.session.token', 'browser-token')
    fetchMock.mockResolvedValue(reply(200, MANAGER))

    render(
      <SessionProvider>
        <Gate />
      </SessionProvider>,
    )
    await screen.findByTestId('who')

    fetchMock.mockResolvedValueOnce(reply(200, null))
    await act(async () => screen.getByRole('button', { name: 'logout' }).click())

    await screen.findByRole('button', { name: 'login' })
    expect(sessionToken()).toBeNull()
    // Logout is a real command on the same surface, not a local-only clear.
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/v1/cmd/logout')
  })

  it('applies RTL for Arabic, the one shared translation source', async () => {
    await import('@/lib/i18n')
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'))
    expect(document.documentElement.lang).toBe('ar-EG')
  })
})

/** Trigger a command that the backend refuses for permissions. */
async function callForbidden() {
  const { call } = await import('@/services/ipc')
  await call('delete_category').catch(() => undefined)
}
