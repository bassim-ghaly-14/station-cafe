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
  url: 'http://192.168.1.61:47821/api/v1/health',
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
  apiRunning: true,
  error: null,
  port: 47821,
  host: '192.168.1.61',
  otherHosts: ['10.0.0.9'],
  discoveryActive: true,
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
    await screen.findByText('الخدمة متوقفة. فعّلها لعرض رمز الوصول.')
  })

  it('reports a failure when enabled but not running', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(notRunning)
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(enabled)
    renderCard()
    // `enabled: true` with `running: false` is reported honestly.
    await screen.findByText('مفعّمة لكنها لم تبدأ. تحقق من المنفذ ثم أعد المحاولة.')
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
      expect(localAccessApi.save).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      ),
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
})
  it('states in Arabic that scanning does NOT sign the user in', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(running)
    vi.mocked(localAccessApi.getConfig).mockResolvedValue(enabled)
    renderCard()
    // The most important string on the card: a QR must not read as a login.
    expect(await screen.findByText(/مسح الرمز لا يسجّل الدخول/)).toBeInTheDocument()
  })
