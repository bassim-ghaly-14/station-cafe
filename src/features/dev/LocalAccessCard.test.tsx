import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LocalAccessCard } from './LocalAccessCard'
import { ToastProvider } from '@/components/ui'
import { localAccessApi } from '@/services/localAccessApi'

vi.mock('@/services/localAccessApi', () => ({
  localAccessApi: { load: vi.fn(), getConfig: vi.fn(), save: vi.fn() },
}))

/** A running service: there is a listener, so there is a URL and a QR. */
const running = {
  // THE canonical friendly URL, identical to the one the QR Code page shows.
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
  fallbackUrl: 'http://192.168.1.61:47821/',
}

/** Multicast blocked: the listener runs, but no name is advertised. */
const noDiscovery = {
  ...running,
  url: 'http://192.168.1.61:47821/',
  discoveryActive: false,
  hostname: null,
  friendlyUrl: null,
}

/** The defect's symptom: enabled in the settings, but nothing listening. */
const notRunning = {
  ...running,
  url: null,
  svg: null,
  apiRunning: false,
  error: 'bind_failed',
  host: null,
  otherHosts: [],
  discoveryActive: false,
  hostname: null,
  friendlyUrl: null,
  fallbackUrl: null,
}

const enabled = { enabled: true, bind: 'lan', port: 47821 }
const disabled = { enabled: false, bind: 'lan', port: 47821 }

const renderCard = () =>
  render(
    <ToastProvider>
      <LocalAccessCard />
    </ToastProvider>,
  )

describe('LocalAccessCard', () => {
  beforeEach(() => {
    vi.mocked(localAccessApi.load).mockReset()
    vi.mocked(localAccessApi.getConfig).mockReset()
    vi.mocked(localAccessApi.save).mockReset()
  })

  it('shows the exact URL the backend produced', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(enabled)
    renderCard()
    // Displayed verbatim — built in Rust, never re-assembled here.
    await waitFor(() =>
      expect(screen.getByTestId('dev-local-access-url').textContent).toBe(running.url),
    )
  })

  it('renders the QR from the URL the backend returned', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(enabled)
    renderCard()
    const qr = await screen.findByTestId('dev-local-access-qr')
    const src = qr.getAttribute('src') ?? ''
    // Inline data: image — permitted by the production CSP, no external fetch.
    expect(src.startsWith('data:image/svg+xml;utf8,')).toBe(true)
    expect(decodeURIComponent(src)).toContain('<svg')
  })

  it('hides the QR entirely when the service is not running', async () => {
    // The defect: an address was displayed for a server that did not exist.
    // A stopped service now shows no QR and no URL at all.
    vi.mocked(localAccessApi.load).mockResolvedValue(notRunning)
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(enabled)
    renderCard()
    await waitFor(() => expect(localAccessApi.load).toHaveBeenCalled())
    expect(screen.queryByTestId('dev-local-access-qr')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dev-local-access-url')).not.toBeInTheDocument()
  })

  it('distinguishes disabled from enabled-but-failed', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(notRunning)
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(disabled)
    renderCard()
    // Configured off: a clear instruction, not a failure message.
    const message = await screen.findByText('الخدمة متوقفة. فعّلها لعرض رمز الوصول.')
    expect(message).toBeInTheDocument()
    // The distinction under test: "off" must never read as "failed".
    expect(
      screen.queryByText('مفعّمة لكنها لم تبدأ. تحقق من المنفذ ثم أعد المحاولة.'),
    ).not.toBeInTheDocument()
  })

  it('reports a failure when enabled but not running', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(notRunning)
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(enabled)
    renderCard()
    // `enabled: true` with `running: false` is reported honestly.
    const failure = await screen.findByText('مفعّمة لكنها لم تبدأ. تحقق من المنفذ ثم أعد المحاولة.')
    expect(failure).toBeInTheDocument()
    // A failed bind is not the same message as "switched off".
    expect(screen.queryByText('الخدمة متوقفة. فعّلها لعرض رمز الوصول.')).not.toBeInTheDocument()
  })

  it('enabling calls save so the backend actually starts the server', async () => {
    // This is the missing call that caused the whole defect: without it the
    // setting was stored by nothing and the API could never be switched on.
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(disabled)
    vi.mocked(localAccessApi.save).mockResolvedValue({
      enabled: true,
      running: true,
      address: '192.168.1.61:47821',
      error: null,
    })
    renderCard()
    fireEvent.click(await screen.findByTestId('dev-local-access-toggle'))
    await waitFor(() => expect(localAccessApi.save).toHaveBeenCalledWith(enabled))
  })

  it('disabling calls save with enabled false', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(enabled)
    vi.mocked(localAccessApi.save).mockResolvedValue({
      enabled: false,
      running: false,
      address: null,
      error: 'disabled',
    })
    renderCard()
    fireEvent.click(await screen.findByTestId('dev-local-access-toggle'))
    await waitFor(() =>
      expect(localAccessApi.save).toHaveBeenCalledWith(expect.objectContaining({ enabled: false })),
    )
  })

  it('does not crash when the backend refuses the request', async () => {
    vi.mocked(localAccessApi.load).mockRejectedValue(new Error('forbidden'))
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(disabled)
    renderCard()
    await waitFor(() => expect(localAccessApi.load).toHaveBeenCalled())
    expect(screen.queryByTestId('dev-local-access-qr')).not.toBeInTheDocument()
  })

  it('never renders a credential in the displayed address', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(enabled)
    renderCard()
    const shown = await screen.findByTestId('dev-local-access-url')
    // The frontend neither builds nor sanitises the URL: the guarantee is
    // structural and lives in network::qr::access_url. This pins that the card
    // adds nothing of its own.
    expect(shown.textContent).not.toMatch(/[?#@]/)
    expect(shown.textContent).toBe(running.url)
  })

  it('points at the local web app, not the health endpoint', async () => {
    // THE change: the QR must open the Station login screen in a browser. The
    // health endpoint used to be the destination, which showed raw JSON.
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(enabled)
    renderCard()
    const shown = await screen.findByTestId('dev-local-access-url')
    expect(shown.textContent).toBe('http://station.local:47821/')
    expect(shown.textContent).not.toContain('/api/v1/health')
  })

  it('shows the friendly hostname as the primary address', async () => {
    // THE DEV SETTINGS CONTRACT: the preferred local address is
    // `station.local:47821`, not the machine's IP.
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(enabled)
    renderCard()
    const shown = await screen.findByTestId('dev-local-access-url')
    expect(shown.textContent).toBe('http://station.local:47821/')
    // The displayed value is the backend's canonical URL, rebuilt by nobody.
    expect(shown.textContent).toBe(running.url)
  })

  it('keeps the LAN IP visible as a fallback, never replacing the name', async () => {
    // The IP remains available as a diagnostic/fallback value, exactly as it was
    // before — it is demoted, not deleted.
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(enabled)
    renderCard()
    const fallback = await screen.findByTestId('dev-local-access-fallback')
    expect(fallback.textContent).toContain('192.168.1.61:47821')
    // And it is secondary: the name is still the primary line.
    expect(screen.getByTestId('dev-local-access-url').textContent).toContain('station.local')
  })

  it('falls back to the IP when mDNS could not advertise the name', async () => {
    // Discovery failing must not break Dev Settings: the card shows the
    // reachable address and claims no hostname.
    vi.mocked(localAccessApi.load).mockResolvedValue(noDiscovery)
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(enabled)
    renderCard()
    const shown = await screen.findByTestId('dev-local-access-url')
    expect(shown.textContent).toBe('http://192.168.1.61:47821/')
    // No duplicate line: the displayed URL already IS the fallback.
    expect(screen.queryByTestId('dev-local-access-fallback')).not.toBeInTheDocument()
  })

  it('states what the QR opens, so the purpose is obvious', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(enabled)
    renderCard()
    expect(await screen.findByTestId('dev-local-access-name')).toHaveTextContent('Station Local')
  })

  it('states in Arabic that scanning does NOT sign the user in', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(enabled)
    renderCard()
    // Still the most important string on the card: opening the web app is not a
    // login, and the QR must never read as one.
    expect(await screen.findByText(/مسح الرمز لا يسجّل الدخول/)).toBeInTheDocument()
  })
})
