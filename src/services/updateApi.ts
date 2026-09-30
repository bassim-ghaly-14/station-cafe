/**
 * The ONE way Station touches the Tauri updater.
 *
 * Three rules make this file the whole updater surface:
 *
 * 1. DESKTOP ONLY. `isDesktop()` is the same test `services/ipc.ts` uses, so the
 *    updater is available exactly where `invoke` is. On a phone or a browser on
 *    the cafe LAN every function here refuses before it reaches the plugin, so
 *    no Tauri channel is ever opened and nothing is ever invoked. The plugin
 *    modules are ordinary ES modules that only define functions at load time,
 *    so importing them in a browser bundle is inert rather than fatal.
 *
 * 2. NEVER `call()`. The updater is not a Station business command. Routing it
 *    through the LAN `api/v1/cmd` bridge would put a GitHub download on the
 *    cafe's HTTP surface, expose a desktop-only capability to any phone on the
 *    LAN, and force the LAN contract test to grow an update endpoint. The
 *    plugin talks to the network from Rust, over its own channel.
 *
 * 3. NO POLLING. Nothing in this file is called on mount, on startup, or on a
 *    timer. `checkForUpdate()` runs only when a manager presses the button.
 *
 * Signature verification is NOT re-implemented here and the `.sig` is never
 * fetched separately: `tauri-plugin-updater` verifies the downloaded bundle
 * against the `plugins.updater.pubkey` compiled into the binary and refuses an
 * unsigned or wrong-key update before it is installed.
 */
import { isDesktop } from './ipc'
import { relaunch } from '@tauri-apps/plugin-process'
import { getVersion } from '@tauri-apps/api/app'
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'

/**
 * Why an updater call could not be performed or completed.
 *
 * These are translation keys, not messages: the caller maps them with `t()`, so a
 * plugin stack trace, a file path or a URL can never reach the screen.
 */
export type UpdateErrorCode =
  | 'dev.updateUnsupported'
  | 'dev.updateUnsupportedPlatform'
  | 'dev.updateCheckFailed'
  | 'dev.updateFailed'
  | 'dev.updateRestartFailed'

export class UpdateError extends Error {
  readonly code: UpdateErrorCode

  constructor(code: UpdateErrorCode, options?: { cause?: unknown }) {
    super(code, options)
    this.name = 'UpdateError'
    this.code = code
  }
}

/**
 * The two error strings `tauri-plugin-updater` produces when the release
 * manifest parsed fine but carries no entry for the platform this binary is
 * running on: `Error::TargetNotFound` and `Error::TargetsNotFound`.
 *
 * This is NOT a transport failure and NOT a broken connection. Station's
 * releases are published for Windows (NSIS) only, so on any other desktop
 * platform the plugin cannot find `darwin-*` / `linux-*` and rejects. Reporting
 * that as "check your internet connection" sends a developer hunting a network
 * problem that does not exist, which is exactly what happened.
 */
const PLATFORM_NOT_PUBLISHED =
  /was not found in the response|were found in the response|platforms` object/

/**
 * Map a rejected `check()` onto a translation key, keeping the distinction the
 * plugin actually made.
 *
 * The raw error is always logged first, with a stable prefix, so the real
 * failure — DNS, TLS, HTTP status, malformed manifest, bad signature,
 * wrong key, missing capability, plugin/JS version mismatch — is recoverable
 * from the developer console. Nothing is logged to the user-facing surface, and
 * nothing secret (keys, tokens) is ever part of these messages.
 */
function classifyCheckError(error: unknown): UpdateErrorCode {
  console.error('[station/update] check failed:', error)
  const message = error instanceof Error ? error.message : String(error ?? '')
  return PLATFORM_NOT_PUBLISHED.test(message)
    ? 'dev.updateUnsupportedPlatform'
    : 'dev.updateCheckFailed'
}

/** Download progress, already clamped to a renderable percentage. */
export interface UpdateProgress {
  readonly downloaded: number
  /** `null` when the server did not send a usable content length. */
  readonly total: number | null
  /** Integer 0-100, or `null` while the total is unknown. Never NaN/Infinity. */
  readonly percent: number | null
}

/**
 * The part of the plugin's `Update` this service actually needs, declared
 * structurally so the UI holds a plain object and never a plugin instance.
 */
interface UpdateResource {
  download(onEvent: (event: DownloadEvent) => void): Promise<void>
  install(): Promise<void>
}

/**
 * An update the endpoint announced, held open on the Rust side.
 *
 * A manager may sit on this for a while (there is a confirmation to read), so
 * the caller MUST `dispose()` it when the flow ends without installing, per the
 * plugin's own `Update.close()` contract.
 */
export interface PendingUpdate {
  readonly version: string
  readonly currentVersion: string
  dispose(): Promise<void>
  /** @internal The service owns this; the UI never reaches it. */
  readonly resource: UpdateResource
}

/** Whether application updates exist at all in the current environment. */
export function isUpdateSupported(): boolean {
  return isDesktop()
}

/** The installed application version, straight from the running binary. */
export async function currentVersion(): Promise<string | null> {
  if (!isDesktop()) return null
  try {
    return await getVersion()
  } catch {
    // The version is display-only. Failing to read it must not hide the card
    // or disable a check that would still work.
    return null
  }
}
/**
 * Ask the configured endpoint whether a newer signed build exists.
 *
 * Returns `null` for "no update", which is a normal answer and not an error.
 * Every transport, HTTP, manifest or signature failure becomes an `UpdateError`
 * carrying a translation key.
 */
export async function checkForUpdate(): Promise<PendingUpdate | null> {
  if (!isDesktop()) throw new UpdateError('dev.updateUnsupported')

  let update: Update | null
  try {
    update = await check()
  } catch (error) {
    throw new UpdateError(classifyCheckError(error), { cause: error })
  }
  if (!update) return null

  const resource = updaterResource(update)
  if (!resource) {
    await safeClose(update)
    console.error('[station/update] endpoint returned a malformed update object:', update)
    throw new UpdateError('dev.updateCheckFailed')
  }

  return {
    version: update.version,
    currentVersion: update.currentVersion,
    resource,
    dispose: () => safeClose(update),
  }
}

/**
 * The plugin object, kept behind the structural `UpdateResource` type so the UI
 * holds a `PendingUpdate` and never a plugin instance.
 */
function updaterResource(update: Update): UpdateResource | null {
  if (typeof update.download !== 'function' || typeof update.install !== 'function') return null
  return update
}

/**
 * Download the pending update and install it.
 *
 * Split deliberately rather than `downloadAndInstall`, because the UI shows a
 * real download percentage and then a distinct "ready to restart" state; one
 * opaque call would leave the manager staring at a frozen number while the
 * installer actually runs.
 *
 * On Windows the installer replaces the app and the process exits, so
 * `install()` normally never resolves. The UI treats "the installer took over"
 * as the success path and never claims success before the bytes are down.
 */
export async function installUpdate(
  update: PendingUpdate,
  onProgress: (progress: UpdateProgress) => void,
): Promise<void> {
  if (!isDesktop()) throw new UpdateError('dev.updateUnsupported')

  let total: number | null = null
  let downloaded = 0

  try {
    await update.resource.download((event) => {
      if (event.event === 'Started') {
        // `event.data` is typed as present, but a malformed or older plugin
        // payload must not be able to throw here: a crash would be reported as
        // a failed install of an update that never started downloading.
        total = normalizeTotal(event.data?.contentLength)
        onProgress({ downloaded: 0, total, percent: toPercent(0, total) })
        return
      }
      if (event.event === 'Progress') {
        downloaded += Math.max(0, event.data?.chunkLength ?? 0)
        onProgress({ downloaded, total, percent: toPercent(downloaded, total) })
        return
      }
      // 'Finished': the final Progress event can land short of the announced
      // total on a throttled connection, so report a complete bar, not 98%.
      onProgress({ downloaded, total, percent: 100 })
    })
    await update.resource.install()
  } catch (error) {
    if (error instanceof UpdateError) throw error
    throw new UpdateError('dev.updateFailed')
  }
}

/**
 * Restart Station on the new version.
 *
 * A no-op outside the desktop shell, so a LAN browser that ever reached this
 * path can never attempt a process restart.
 */
export async function relaunchApp(): Promise<void> {
  if (!isDesktop()) return
  try {
    await relaunch()
  } catch {
    // The installer already replaced the files, so failing to respawn leaves a
    // working application on disk and a closed window: the manager reopens
    // Station and is on the new version. Reported as a failed RESTART, never
    // as a failed update.
    throw new UpdateError('dev.updateRestartFailed')
  }
}

/** Release a pending update without installing it. Never throws. */
async function safeClose(update: Update): Promise<void> {
  try {
    await update.close()
  } catch {
    // Nothing to do: the resource is backend state that the next check resets.
  }
}

/**
 * A usable content length, or `null`.
 *
 * The plugin types it optional; a missing, zero, negative, NaN or infinite
 * length means "unknown", which the UI renders as indeterminate rather than
 * dividing by zero.
 */
function normalizeTotal(contentLength: number | undefined): number | null {
  if (typeof contentLength !== 'number') return null
  if (!Number.isFinite(contentLength) || contentLength <= 0) return null
  return contentLength
}

/**
 * Whole-percent progress, or `null` when the total is unknown.
 *
 * Clamped rather than trusted: a server that under-reports its length would
 * otherwise overshoot 100, and the UI must never render `NaN%` or `Infinity%`
 * at a manager mid-shift.
 */
export function toPercent(downloaded: number, total: number | null): number | null {
  if (total === null) return null
  if (!Number.isFinite(downloaded) || downloaded < 0) return 0
  const ratio = downloaded / total
  if (!Number.isFinite(ratio)) return 100
  return Math.min(100, Math.max(0, Math.floor(ratio * 100)))
}
