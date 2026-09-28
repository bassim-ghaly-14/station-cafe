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
  /** The URL encoded in the QR. Protocol, host, port and a real path — nothing else. */
  url: string
  /** The QR as an SVG document. */
  svg: string
  port: number
  host: string
  /** Other usable addresses on this machine, as an IP fallback. */
  otherHosts: string[]
  /** Whether mDNS advertised Station, so the hostname may also work. */
  discoveryActive: boolean
  /** Whether the API is actually listening right now. */
  apiRunning: boolean
}

export const localAccessApi = {
  /** MANAGER+; the backend enforces the role, the UI only reflects it. */
  load: () => call<LocalAccess>('local_access_qr'),
}
