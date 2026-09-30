/**
 * The Application Updates card — Station's only update surface.
 *
 * These tests exercise the REAL service (`src/services/updateApi.ts`) against a
 * MOCKED PLUGIN, not a mocked service. That is deliberate: the parts most likely
 * to be wrong are the plugin-shaped ones — the Started/Progress/Finished event
 * sequence, the fact that the Windows installer ends the process, and the
 * progress values a malformed manifest produces. A test that mocked the service
 * itself would assert nothing about any of them.
 *
 * Everything asserted here is what a manager SEES: which button is enabled,
 * which message appears, and whether a download happened at all.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import { ApplicationUpdatesCard } from './ApplicationUpdatesCard'

const mocks = vi.hoisted(() => ({
  desktop: true,
  check: vi.fn(),
  relaunch: vi.fn(),
  getVersion: vi.fn(),
  call: vi.fn(),
}))

vi.mock('@/services/ipc', () => ({
  isDesktop: () => mocks.desktop,
  call: (cmd: string) => mocks.call(cmd),
}))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: mocks.getVersion }))

/**
 * A fake plugin update. `download` walks the real three-event sequence and
 * `install` resolves, which is the macOS/Linux shape; on Windows the installer
 * ends the process instead, and that difference is asserted where it matters.
 */
function fakeUpdate(version: string, total = 1000) {
  const state = { downloadCalls: 0, installCalls: 0, closeCalls: 0 }
  return {
    state,
    version,
    currentVersion: '0.1.0',
    rawJson: {},
    download: vi.fn(async (onEvent: (event: unknown) => void) => {
      state.downloadCalls += 1
      onEvent({ event: 'Started', data: { contentLength: total } })
      onEvent({ event: 'Progress', data: { chunkLength: total / 2 } })
      onEvent({ event: 'Progress', data: { chunkLength: total / 2 } })
      onEvent({ event: 'Finished' })
    }),
    install: vi.fn(async () => {
      state.installCalls += 1
    }),
    close: vi.fn(async () => {
      state.closeCalls += 1
    }),
  }
}

/** No open work: the shift gate is clear, the normal cafe-at-rest case. */
const IDLE_DAY = { day: null, my_shift: null, any_active_shift: false }
const OPEN_SHIFT = { day: { id: 1 }, my_shift: null, any_active_shift: true }
const OPEN_DAY = { day: { id: 1 }, my_shift: null, any_active_shift: false }

function renderCard() {
  return render(
    <ToastProvider>
      <ApplicationUpdatesCard />
    </ToastProvider>,
  )
}

/**
 * Press Check and wait for the card to leave its loading state.
 */
async function pressCheck() {
  fireEvent.click(screen.getByTestId('dev-update-check'))
  await waitFor(() => expect(screen.getByTestId('dev-update-check')).not.toBeDisabled())
}

/**
 * A download the test drives by hand.
 *
 * A real download takes seconds, so the `downloading` state is genuinely on
 * screen for a while. A mock that emitted every event inside one tick would
 * never let React commit that state, and the assertions about progress and
 * disabled-while-busy would be testing nothing. `emit` publishes one plugin
 * event; `release` lets the download finish.
 */
function deferredDownload(total: number | null) {
  let emit: ((event: unknown) => void) | null = null
  let release: (() => void) | null = null
  return {
    emit: (event: unknown) => emit?.(event),
    release: () => release?.(),
    download: vi.fn(
      (onEvent: (event: unknown) => void) =>
        new Promise<void>((resolve) => {
          emit = onEvent
          release = resolve
          if (total !== null) onEvent({ event: 'Started', data: { contentLength: total } })
          else onEvent({ event: 'Started' })
        }),
    ),
  }
}

/** Confirm an install and wait for the download to actually begin. */
async function confirmAndWaitForDownload() {
  fireEvent.click(screen.getByTestId('dev-update-confirm'))
  await waitFor(() => expect(screen.getByTestId('dev-update-progress')).toBeInTheDocument())
}

describe('ApplicationUpdatesCard', () => {
  beforeEach(() => {
    mocks.desktop = true
    mocks.check.mockReset()
    mocks.relaunch.mockReset().mockResolvedValue(undefined)
    mocks.getVersion.mockReset().mockResolvedValue('0.1.0')
    mocks.call.mockReset().mockResolvedValue(IDLE_DAY)
  })

  it('renders the installed version reported by the running binary', async () => {
    mocks.getVersion.mockResolvedValue('0.1.7')
    renderCard()
    await waitFor(() => expect(screen.getByTestId('dev-update-version')).toHaveTextContent('0.1.7'))
  })

  it('offers a manual check and never checks by itself', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId('dev-update-check')).toBeInTheDocument())
    // No mount-time check, no polling, no startup check: the endpoint has not
    // been touched, and this test fails the moment any of them exists.
    expect(mocks.check).not.toHaveBeenCalled()
  })

  it('enters a loading state and disables the check while it runs', async () => {
    const gate = { release: () => {} }
    mocks.check.mockReturnValue(
      new Promise((resolve) => {
        gate.release = () => resolve(null)
      }),
    )
    renderCard()

    fireEvent.click(screen.getByTestId('dev-update-check'))
    // `aria-busy` is what the Button primitive sets while loading.
    await waitFor(() => expect(screen.getByTestId('dev-update-check')).toHaveAttribute('aria-busy'))
    expect(screen.getByTestId('dev-update-check')).toBeDisabled()

    gate.release()
    await waitFor(() => expect(screen.getByTestId('dev-update-check')).not.toBeDisabled())
  })

  it('reports an up-to-date cafe as success, with no install button', async () => {
    mocks.check.mockResolvedValue(null)
    renderCard()
    await pressCheck()

    await waitFor(() => expect(screen.getByText(/Station محدّث بالفعل/)).toBeInTheDocument())
    expect(screen.queryByTestId('dev-update-install')).not.toBeInTheDocument()
  })

  it('shows the available version and the install action when one exists', async () => {
    mocks.check.mockResolvedValue(fakeUpdate('0.2.0'))
    renderCard()
    await pressCheck()

    await waitFor(() => expect(screen.getByTestId('dev-update-install')).toBeInTheDocument())
    expect(screen.getByTestId('dev-update-available-badge')).toHaveTextContent('0.2.0')
  })

  it('localises a failed check and leaves the button usable for a retry', async () => {
    mocks.check.mockRejectedValue(new Error('ECONNREFUSED 140.82.121.4:443'))
    renderCard()
    await pressCheck()

    // A localized message, never the plugin's stack or the raw host.
    await waitFor(() => expect(screen.getByText(/تعذّر فحص وجود تحديث/)).toBeInTheDocument())
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument()
    expect(screen.getByTestId('dev-update-check')).toBeEnabled()
  })

  it('distinguishes "no build for this platform" from a network failure', async () => {
    // THE BUG. The endpoint is reachable and the manifest parses, but it has no
    // `darwin-*` entry, so tauri-plugin-updater rejects with TargetsNotFound.
    // Reporting that as "check your internet connection" was a lie: it sent the
    // developer hunting a network fault that did not exist.
    mocks.check.mockRejectedValue(
      new Error(
        'None of the fallback platforms `["darwin-x86_64-app", "darwin-x86_64"]` were found in the response `platforms` object',
      ),
    )
    renderCard()
    await pressCheck()

    await waitFor(() =>
      expect(screen.getByText(/لا يوجد إصدار منشور لهذا النظام/)).toBeInTheDocument(),
    )
    // NOT the internet message: the connection was fine.
    expect(screen.queryByText(/تأكد من الاتصال بالإنترنت/)).not.toBeInTheDocument()
    // No install action is offered for a platform that has no published build.
    expect(screen.queryByTestId('dev-update-install')).not.toBeInTheDocument()
    expect(screen.getByTestId('dev-update-check')).toBeEnabled()
  })

  it('keeps the real check failure in the console for diagnostics', async () => {
    // The generic Arabic message is for the manager. The actual plugin error
    // must survive somewhere, or the next occurrence is undiagnosable.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('https://example.invalid/latest.json: 404 Not Found')
    mocks.check.mockRejectedValue(failure)
    renderCard()
    await pressCheck()

    await waitFor(() => expect(screen.getByText(/تعذّر فحص وجود تحديث/)).toBeInTheDocument())
    expect(logged).toHaveBeenCalledWith('[station/update] check failed:', failure)
    logged.mockRestore()
  })

  it('does not crash the card on a malformed update object', async () => {
    // The endpoint answered, but the payload is not a usable Update: no
    // download/install methods. The card must report, not explode, and must
    // never treat it as an installable update.
    mocks.check.mockResolvedValue({ version: '0.2.0', currentVersion: '0.1.0', rawJson: {} })
    renderCard()
    await pressCheck()

    await waitFor(() => expect(screen.getByText(/تعذّر فحص وجود تحديث/)).toBeInTheDocument())
    expect(screen.queryByTestId('dev-update-install')).not.toBeInTheDocument()
    expect(screen.getByTestId('dev-update-check')).toBeEnabled()
  })

  it('never installs anything as a result of check() alone', async () => {
    // The check is a READ. Even when it succeeds and an update exists, the
    // safety gate, the confirmation, the re-check and the download all have to
    // happen before a single byte moves.
    const update = fakeUpdate('0.2.0')
    mocks.check.mockResolvedValue(update)
    renderCard()
    await pressCheck()

    await waitFor(() => expect(screen.getByTestId('dev-update-install')).toBeInTheDocument())
    expect(update.state.downloadCalls).toBe(0)
    expect(update.state.installCalls).toBe(0)
    expect(mocks.relaunch).not.toHaveBeenCalled()
    // The held update is still open on the Rust side, awaiting a decision.
    expect(update.state.closeCalls).toBe(0)
  })

  it('refuses to install when the authoritative safety state cannot be read', async () => {
    // Fail-closed: if `day_shift_state` rejects, the gate is NOT treated as
    // clear. Nothing downloads, nothing installs, the app does not restart.
    const update = fakeUpdate('0.2.0')
    mocks.check.mockResolvedValue(update)
    mocks.call.mockRejectedValue(new Error('database is locked'))
    renderCard()
    await pressCheck()

    fireEvent.click(screen.getByTestId('dev-update-install'))
    await waitFor(() => expect(screen.getByText(/اقفل الوردية/)).toBeInTheDocument())
    // The confirmation never even opens: an unreadable gate is a refusal.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(update.state.downloadCalls).toBe(0)
    expect(update.state.installCalls).toBe(0)
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })

  it('says updates are desktop-only in a browser, without any update controls', () => {
    mocks.desktop = false
    renderCard()

    expect(screen.getByTestId('dev-update-unsupported')).toBeInTheDocument()
    // Crucially: neither the plugin nor the version API was called, so a phone
    // on the cafe LAN cannot fail on a Tauri module it does not have.
    expect(mocks.check).not.toHaveBeenCalled()
    expect(mocks.getVersion).not.toHaveBeenCalled()
    expect(screen.queryByTestId('dev-update-check')).not.toBeInTheDocument()
  })

  it('asks for confirmation before touching anything', async () => {
    mocks.check.mockResolvedValue(fakeUpdate('0.2.0'))
    renderCard()
    await pressCheck()

    fireEvent.click(screen.getByTestId('dev-update-install'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    // Nothing downloaded: the shift state was read once, for the gate that runs
    // BEFORE the confirmation, and no install has started.
    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(mocks.check).toHaveBeenCalledTimes(1)
  })

  it('cancels the confirmation without downloading anything', async () => {
    const update = fakeUpdate('0.2.0')
    mocks.check.mockResolvedValue(update)
    renderCard()
    await pressCheck()

    fireEvent.click(screen.getByTestId('dev-update-install'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('dev-update-cancel'))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(update.state.downloadCalls).toBe(0)
    // The held resource is released rather than leaked on the Rust side.
    expect(update.state.closeCalls).toBe(1)
  })

  it('re-checks availability immediately before installing', async () => {
    const stale = fakeUpdate('0.2.0')
    const fresh = fakeUpdate('0.2.0')
    mocks.check.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh)
    renderCard()
    await pressCheck()

    fireEvent.click(screen.getByTestId('dev-update-install'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('dev-update-confirm'))

    await waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(2))
    // The object from the first check is never installed blind.
    expect(stale.state.installCalls).toBe(0)
    await waitFor(() => expect(fresh.state.installCalls).toBe(1))
  })

  it('abandons the install when the re-check finds no update', async () => {
    const stale = fakeUpdate('0.2.0')
    mocks.check.mockResolvedValueOnce(stale).mockResolvedValueOnce(null)
    renderCard()
    await pressCheck()

    fireEvent.click(screen.getByTestId('dev-update-install'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('dev-update-confirm'))

    await waitFor(() => expect(screen.getByText(/لم يعد هناك تحديث متاح/)).toBeInTheDocument())
    expect(stale.state.downloadCalls).toBe(0)
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })

  it('blocks the update when a shift is open, and downloads nothing', async () => {
    const update = fakeUpdate('0.2.0')
    mocks.check.mockResolvedValue(update)
    mocks.call.mockResolvedValue(OPEN_SHIFT)
    renderCard()
    await pressCheck()

    fireEvent.click(screen.getByTestId('dev-update-install'))
    await waitFor(() => expect(screen.getByText(/اقفل الوردية/)).toBeInTheDocument())
    // Not even the confirmation opens: the manager is stopped at the gate.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(update.state.downloadCalls).toBe(0)
    expect(update.state.installCalls).toBe(0)
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })

  it('blocks the update when a business day is open, and downloads nothing', async () => {
    const update = fakeUpdate('0.2.0')
    mocks.check.mockResolvedValue(update)
    mocks.call.mockResolvedValue(OPEN_DAY)
    renderCard()
    await pressCheck()

    fireEvent.click(screen.getByTestId('dev-update-install'))
    await waitFor(() => expect(screen.getByText(/اقفل الوردية/)).toBeInTheDocument())
    expect(update.state.downloadCalls).toBe(0)
    expect(update.state.installCalls).toBe(0)
  })

  it('re-checks the gate at the last moment, blocking a shift opened after the dialog', async () => {
    // The real scenario: a cashier opens a shift while the manager reads the
    // confirmation. The "clear" result from the first gate is worthless by then.
    const update = fakeUpdate('0.2.0')
    mocks.check.mockResolvedValue(update)
    mocks.call.mockResolvedValueOnce(IDLE_DAY).mockResolvedValueOnce(OPEN_SHIFT)
    renderCard()
    await pressCheck()

    fireEvent.click(screen.getByTestId('dev-update-install'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('dev-update-confirm'))

    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText(/اقفل الوردية/)).toBeInTheDocument())
    expect(update.state.downloadCalls).toBe(0)
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })

  it('shows the download percentage and then reaches the restart state', async () => {
    const update = fakeUpdate('0.2.0')
    const deferred = deferredDownload(1000)
    update.download = deferred.download
    mocks.check.mockResolvedValue(update)
    renderCard()
    await pressCheck()

    fireEvent.click(screen.getByTestId('dev-update-install'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    await confirmAndWaitForDownload()

    deferred.emit({ event: 'Progress', data: { chunkLength: 250 } })
    await waitFor(() => expect(screen.getByTestId('dev-update-progress')).toHaveTextContent('25'))
    deferred.emit({ event: 'Progress', data: { chunkLength: 750 } })
    await waitFor(() => expect(screen.getByTestId('dev-update-progress')).toHaveTextContent('100'))

    deferred.emit({ event: 'Finished' })
    deferred.release()
    await waitFor(() => expect(screen.getByTestId('dev-update-restarting')).toBeInTheDocument())
    expect(update.state.installCalls).toBe(1)
    expect(mocks.relaunch).toHaveBeenCalledTimes(1)
  })

  it('renders no percentage at all when the server sends no content length', async () => {
    const update = fakeUpdate('0.2.0')
    const deferred = deferredDownload(null)
    update.download = deferred.download
    mocks.check.mockResolvedValue(update)
    renderCard()
    await pressCheck()

    fireEvent.click(screen.getByTestId('dev-update-install'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    await confirmAndWaitForDownload()

    deferred.emit({ event: 'Progress', data: { chunkLength: 500 } })
    // An unknown total reads as an indeterminate bar with no figure at all —
    // never NaN%, never Infinity%, and never a number that means nothing.
    await waitFor(() => expect(screen.getByTestId('dev-update-progress')).toBeInTheDocument())
    expect(screen.getByTestId('dev-update-progress')).not.toHaveTextContent('%')
    expect(document.body.textContent).not.toContain('NaN')
    expect(document.body.textContent).not.toContain('Infinity')

    deferred.release()
    await waitFor(() => expect(mocks.relaunch).toHaveBeenCalled())
  })

  it('survives a zero length and an overshooting progress event', async () => {
    const update = fakeUpdate('0.2.0')
    update.download.mockImplementation(async (onEvent: (event: unknown) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 0 } })
      onEvent({ event: 'Progress', data: { chunkLength: 10_000 } })
      onEvent({ event: 'Finished' })
    })
    mocks.check.mockResolvedValue(update)
    renderCard()
    await pressCheck()

    fireEvent.click(screen.getByTestId('dev-update-install'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('dev-update-confirm'))

    await waitFor(() => expect(mocks.relaunch).toHaveBeenCalled())
    expect(document.body.textContent).not.toContain('NaN')
    expect(document.body.textContent).not.toContain('Infinity')
    expect(document.body.textContent).not.toContain('%25')
  })

  it('installs once even when both actions are pressed repeatedly', async () => {
    const update = fakeUpdate('0.2.0')
    mocks.check.mockResolvedValue(update)
    renderCard()
    await pressCheck()

    const install = screen.getByTestId('dev-update-install')
    fireEvent.click(install)
    fireEvent.click(install)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())

    const confirm = screen.getByTestId('dev-update-confirm')
    fireEvent.click(confirm)
    // Two clicks in the same tick must not produce two installers.
    fireEvent.click(confirm)
    await waitFor(() => expect(mocks.relaunch).toHaveBeenCalledTimes(1))
    expect(update.state.downloadCalls).toBe(1)
    expect(update.state.installCalls).toBe(1)
    // One check for the offer, one re-check before install. A third would mean a
    // second install path slipped through the busy guard.
    expect(mocks.check).toHaveBeenCalledTimes(2)
  })

  it('keeps both actions disabled for the whole busy lifecycle', async () => {
    const update = fakeUpdate('0.2.0')
    const deferred = deferredDownload(1000)
    update.download = deferred.download
    mocks.check.mockResolvedValue(update)
    renderCard()
    await pressCheck()

    fireEvent.click(screen.getByTestId('dev-update-install'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    await confirmAndWaitForDownload()

    // Mid-download: a second check or a second update must be impossible.
    expect(screen.getByTestId('dev-update-check')).toBeDisabled()
    expect(screen.getByTestId('dev-update-install')).toBeDisabled()

    deferred.emit({ event: 'Progress', data: { chunkLength: 1000 } })
    deferred.emit({ event: 'Finished' })
    deferred.release()
    await waitFor(() => expect(screen.getByTestId('dev-update-restarting')).toBeInTheDocument())
    expect(screen.getByTestId('dev-update-check')).toBeDisabled()
    expect(screen.getByTestId('dev-update-install')).toBeDisabled()
  })

  it('reports a failed install and returns the card to a usable idle state', async () => {
    const update = fakeUpdate('0.2.0')
    update.install.mockRejectedValue(new Error('failed to run installer: C:\\Users\\station'))
    mocks.check.mockResolvedValue(update)
    renderCard()
    await pressCheck()

    fireEvent.click(screen.getByTestId('dev-update-install'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('dev-update-confirm'))

    await waitFor(() => expect(screen.getByText(/تعذّر تثبيت التحديث/)).toBeInTheDocument())
    // The manager never sees the raw failure or an internal path.
    expect(screen.queryByText(/C:\\Users/)).not.toBeInTheDocument()
    // Buttons are live again: the application is still perfectly usable.
    expect(screen.getByTestId('dev-update-check')).toBeEnabled()
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })

  it('reports a failed download without ever claiming success', async () => {
    const update = fakeUpdate('0.2.0')
    update.download.mockRejectedValue(new Error('signature verification failed: minisign'))
    mocks.check.mockResolvedValue(update)
    renderCard()
    await pressCheck()

    fireEvent.click(screen.getByTestId('dev-update-install'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('dev-update-confirm'))

    await waitFor(() => expect(screen.getByText(/تعذّر تثبيت التحديث/)).toBeInTheDocument())
    expect(screen.queryByTestId('dev-update-restarting')).not.toBeInTheDocument()
    expect(screen.getByTestId('dev-update-check')).toBeEnabled()
  })

  it('reports a restart failure separately from a failed update', async () => {
    const update = fakeUpdate('0.2.0')
    mocks.check.mockResolvedValue(update)
    mocks.relaunch.mockRejectedValue(new Error('no such process'))
    renderCard()
    await pressCheck()

    fireEvent.click(screen.getByTestId('dev-update-install'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('dev-update-confirm'))

    // The update DID install; only the respawn failed. Saying "update failed"
    // here would send a manager hunting for a problem that does not exist.
    await waitFor(() => expect(screen.getByText(/تعذّر إعادة تشغيل Station/)).toBeInTheDocument())
    expect(screen.queryByText(/تعذّر تثبيت التحديث/)).not.toBeInTheDocument()
  })
})
