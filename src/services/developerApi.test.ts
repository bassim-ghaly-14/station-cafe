import { beforeEach, describe, expect, it, vi } from 'vitest'
import { developerApi } from './developerApi'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}))

/**
 * Contract tests for the IPC layer behind the two developer data actions.
 *
 * They exist because the argument key for `load_official_data` is NOT the
 * JavaScript parameter name: the Rust command is declared with
 * `#[tauri::command(rename_all = "snake_case")]`, so `reseed_token` is the only
 * key Tauri will bind. Sending the camelCase `reseedToken` is silently dropped,
 * the grant deserializes as `None`, and the command falls back to session-token
 * authorization — which the reset has just deleted. The result is "Load
 * Official Data" failing with "invalid session" immediately after a successful
 * clear. These assertions lock the key down so it cannot regress.
 */
describe('developerApi IPC contract', () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined)
    developerApi.clearReseedToken()
  })

  it('clears through the clear_database command and returns the reseed grant', async () => {
    invoke.mockResolvedValueOnce('the-grant')

    await expect(developerApi.clear()).resolves.toBe('the-grant')
    expect(invoke.mock.calls[0][0]).toBe('clear_database')
  })

  it('sends the reseed grant under the exact snake_case key the command declares', async () => {
    await developerApi.loadOfficial('the-grant')

    const [command, args] = invoke.mock.calls[0]
    expect(command).toBe('load_official_data')
    // The Rust parameter is `reseed_token: Option<String>`.
    expect(args).toHaveProperty('reseed_token', 'the-grant')
    // The camelCase spelling must never reappear: it binds to nothing.
    expect(args).not.toHaveProperty('reseedToken')
  })

  it('omits the reseed argument entirely when no grant is held', async () => {
    await developerApi.loadOfficial(null)

    const [, args] = invoke.mock.calls[0]
    expect(args).not.toHaveProperty('reseed_token')
  })

  it('keeps the grant across a clear so the reseed stays possible, then drops it', () => {
    developerApi.setReseedToken('the-grant')
    expect(developerApi.takeReseedToken()).toBe('the-grant')

    developerApi.clearReseedToken()
    expect(developerApi.takeReseedToken()).toBeNull()
  })
})
