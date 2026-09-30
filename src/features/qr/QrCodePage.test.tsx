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
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import QrCodePage from './QrCodePage'
import { localAccessApi } from '@/services/localAccessApi'

vi.mock('@/services/localAccessApi', () => ({
  localAccessApi: { load: vi.fn(), getConfig: vi.fn(), save: vi.fn(), status: vi.fn() },
}))

/** A running service: a listener exists, so there is a URL and a code. */
const running = {
  url: 'http://192.168.1.61:47821/',
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
  apiRunning: true,
  error: null,
  port: 47821,
  host: '192.168.1.61',
  otherHosts: ['10.0.0.9'],
  discoveryActive: true,
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
}

describe('QrCodePage', () => {
  beforeEach(() => {
    vi.mocked(localAccessApi.load).mockReset()
    vi.mocked(localAccessApi.getConfig).mockReset()
    vi.mocked(localAccessApi.save).mockReset()
  })

  it('reads the code from the existing local-access command', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    render(<QrCodePage />)
    await waitFor(() => expect(localAccessApi.load).toHaveBeenCalledTimes(1))
  })

  it('renders the exact SVG the backend produced', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    render(<QrCodePage />)
    const img = await screen.findByTestId('qr-code-image')
    const src = img.getAttribute('src') ?? ''
    // Inline `data:` document, byte-for-byte the backend's — no re-encoding.
    const prefix = 'data:image/svg+xml;utf8,'
    expect(src.startsWith(prefix)).toBe(true)
    expect(decodeURIComponent(src.slice(prefix.length))).toBe(running.svg)
  })

  it('shows the address the code points at, and that it is not a sign-in', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    render(<QrCodePage />)
    // Displayed verbatim: the URL is built in Rust and never re-assembled here.
    expect(await screen.findByTestId('qr-code-url')).toHaveTextContent(running.url)
    // Still the most important sentence on the card.
    expect(await screen.findByText(/مسح الرمز لا يسجّل الدخول/)).toBeInTheDocument()
  })

  it('shows no code at all when the service is not running', async () => {
    // A QR that scans and then fails is worse than no QR: the page says the
    // service is unavailable instead of rendering a dead address.
    vi.mocked(localAccessApi.load).mockResolvedValue(stopped)
    render(<QrCodePage />)
    expect(await screen.findByTestId('qr-code-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('qr-code-image')).not.toBeInTheDocument()
    expect(screen.queryByTestId('qr-code-url')).not.toBeInTheDocument()
  })

  it('reports a backend failure through the shared error state, not an alert', async () => {
    vi.mocked(localAccessApi.load).mockRejectedValue(new Error('internal_error'))
    render(<QrCodePage />)
    const alert = await screen.findByRole('alert')
    expect(alert).toBeInTheDocument()
    expect(screen.queryByTestId('qr-code-image')).not.toBeInTheDocument()
  })

  it('exposes no service activation control', async () => {
    // The separation that matters: this destination is a viewer. Enabling or
    // disabling the local service stays a Dev Settings action, so neither the
    // write call nor the configuration read may happen here.
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    render(<QrCodePage />)
    await screen.findByTestId('qr-code-image')
    expect(localAccessApi.save).not.toHaveBeenCalled()
    expect(localAccessApi.getConfig).not.toHaveBeenCalled()
    expect(screen.queryByTestId('dev-local-access-toggle')).not.toBeInTheDocument()
  })
})
