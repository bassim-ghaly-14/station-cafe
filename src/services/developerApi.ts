import { call } from './ipc'

/**
 * One-time grant issued by `clear_database`.
 *
 * A full reset deletes the `sessions` table, so the caller has no valid session
 * token afterwards. The backend therefore mints a single-use, in-memory grant
 * and the only thing allowed to do with it is seed the official catalog. It is
 * never persisted, so a restart discards it.
 *
 * Held in module scope (not localStorage) precisely because it must not outlive
 * the page session that requested the reset.
 */
let reseedToken: string | null = null

export const developerApi = {
  /**
   * Clear every application row, preserving only the developer ADMIN account.
   * Resolves with the one-time reseed grant described above.
   */
  clear: () => call<string>('clear_database'),

  /**
   * Load the official Station starter catalog.
   *
   * The argument key MUST stay `reseed_token`: the Rust command is declared with
   * `#[tauri::command(rename_all = "snake_case")]`, so that is the only key the
   * IPC layer will bind. Sending `reseedToken` (camelCase) is silently dropped,
   * `reseed_token` deserializes as `None`, and the command then tries to
   * authorize through a session token that the reset just deleted — failing
   * with "invalid session" for the user right after a successful clear.
   */
  loadOfficial: (token?: string | null) =>
    call<void>('load_official_data', token ? { reseed_token: token } : undefined),
  setReseedToken(token: string | null) {
    reseedToken = token
  },
  takeReseedToken() {
    return reseedToken
  },
  clearReseedToken() {
    reseedToken = null
  },
}
