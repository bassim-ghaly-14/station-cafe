/**
 * The BROWSER transport contract.
 *
 * Station's phone experience is the same application as the desktop, reaching
 * the same Rust commands over the LAN listener instead of over Tauri IPC. These
 * tests pin the parts of that path which are security- or correctness-critical:
 *
 * - the token travels in the `Authorization` header and NOWHERE else — never in
 *   the URL, never in the query string, never in the body;
 * - a 401 is reported as a session loss (so the app returns to the Station
 *   login screen) while a 403 stays a real authorization refusal;
 * - a network failure is reported as a transport failure, not as a business
 *   error;
 * - the command name and argument payload match what the IPC layer sends, so a
 *   page cannot behave differently depending on where it runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, callPublic, isDesktop, onUnauthorized } from './ipc'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}))
vi.mock('@/features/auth/session', () => ({ sessionToken: () => 'test-token' }))

const fetchMock = vi.fn()

/** Build a minimal Response-like object for the transport to consume. */
function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
}

beforeEach(() => {
  // Opt this suite out of the desktop default declared in src/test/setup.ts.
  delete window.__TAURI_INTERNALS__
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browser transport', () => {
  it('reports that it is not the desktop shell', () => {
    expect(isDesktop()).toBe(false)
  })

  it('never uses the Tauri IPC bridge in a browser', async () => {
    fetchMock.mockResolvedValue(reply(200, []))
    await call('list_categories')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('addresses the command on the same origin and nothing else', async () => {
    fetchMock.mockResolvedValue(reply(200, []))
    await call('list_categories')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/cmd/list_categories')
    expect(init.method).toBe('POST')
  })

  it('sends the token in the Authorization header and never in the URL', async () => {
    fetchMock.mockResolvedValue(reply(200, []))
    await call('list_categories')
    const [url, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer test-token')
    // The structural guarantee: no credential can appear in an address, a
    // history entry, a proxy log or a screenshot of the address bar.
    expect(url).not.toContain('test-token')
    expect(url).not.toContain('?')
    expect(JSON.stringify(init.body)).not.toContain('test-token')
  })

  it('sends no token at all before login', async () => {
    fetchMock.mockResolvedValue(reply(200, { token: 't', user: {} }))
    await callPublic('login', { input: { name: 'manager' } })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBeUndefined()
    expect(JSON.stringify(init.body)).not.toContain('token')
  })

  it('sends the same argument payload the IPC layer would send', async () => {
    fetchMock.mockResolvedValue(reply(200, []))
    // The body must carry arguments ONLY. The token is the header's job.
    await call('list_products', { department: 'CAFE', active_only: false })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      department: 'CAFE',
      active_only: false,
    })
  })

  it('returns the command result unchanged', async () => {
    const rows = [{ id: 1, name: 'Cafe' }]
    fetchMock.mockResolvedValue(reply(200, rows))
    await expect(call('list_categories')).resolves.toEqual(rows)
  })

  it('raises a session loss on 401 so the app returns to login', async () => {
    const listener = vi.fn()
    const unsubscribe = onUnauthorized(listener)
    fetchMock.mockResolvedValue(
      reply(401, { kind: 'unauthorized', message: 'auth.session_expired' }),
    )
    await expect(call('me')).rejects.toMatchObject({ message: 'auth.session_expired' })
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('does NOT treat a 403 as a session loss', async () => {
    const listener = vi.fn()
    const unsubscribe = onUnauthorized(listener)
    fetchMock.mockResolvedValue(reply(403, { kind: 'unauthorized', message: 'auth.forbidden' }))
    // A role refusal is a real answer about this user. Clearing the session
    // here would bounce a manager out of the app instead of showing them why.
    await expect(call('delete_category')).rejects.toMatchObject({ message: 'auth.forbidden' })
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('reports an unreachable Station as a transport failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(call('me')).rejects.toMatchObject({ message: 'network.unreachable' })
  })

  it('survives an empty error body without throwing a parse error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => '',
    })
    await expect(call('me')).rejects.toMatchObject({ message: 'internal_error' })
  })
})
