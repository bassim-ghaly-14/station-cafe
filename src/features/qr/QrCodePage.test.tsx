/**
 * The Station QR Code page.
 *
 * What these tests hold in place
 * ------------------------------
 *  - It READS the existing `local_access_qr` command. The page owns no encoding,
 *    no URL building and no second cache: a code shown here is the code the
 *    backend produced, and the test asserts that document is what is rendered.
 *  - It is a VIEWER. There is no activation control anywhere on it, which is
 *    asserted directly — a `localAccessApi.save`/`getConfig` call or an enable
 *    button on this page would be Dev Settings leaking into a destination every
 *    role can open.
 *  - Its four states each have their own presentation: loading, backend failure
 *    (the project's `ErrorState`, with a retry), service not running, and the
 *    code itself. A stopped service must never render a scannable-looking code.
 *  - The security wording travels with the code: scanning it is not a sign-in.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import QrCodePage from './QrCodePage'
import { ToastProvider } from '@/components/ui'
import { localAccessApi } from '@/services/localAccessApi'

vi.mock('@/services/localAccessApi', () => ({
  localAccessApi: { load: vi.fn(), getConfig: vi.fn(), save: vi.fn(), status: vi.fn() },
}))

/** A running service: a listener exists, so there is a URL and a QR. */
const running = {
  // THE canonical friendly URL. The backend advertises `station.local` over
  // mDNS, so this is what the QR encodes and what the page displays.
  url: 'http://station.local:47821/',
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
  apiRunning: true,
  error: null,
  port: 47821,
  host: '192.168.1.61',
  otherHosts: ['10.0.0.9'],
  discoveryActive: true,
  hostname: 'station.local',
  friendlyUrl: 'http://station.local:47821/',
  // The guarantee for a device that cannot resolve `.local`.
  fallbackUrl: 'http://192.168.1.61:47821/',
}

/**
 * Multicast blocked: the listener is up but nothing advertises the name, so the
 * backend deliberately falls back to the IP rather than claiming a hostname
 * that no phone can resolve.
 */
const noDiscovery = {
  ...running,
  url: 'http://192.168.1.61:47821/',
  discoveryActive: false,
  hostname: null,
  friendlyUrl: null,
  fallbackUrl: 'http://192.168.1.61:47821/',
}

/** Nothing is listening, so there is no address to encode. */
const stopped = {
  ...running,
  url: null,
  svg: null,
  apiRunning: false,
  error: 'disabled',
  host: null,
  otherHosts: [],
  discoveryActive: false,
  hostname: null,
  friendlyUrl: null,
  fallbackUrl: null,
}

/**
 * The page toasts on copy, so it renders inside the project's own provider —
 * never a bespoke harness.
 */
const renderPage = () =>
  render(
    <ToastProvider>
      <QrCodePage />
    </ToastProvider>,
  )

describe('QrCodePage', () => {
  beforeEach(() => {
    vi.mocked(localAccessApi.load).mockReset()
    vi.mocked(localAccessApi.getConfig).mockReset()
    vi.mocked(localAccessApi.save).mockReset()
  })

  it('reads the code from the existing local-access command', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    renderPage()
    await waitFor(() => expect(localAccessApi.load).toHaveBeenCalledTimes(1))
  })

  it('renders the exact SVG the backend produced', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    renderPage()
    const img = await screen.findByTestId('qr-code-image')
    const src = img.getAttribute('src') ?? ''
    // Inline `data:` document, byte-for-byte the backend's — no re-encoding.
    const prefix = 'data:image/svg+xml;utf8,'
    expect(src.startsWith(prefix)).toBe(true)
    expect(decodeURIComponent(src.slice(prefix.length))).toBe(running.svg)
  })

  it('shows the address the code points at, and that it is not a sign-in', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    renderPage()
    // Displayed verbatim: the URL is built in Rust and never re-assembled here.
    expect(await screen.findByTestId('qr-code-url')).toHaveTextContent(running.url)
    // Still the most important sentence on the card.
    expect(await screen.findByText(/مسح الرمز لا يسجّل الدخول/)).toBeInTheDocument()
  })

  it('shows no code at all when the service is not running', async () => {
    // A QR that scans and then fails is worse than no QR: the page says the
    // service is unavailable instead of rendering a dead address.
    vi.mocked(localAccessApi.load).mockResolvedValue(stopped)
    renderPage()
    expect(await screen.findByTestId('qr-code-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('qr-code-image')).not.toBeInTheDocument()
    expect(screen.queryByTestId('qr-code-url')).not.toBeInTheDocument()
  })

  it('reports a backend failure through the shared error state, not an alert', async () => {
    vi.mocked(localAccessApi.load).mockRejectedValue(new Error('internal_error'))
    renderPage()
    const alert = await screen.findByRole('alert')
    expect(alert).toBeInTheDocument()
    expect(screen.queryByTestId('qr-code-image')).not.toBeInTheDocument()
  })

  it('exposes no service activation control', async () => {
    // The separation that matters: this destination is a viewer. Enabling or
    // disabling the local service stays a Dev Settings action, so neither the
    // write call nor the configuration read may happen here.
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    renderPage()
    await screen.findByTestId('qr-code-image')
    expect(localAccessApi.save).not.toHaveBeenCalled()
    expect(localAccessApi.getConfig).not.toHaveBeenCalled()
    expect(screen.queryByTestId('dev-local-access-toggle')).not.toBeInTheDocument()
  })

  it('shows the canonical friendly URL, not an independently rebuilt one', async () => {
    // THE QR CONTRACT: the page displays `access.url` verbatim. If it ever
    // assembled a URL from `host`/`port` itself it could point somewhere the
    // code does not open — and it never would, because both come from Rust.
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    renderPage()
    const shown = await screen.findByTestId('qr-code-url')
    expect(shown.textContent).toBe('http://station.local:47821/')
    expect(shown.textContent).toBe(running.url)
    expect(shown.textContent).not.toContain('192.168.1.61')
  })

  it('keeps the IP reachable as a secondary diagnostic line', async () => {
    // The fallback is shown, not hidden, but never as a competing address: the
    // label says which one is which.
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    renderPage()
    const fallback = await screen.findByTestId('qr-code-fallback')
    expect(fallback.textContent).toContain('http://192.168.1.61:47821/')
  })

  it('copies the same URL the QR encodes', async () => {
    // What a manager pastes into a phone must be what scanning the code opens.
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    renderPage()
    fireEvent.click(await screen.findByTestId('qr-code-copy'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(running.url))
  })

  it('falls back to the IP when mDNS is not advertising a name', async () => {
    // Graceful degradation on the UI side too: no hostname is claimed, and the
    // address a phone can definitely open is what is shown and encoded.
    vi.mocked(localAccessApi.load).mockResolvedValue(noDiscovery)
    renderPage()
    const shown = await screen.findByTestId('qr-code-url')
    expect(shown.textContent).toBe('http://192.168.1.61:47821/')
    // Nothing on the page may promise a name nothing advertises.
    expect(screen.queryByText(/station\.local/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('qr-code-fallback')).not.toBeInTheDocument()
  })

  it('never resolves a hostname in the browser', async () => {
    // Resolution belongs to the OS/mDNS stack, never to JavaScript. A frontend
    // lookup would fail on a cafe with no DNS and would be a network dependency
    // on a LAN app. Asserted structurally: the page fetches nothing but the
    // single command.
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    renderPage()
    await screen.findByTestId('qr-code-image')
    expect(localAccessApi.load).toHaveBeenCalledTimes(1)
    expect(localAccessApi.status).not.toHaveBeenCalled()
  })
})
