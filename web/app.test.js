/**
 * Tests for the LOCAL WEB browser app.
 *
 * These drive the real modules that ship to the phone, in jsdom, with a fake
 * `fetch`. Nothing about the API is mocked below the network boundary: the
 * tests assert on the URL, the method and the `Authorization` header the app
 * actually produces, because those three things ARE the contract with the Rust
 * server.
 *
 * The whole point of the surface is the path
 *   QR → browser → login → dashboard,
 * so that is the path these tests walk, plus the failure branches a manager on
 * a café Wi-Fi will actually hit.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, StationApi, isForbidden, isUnauthorized } from './assets/api.js'
import { LocalWebApp } from './assets/ui.js'
import { LOCAL_STRINGS, Strings, loadStrings } from './assets/strings.js'
import ar from '../src/locales/ar/translations.json'

/** A token shaped exactly like the one `services::auth` issues. */
const TOKEN = 'a'.repeat(48)

/**
 * A `fetch` stand-in that records every call and replies from a route table.
 *
 * @param {Record<string, { status?: number, body?: unknown }>} routes
 */
function fakeFetch(routes) {
  const calls = []
  const impl = vi.fn(async (url, init = {}) => {
    calls.push({ url, init })
    const route = routes[url]
    if (!route) {
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Not found' } })
    }
    return jsonResponse(route.status ?? 200, route.body ?? null)
  })
  impl.calls = calls
  return impl
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

/** A mount point plus an app wired to a fake server. */
async function mount(routes) {
  const root = document.createElement('div')
  document.body.replaceChildren(root)
  const fetchImpl = fakeFetch({ '/assets/ar.json': { body: ar }, ...routes })
  const api = new StationApi({ fetchImpl })
  const app = new LocalWebApp({ root, api })
  await app.start()
  return { app, root, fetchImpl }
}

/** Fill the form and submit it, the way a tap on the button would. */
async function submit(root, name, password) {
  root.querySelector('#login-name').value = name
  root.querySelector('#login-password').value = password
  root.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flush()
}

/** Let every already-resolved promise settle. */
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function readFile(relative) {
  const { readFile: fsReadFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  return fsReadFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

beforeEach(() => {
  document.body.replaceChildren()
  sessionStorage.clear()
  localStorage.clear()
})

// ---- i18n -----------------------------------------------------------------

describe('the local web surface shares the desktop locale', () => {
  it('resolves every key it renders from the real translations file', () => {
    // The app fetches src/locales/ar/translations.json, so a wording change on
    // the desktop reaches the phone. A key this surface needs but the desktop
    // lacks must fail here rather than show "?? something" on a phone.
    const strings = new Strings(ar)
    const needed = [
      'app.name',
      'auth.name',
      'auth.password',
      'auth.signIn',
      'auth.signingIn',
      'auth.logout',
      'auth.currentSession',
      'auth.nameRequired',
      'auth.passwordRequired',
      'errors.internal_error',
      'errors.auth.bad_credentials',
      'errors.auth.session_expired',
      'roles.ADMIN',
      'roles.MANAGER',
      'roles.STAFF',
    ]
    for (const key of needed) {
      expect(strings.flat[key], `missing ${key}`).toBeTypeOf('string')
      expect(strings.flat[key]).not.toContain('??')
    }
  })

  it('has an Arabic string for every local-only key it renders', () => {
    // `local.title` is the product name "Station Local" and is deliberately in
    // Latin script; every other local string must be Arabic.
    for (const [key, value] of Object.entries(LOCAL_STRINGS)) {
      if (key === 'local.title') {
        expect(value).toBe('Station Local')
        continue
      }
      expect(value, key).toMatch(/[؀-ۿ]/)
    }
  })

  it('loads the locale from this origin, never a CDN', async () => {
    const fetchImpl = fakeFetch({ '/assets/ar.json': { body: ar } })
    const strings = await loadStrings({ fetchImpl })
    expect(fetchImpl.calls[0].url).toBe('/assets/ar.json')
    expect(strings.t('auth.signIn')).toBe('تسجيل الدخول')
  })
})

// ---- login ----------------------------------------------------------------

describe('the login screen', () => {
  it('renders the Arabic login form as the first screen', async () => {
    const { root } = await mount({})
    expect(root.querySelector('form')).not.toBeNull()
    expect(root.querySelector('#login-name')).not.toBeNull()
    expect(root.querySelector('#login-password')).not.toBeNull()
    // The button carries the product's own wording, not a generic "Submit".
    expect(root.querySelector('#login-submit').textContent).toBe('تسجيل الدخول')
    expect(root.textContent).toContain('اسم المستخدم')
    expect(root.textContent).toContain('كلمة المرور')
  })

  it('never uses a browser alert for a failure', async () => {
    const alertSpy = vi.fn()
    globalThis.alert = alertSpy
    const { root } = await mount({
      '/api/v1/auth/login': { status: 401, body: { error: { code: 'UNAUTHORIZED' } } },
    })
    await submit(root, 'manager', 'wrong')
    expect(alertSpy).not.toHaveBeenCalled()
    // The failure is inline, in Arabic, and announced to a screen reader.
    const message = root.querySelector('[role="alert"]')
    expect(message).not.toBeNull()
    expect(message.textContent).toContain('اسم المستخدم أو كلمة المرور غير صحيحة')
  })

  it('reports a missing field inline without calling the server', async () => {
    const { root, fetchImpl } = await mount({})
    await submit(root, '', 'secret')
    expect(fetchImpl.calls.filter((c) => c.url.includes('auth/login'))).toHaveLength(0)
    expect(root.querySelector('[role="alert"]').textContent).toContain('اسم المستخدم')
  })

  it('reaches the dashboard on a successful login', async () => {
    const { app, root } = await mount({
      '/api/v1/auth/login': {
        body: { token: TOKEN, user: { id: 1, name: 'مدير', role: 'MANAGER' } },
      },
      '/api/v1/manager/summary': { body: { open_day: true } },
    })
    await submit(root, 'manager', 'manager123')
    expect(app.state).toBe('dashboard')
    expect(root.querySelector('form')).toBeNull()
  })

  it('sends credentials in the body, never in the URL', async () => {
    const { root, fetchImpl } = await mount({
      '/api/v1/auth/login': {
        body: { token: TOKEN, user: { id: 1, name: 'م', role: 'MANAGER' } },
      },
      '/api/v1/manager/summary': { body: { open_day: false } },
    })
    await submit(root, 'manager', 'manager123')
    const login = fetchImpl.calls.find((c) => c.url === '/api/v1/auth/login')
    expect(login.url).toBe('/api/v1/auth/login')
    // The password travels in the JSON body; the address bar never sees it.
    expect(login.url).not.toContain('manager123')
    expect(JSON.parse(login.init.body)).toEqual({ name: 'manager', password: 'manager123' })
  })
})

// ---- dashboard ------------------------------------------------------------

describe('the authenticated dashboard', () => {
  const managerRoutes = {
    '/api/v1/auth/login': {
      body: { token: TOKEN, user: { id: 1, name: 'مدير الكافيه', role: 'MANAGER' } },
    },
    '/api/v1/manager/summary': {
      body: { user: { id: 1, name: 'مدير الكافيه', role: 'MANAGER' }, open_day: true },
    },
  }

  it('shows the authenticated user and their role', async () => {
    const { root } = await mount(managerRoutes)
    await submit(root, 'manager', 'manager123')
    expect(root.textContent).toContain('مدير الكافيه')
    // The role is rendered in Arabic, from the server's own value.
    expect(root.textContent).toContain('مدير')
    expect(root.querySelector('[data-testid="connection"]')).not.toBeNull()
  })

  it("shows today's manager summary when the server authorizes it", async () => {
    const { root, fetchImpl } = await mount(managerRoutes)
    await submit(root, 'manager', 'manager123')
    await flush()
    expect(fetchImpl.calls.some((c) => c.url === '/api/v1/manager/summary')).toBe(true)
    expect(root.querySelector('[data-testid="manager-summary"]').textContent).toContain('مفتوح')
  })

  it('sends the session as a bearer header and never in the URL', async () => {
    const { root, fetchImpl } = await mount(managerRoutes)
    await submit(root, 'manager', 'manager123')
    await flush()
    const call = fetchImpl.calls.find((c) => c.url === '/api/v1/manager/summary')
    expect(call.init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(call.url).not.toContain(TOKEN)
    expect(call.url).not.toContain('?')
  })

  it('handles 403 as a role refusal and shows no figure', async () => {
    // The server refuses; the UI must not invent data, and must not pretend
    // the café had no sales.
    const { app, root } = await mount({
      '/api/v1/auth/login': {
        body: { token: TOKEN, user: { id: 2, name: 'كاشير', role: 'STAFF' } },
      },
      '/api/v1/manager/summary': { status: 403, body: { error: { code: 'FORBIDDEN' } } },
    })
    await submit(root, 'cashier', 'cashier123')
    await flush()
    expect(app.state).toBe('dashboard')
    const summary = root.querySelector('[data-testid="manager-summary"]')
    expect(summary.textContent).toContain('هذا الملخص متاح للمدير فقط')
    expect(summary.textContent).not.toContain('مفتوح')
    // The user still sees who they are.
    expect(root.textContent).toContain('كاشير')
  })

  it('returns to login on 401 from a protected call', async () => {
    // A session that expires mid-use must land the user back on the form.
    const { app, root } = await mount({
      '/api/v1/auth/login': {
        body: { token: TOKEN, user: { id: 1, name: 'مدير', role: 'MANAGER' } },
      },
      '/api/v1/manager/summary': { status: 401, body: { error: { code: 'UNAUTHORIZED' } } },
    })
    await submit(root, 'manager', 'manager123')
    await flush()
    expect(app.state).toBe('login')
    expect(root.querySelector('form')).not.toBeNull()
    expect(root.querySelector('[role="alert"]').textContent).toContain('انتهت صلاحية الجلسة')
  })

  it('returns to login when a restored session is rejected at start', async () => {
    // A token left in sessionStorage is only a claim; the server decides.
    sessionStorage.setItem('station.local.token', TOKEN)
    const { app, root } = await mount({ '/api/v1/me': { status: 401, body: {} } })
    expect(app.state).toBe('login')
    expect(root.querySelector('form')).not.toBeNull()
    // A rejected token is discarded, not retried forever.
    expect(sessionStorage.getItem('station.local.token')).toBeNull()
  })

  it('logs out and returns to the login form', async () => {
    const { app, root } = await mount(managerRoutes)
    await submit(root, 'manager', 'manager123')
    await flush()
    root.querySelector('#logout').click()
    expect(app.state).toBe('login')
    expect(root.querySelector('form')).not.toBeNull()
    expect(sessionStorage.getItem('station.local.token')).toBeNull()
  })
})

// ---- Arabic / RTL / mobile ------------------------------------------------

describe('the Arabic, right-to-left, mobile surface', () => {
  it('is right-to-left Arabic before any script runs', async () => {
    // Read from the shipped shell, not from a re-typed copy.
    const shell = await readFile('./index.html')
    expect(shell).toContain('lang="ar"')
    expect(shell).toContain('dir="rtl"')
  })

  it('declares a mobile viewport that respects notches', async () => {
    const shell = await readFile('./index.html')
    expect(shell).toContain('width=device-width')
    // `viewport-fit=cover` is what makes the safe-area padding meaningful.
    expect(shell).toContain('viewport-fit=cover')
  })

  it('cannot overflow horizontally, whatever the content', async () => {
    const css = await readFile('./assets/app.css')
    // The two rules that make an Arabic label or a long value wrap instead of
    // forcing a sideways scroll on a 360px phone.
    expect(css).toContain('overflow-x: hidden')
    expect(css).toContain('overflow-wrap: anywhere')
    // No fixed pixel width anywhere: layout is %, rem or auto.
    expect(css).not.toMatch(/^\s*width:\s*\d+px/m)
  })

  it('uses no hover-only affordance and keeps touch targets large', async () => {
    const css = await readFile('./assets/app.css')
    // Nothing depends on a pointer: a phone has no hover.
    expect(css).not.toContain(':hover')
    // 3rem = 48px, the minimum comfortable touch target.
    expect(css).toContain('min-height: 3rem')
  })

  it('ships no external font, script, style or analytics', async () => {
    for (const name of ['app.js', 'api.js', 'ui.js', 'strings.js']) {
      const text = await readFile(`./assets/${name}`)
      expect(text, name).not.toContain('https://')
      expect(text, name).not.toContain('http://')
    }
    const css = await readFile('./assets/app.css')
    // Assert on real at-rules, not on prose: the file's own header comment
    // mentions @import and @font-face to explain why it uses neither.
    expect(css).not.toMatch(/^\s*@import/m)
    // The desktop loads Cairo; the phone must not try to fetch a font.
    expect(css).not.toMatch(/^\s*@font-face/m)
  })

  it('never injects server text as markup', async () => {
    // A name is written with textContent, so it cannot become an element.
    const { root } = await mount({
      '/api/v1/auth/login': {
        body: {
          token: TOKEN,
          user: { id: 1, name: '<img src=x onerror=alert(1)>', role: 'MANAGER' },
        },
      },
      '/api/v1/manager/summary': { body: { open_day: true } },
    })
    await submit(root, 'manager', 'manager123')
    expect(root.querySelector('img')).toBeNull()
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})

// ---- the session token ----------------------------------------------------

describe('the session token', () => {
  it('is never written to localStorage', async () => {
    // A shared counter phone left unlocked must not keep a manager session
    // alive after the tab closes.
    const { root } = await mount({
      '/api/v1/auth/login': {
        body: { token: TOKEN, user: { id: 1, name: 'م', role: 'MANAGER' } },
      },
      '/api/v1/manager/summary': { body: { open_day: true } },
    })
    await submit(root, 'manager', 'manager123')
    expect(sessionStorage.getItem('station.local.token')).toBe(TOKEN)
    expect(localStorage.getItem('station.local.token')).toBeNull()
  })

  it('discards a stored value that is not a real token', () => {
    sessionStorage.setItem('station.local.token', 'not-a-token')
    const api = new StationApi({ fetchImpl: fakeFetch({}) })
    expect(api.session.token).toBeNull()
  })

  it('classifies errors by status, not by message', () => {
    expect(isUnauthorized(new ApiError(401, 'UNAUTHORIZED'))).toBe(true)
    expect(isForbidden(new ApiError(403, 'FORBIDDEN'))).toBe(true)
    // A network failure is neither: it must not be reported as "logged out".
    expect(isUnauthorized(new ApiError(0, 'NETWORK'))).toBe(false)
    expect(isForbidden(new ApiError(401, 'UNAUTHORIZED'))).toBe(false)
  })
})
