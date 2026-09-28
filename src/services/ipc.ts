/**
 * The ONE transport to the Station backend.
 *
 * Every call the application makes goes through `call`/`callPublic` here. That
 * is deliberate: it is the single place that knows whether the code is running
 * inside the Tauri desktop shell or in a phone browser on the cafe LAN, so the
 * rest of the application — pages, hooks, services, roles, translations — is
 * identical on both and can never drift between them.
 *
 * - Desktop: `invoke(cmd, args)` over the Tauri IPC bridge.
 * - Browser: `POST /api/v1/cmd/<cmd>` with a bearer token, answered by the
 *   SAME Rust command functions the desktop calls (see
 *   `src-tauri/src/network/bridge.rs`). Same commands, same role checks, same
 *   business rules, same database.
 *
 * Token handling is identical on both: read from the session store, sent in the
 * `Authorization` header, and never placed in a URL, a query string or the
 * request body. A token that arrives in a query string is refused server-side.
 */
import { invoke } from '@tauri-apps/api/core'
import { sessionToken } from '@/features/auth/session'

export interface AppErrorShape {
  kind: string
  message: string
}

export class ApiError extends Error {
  kind: string
  shape: AppErrorShape

  constructor(shape: AppErrorShape) {
    super(shape.message)
    this.shape = shape
    this.kind = shape.kind
  }
}

/** True when running inside the Tauri shell rather than a plain browser. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** The command endpoint on the LAN listener. Same origin as the page. */
const CMD_BASE = '/api/v1/cmd'

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const token = sessionToken()
  if (!isDesktop()) return httpCall<T>(cmd, token, args)
  try {
    return await invoke<T>(cmd, { token, ...args })
  } catch (error_) {
    throw toApiError(error_)
  }
}

/** Login is called without a token. */
export async function callPublic<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) return httpCall<T>(cmd, null, args)
  try {
    return await invoke<T>(cmd, args ?? {})
  } catch (error_) {
    throw toApiError(error_)
  }
}

/**
 * Run one command over HTTP.
 *
 * The body carries ONLY command arguments — never the token — and the response
 * is the command's own serialised result, exactly as the IPC layer produces it,
 * so a page cannot tell which transport served it.
 */
async function httpCall<T>(
  cmd: string,
  token: string | null,
  args?: Record<string, unknown>,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`

  let response: Response
  try {
    response = await fetch(`${CMD_BASE}/${encodeURIComponent(cmd)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args ?? {}),
    })
  } catch {
    // Station on the LAN is unreachable. This is a transport failure, not a
    // business error, and it must not be reported as one.
    throw new ApiError({ kind: 'network', message: 'network.unreachable' })
  }

  const payload = await readJson(response)
  if (!response.ok) {
    // The server answers a refusal with the SAME `{kind, message}` shape the
    // IPC layer uses, so `toApiError` needs no special case for HTTP.
    const error = toApiError(payload)
    // A 401 means the session is gone (expired, revoked, or logged out
    // elsewhere). Clear it exactly once, centrally, so the application drops
    // back to the Station login screen instead of leaving a page stuck on
    // stale data. A 403 is deliberately NOT handled here: a role refusal is a
    // real answer about this user and must stay visible as one.
    if (response.status === 401) notifyUnauthorized()
    throw error
  }
  return payload as T
}

/**
 * Listeners for "this session is no longer valid".
 *
 * A module-level registry rather than a React context because the transport is
 * deliberately outside React: `SessionProvider` subscribes so a 401 from ANY
 * command returns the user to the Station login screen.
 */
const unauthorizedListeners = new Set<() => void>()

/** Subscribe to session invalidation. Returns the unsubscribe function. */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener)
  return () => unauthorizedListeners.delete(listener)
}

function notifyUnauthorized(): void {
  for (const listener of unauthorizedListeners) listener()
}

/** Parse a response body as JSON, tolerating an empty or HTML body. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { kind: 'internal', message: 'internal_error' }
  }
}

export function toApiError(raw: unknown): ApiError {
  if (typeof raw === 'string') {
    // A rejected command that is NOT a serialized AppError is a protocol
    // failure (e.g. the backend rejected the argument shape). The technical
    // detail stays in the console for developers; users get a stable Arabic
    // message instead of a raw serializer string that no translation key can
    // ever match.
    console.error('[station/ipc] command rejected with a non-domain error:', raw)
    return new ApiError({ kind: 'ipc', message: 'ipc.contract_violation' })
  }
  const obj = (raw ?? {}) as Partial<AppErrorShape>
  return new ApiError({
    kind: obj.kind ?? 'internal',
    message: obj.message ?? 'internal_error',
  })
}
