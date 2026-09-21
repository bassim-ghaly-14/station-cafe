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
    return new ApiError({ kind: 'internal', message: raw })
  }
  const obj = (raw ?? {}) as Partial<AppErrorShape>
  return new ApiError({
    kind: obj.kind ?? 'internal',
    message: obj.message ?? 'internal_error',
  })
}
