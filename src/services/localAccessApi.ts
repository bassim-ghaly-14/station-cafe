/**
 * Typed wrapper for the local-access QR shown in Dev Settings.
 *
 * The URL itself is built in RUST, not here. The frontend receives an already
 * assembled address and only displays it, so there is no place in this file
 * where a token, password or session id could be concatenated into a scannable
 * payload. `accessUrl` is a plain read of what the backend produced.
 */
import { call } from './ipc'

export interface LocalAccess {
  /**
   * The URL encoded in the QR, or `null` when nothing is listening.
   *
   * Nullable on purpose: the backend only produces a URL when a listener
   * actually exists, so a stopped service can never be displayed as though it
   * were reachable.
   *
   * This is the CANONICAL URL, and it is whatever the backend decided is best:
   * `http://station.local:47821/` while mDNS discovery advertises the friendly
   * name, otherwise the IP fallback. The page displays exactly this string and
   * the code was rendered from it, so the two cannot disagree.
   */
  url: string | null
  /** The QR as an SVG document, or `null` when the service is not running. */
  svg: string | null
  /** Whether the API is actually LISTENING — not whether it is enabled. */
  apiRunning: boolean
  /** Stable key explaining why it is not running, when it is not. */
  error: string | null
  port: number
  host: string | null
  otherHosts: string[]
  discoveryActive: boolean
  /**
   * `station.local` while discovery advertises it, otherwise `null`.
   *
   * `null` means the name is NOT resolvable right now, so the UI must fall back
   * to `fallbackUrl` rather than display a hostname nothing answers to.
   */
  hostname: string | null
  /** `http://station.local:47821/`, or `null` when discovery is not advertising. */
  friendlyUrl: string | null
  /**
   * `http://<lan-ip>:47821/` — the guarantee for any device that cannot resolve
   * `.local` (Windows without an mDNS responder, a network that filters
   * multicast). Present whenever the service is running.
   */
  fallbackUrl: string | null
}

export interface NetworkConfig {
  enabled: boolean
  bind: string
  port: number
}

/** Observed runtime state. `enabled` is intent; `running` is fact. */
export interface RuntimeStatus {
  enabled: boolean
  running: boolean
  address: string | null
  error: string | null
}

export const localAccessApi = {
  /** MANAGER+; the backend enforces the role, the UI only reflects it. */
  load: () => call<LocalAccess>('local_access_qr'),
  getConfig: () => call<NetworkConfig>('get_network_config'),
  /**
   * Persists the configuration AND starts or stops the service immediately.
   *
   * This is the call that was missing: without it `enabled` could be stored by
   * nothing, so the API could never actually be switched on.
   */
  save: (config: NetworkConfig) => call<RuntimeStatus>('set_network_config', { config }),
  status: () => call<RuntimeStatus>('local_api_status'),
}
