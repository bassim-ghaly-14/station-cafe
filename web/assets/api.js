/**
 * Station Cafe — LOCAL WEB: the API client.
 *
 * A thin, dependency-free wrapper over the SAME Rust HTTP API the desktop
 * application already exposes. It is deliberately NOT a second authentication
 * system: it speaks the existing endpoints and nothing else.
 *
 *   POST /api/v1/auth/login     → { token, user }
 *   GET  /api/v1/me             → { user }
 *   GET  /api/v1/manager/summary → { user, open_day }
 *   GET  /api/v1/health         → { status, ... }
 *
 * Security properties this file is responsible for:
 *
 * - The token is sent ONLY in the `Authorization: Bearer` header. It is never
 *   placed in a URL, a query string or a fragment, because those end up in
 *   browser history, proxy logs and `Referer` headers. The Rust API rejects a
 *   token in the query string outright (`TOKEN_IN_QUERY`); this client simply
 *   never produces one.
 * - The token lives in memory for the lifetime of the page and is mirrored into
 *   `sessionStorage`. NOT `localStorage`: a shared counter phone left unlocked
 *   would otherwise keep a manager session alive indefinitely.
 * - No credential is ever written to the DOM, the URL, or storage under any
 *   other key. Logging out clears the token and the cached identity.
 */

/** The single API namespace. There is no second base URL. */
export const API_PREFIX = '/api/v1'

/**
 * An error carrying the HTTP status and the API's stable error code.
 *
 * The UI branches on `status` (401 → back to login, 403 → no manager data)
 * rather than on message text, because the server stays authoritative about
 * what is permitted.
 */
export class ApiError extends Error {
  /** @param {number} status @param {string} code */
  constructor(status, code) {
    super(`Station API error ${status} ${code}`)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** True when the failure means "this session is no longer valid". */
export function isUnauthorized(error) {
  return error instanceof ApiError && error.status === 401
}

/** True when the failure means "authenticated, but not allowed to do that". */
export function isForbidden(error) {
  return error instanceof ApiError && error.status === 403
}

/** Where the session token is mirrored, if anywhere. */
export const TOKEN_KEY = 'station.local.token'

/**
 * Storage that degrades safely.
 *
 * `sessionStorage` throws in private-mode Safari and when a browser blocks
 * storage, so every access is guarded: a failure costs session persistence,
 * never a working login.
 */
function safeSessionStorage() {
  try {
    const store = globalThis.sessionStorage
    if (!store) return null
    const probe = '__station_probe__'
    store.setItem(probe, '1')
    store.removeItem(probe)
    return store
  } catch {
    return null
  }
}

/**
 * The in-memory session. The token is the ONLY secret held here.
 */
export class Session {
  /** @param {{ persist?: boolean }} [options] */
  constructor(options = {}) {
    /** @type {string | null} */
    this.token = null
    /** @type {{ id: number, name: string, role: string } | null} */
    this.user = null
    // Persistence defaults to ON, but only into `sessionStorage`, which is
    // cleared when the tab closes.
    this.persist = options.persist !== false
    this.store = this.persist ? safeSessionStorage() : null
    this.restore()
  }

  /** Re-adopt a token left by a previous page load in the same tab. */
  restore() {
    if (!this.store) return
    const saved = this.store.getItem(TOKEN_KEY)
    // A token is only useful if it is shaped like one (48 hex chars, as
    // `services::auth` issues); anything else is discarded rather than sent.
    if (saved && /^[0-9a-f]{48}$/i.test(saved)) this.token = saved
    else this.store.removeItem(TOKEN_KEY)
  }

  /** @param {string} token @param {{ id: number, name: string, role: string }} user */
  set(token, user) {
    this.token = token
    this.user = user
    if (this.store) this.store.setItem(TOKEN_KEY, token)
  }

  clear() {
    this.token = null
    this.user = null
    if (this.store) this.store.removeItem(TOKEN_KEY)
  }

  get isAuthenticated() {
    return typeof this.token === 'string' && this.token.length > 0
  }
}

/**
 * The API client.
 *
 * `fetchImpl` is injectable so the UI can be tested without a network, and
 * `baseUrl` is relative by default: the app is always served from the same
 * origin as the API, so no absolute URL and no CORS preflight is ever needed.
 */
export class StationApi {
  /**
   * @param {{ fetchImpl?: typeof fetch, session?: Session, baseUrl?: string }} [options]
   */
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)
    this.session = options.session ?? new Session(options)
    this.baseUrl = options.baseUrl ?? API_PREFIX
  }

  /**
   * One request/response cycle.
   *
   * @param {string} method
   * @param {string} path Route relative to the API prefix, e.g. `/me`.
   * @param {{ body?: unknown, auth?: boolean }} [options]
   */
  async request(method, path, options = {}) {
    if (!this.fetchImpl) throw new ApiError(0, 'NO_FETCH')

    /** @type {Record<string, string>} */
    const headers = { Accept: 'application/json' }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    // The ONLY place a token ever travels.
    if (options.auth && this.session.token) {
      headers.Authorization = `Bearer ${this.session.token}`
    }

    let response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        // The API answers `no-store`; asking for it too keeps a shared phone
        // from caching a manager's dashboard between users.
        cache: 'no-store',
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      })
    } catch {
      // A network-level failure (Station closed, Wi-Fi dropped) is reported as
      // status 0 so the UI can say "offline" rather than "wrong password".
      throw new ApiError(0, 'NETWORK')
    }

    if (response.status === 204) return null

    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }

    if (!response.ok) {
      const code = payload?.error?.code ?? 'UNKNOWN'
      throw new ApiError(response.status, code)
    }
    return payload
  }

  /** Liveness of the Station process behind this address. */
  health() {
    return this.request('GET', '/health')
  }

  /**
   * Authenticate with a Station account.
   *
   * Delegates to the same Rust `services::auth::login` the desktop application
   * uses — one password check, one session table, one audit trail. The password
   * is sent once, in the request body over the LAN, and is never stored,
   * logged or echoed back.
   *
   * @param {string} name @param {string} password
   */
  async login(name, password) {
    const result = await this.request('POST', '/auth/login', { body: { name, password } })
    this.session.set(result.token, result.user)
    return result.user
  }

  /**
   * Validate the stored session.
   *
   * @returns {Promise<{ id: number, name: string, role: string }>}
   */
  async me() {
    const result = await this.request('GET', '/me', { auth: true })
    this.session.user = result.user
    return result.user
  }

  /**
   * Today's manager summary.
   *
   * MANAGER+ only. A STAFF session receives 403 from the Rust authorization
   * layer, surfaced as an {@link ApiError} and handled by the UI as "not
   * available for your role" — never as an empty dashboard implying the cafe
   * had no sales.
   */
  managerSummary() {
    return this.request('GET', '/manager/summary', { auth: true })
  }

  /**
   * End the session.
   *
   * There is no network logout endpoint — revoking the server-side session is
   * the desktop application's job — so the token is discarded here. The server
   * stays authoritative: the token is gone the moment the tab closes, and it was
   * validated by Rust on every single request in the meantime.
   */
  logout() {
    this.session.clear()
  }
}
