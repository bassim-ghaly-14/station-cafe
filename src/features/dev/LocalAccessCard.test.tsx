import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { LocalAccessCard } from './LocalAccessCard'
import { ToastProvider } from '@/components/ui'
import { localAccessApi } from '@/services/localAccessApi'

vi.mock('@/services/localAccessApi', () => ({
  localAccessApi: { load: vi.fn() },
}))

const access = {
  url: 'http://192.168.1.50:47821/api/v1/health',
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
  port: 47821,
  host: '192.168.1.50',
  otherHosts: ['10.0.0.9'],
  discoveryActive: true,
  apiRunning: true,
}

/** The card toasts, so it renders inside the shared provider like the
 *  other Dev Settings cards do. */
const renderCard = () =>
  render(
    <ToastProvider>
      <LocalAccessCard />
    </ToastProvider>,
  )

describe('LocalAccessCard', () => {
  beforeEach(() => {
    vi.mocked(localAccessApi.load).mockReset()
  })

  it('shows the exact URL the backend produced', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(access)
    renderCard()
    // The URL is displayed verbatim — built in Rust, never re-assembled here,
    // so what the manager reads is exactly what the QR encodes.
    await waitFor(() =>
      expect(screen.getByTestId('dev-local-access-url').textContent).toBe(access.url),
    )
  })

  it('renders the QR from the URL the backend returned', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(access)
    renderCard()
    const qr = await screen.findByTestId('dev-local-access-qr')
    const src = qr.getAttribute('src') ?? ''
    // An inline data: image — permitted by the production CSP (img-src data:),
    // with no external fetch and no network dependency.
    expect(src.startsWith('data:image/svg+xml;utf8,')).toBe(true)
    expect(decodeURIComponent(src)).toContain('<svg')
  })

  it('states in Arabic that scanning does NOT sign the user in', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(access)
    renderCard()
    // The most important string on the card: a QR must not read as a login.
    expect(await screen.findByText(/مسح الرمز لا يسجّل الدخول/)).toBeInTheDocument()
  })

  it('uses the Arabic translation for its heading', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(access)
    renderCard()
    await waitFor(() => expect(screen.getByText('الوصول المحلي عبر الشبكة')).toBeInTheDocument())
  })

  it('warns when the local API is not running', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue({ ...access, apiRunning: false })
    renderCard()
    // A QR that cannot be reached is worse than none, so this must be visible.
    await screen.findByTestId('dev-local-access-off')
  })

  it('offers the IP fallback addresses', async () => {
    vi.mocked(localAccessApi.load).mockResolvedValue(access)
    renderCard()
    await waitFor(() => expect(screen.getByText('10.0.0.9')).toBeInTheDocument())
  })

  it('does not crash when the backend refuses the request', async () => {
    vi.mocked(localAccessApi.load).mockRejectedValue(new Error('forbidden'))
    renderCard()
    // A non-MANAGER gets an error toast, not a crash and not a QR.
    await waitFor(() => expect(localAccessApi.load).toHaveBeenCalled())
    expect(screen.queryByTestId('dev-local-access-qr')).not.toBeInTheDocument()
  })

  it('does not add a credential to the address it displays', async () => {
    // The frontend neither builds nor sanitises the URL: the guarantee is
    // structural and lives in network::qr::access_url, which cannot emit a
    // query string. This test pins that the card adds nothing of its own.
    vi.mocked(localAccessApi.load).mockResolvedValue(access)
    renderCard()
    const shown = await screen.findByTestId('dev-local-access-url')
    expect(shown.textContent).not.toMatch(/[?#@]/)
    expect(shown.textContent).toBe(access.url)
  })
})
