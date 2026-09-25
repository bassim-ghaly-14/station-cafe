/**
 * Typed Tauri IPC wrapper.
 * - Injects the session token into every call.
 * - Normalizes backend errors into { kind, message } (message = stable
 *   machine key mapped to Arabic by the UI).
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

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const token = sessionToken()
  try {
    return await invoke<T>(cmd, { token, ...(args ?? {}) })
  } catch (raw) {
    throw toApiError(raw)
  }
}

/** Login is called without a token. */
export async function callPublic<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args ?? {})
  } catch (raw) {
    throw toApiError(raw)
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
