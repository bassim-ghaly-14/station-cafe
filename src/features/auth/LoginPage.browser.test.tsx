/**
 * THE QR LOGIN PATH: the account picker over the BROWSER transport.
 *
 * The desktop suite in `LoginPage.test.tsx` mocks `authApi` and therefore proves
 * nothing about what a phone actually receives. This suite keeps the REAL
 * transport and the REAL `authApi`, so it exercises the chain a manager performs
 * after scanning the QR code:
 *
 *   LoginPage → authApi.loginAccounts() → callPublic → POST /api/v1/cmd/…
 *
 * The backend side of this chain is pinned in Rust, by
 * `network::server::tests::only_the_public_commands_run_without_a_session`,
 * which asserts `list_login_accounts` is reachable with NO session token.
 * Between that Rust pin and this one, the account list a phone sees is covered
 * without standing up a database.
 *
 * The defect these tests pin: this command was authenticated at the HTTP layer,
 * so the phone got a 401, `callPublic` surfaced it as `loadError`, and the page
 * rendered an error where the picker should have been. The desktop worked the
 * whole time, which is exactly what made it look like a CSS problem.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import LoginPage from './LoginPage'
import { SessionProvider } from './useSession'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const fetchMock = vi.fn()

/** The roster a real cafe offers: one per eligible login, in backend order. */
const ACCOUNTS = [
  { id: 1, name: 'Bassam', role: 'ADMIN' },
  { id: 2, name: 'Belly', role: 'ADMIN' },
  { id: 3, name: 'amira', role: 'MANAGER' },
]

/** The screen under test, inside the REAL session provider — no auth mock. */
function renderScreen() {
  render(
    <SessionProvider>
      <LoginPage />
    </SessionProvider>,
  )
}

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}

/** Answer the one command the login screen issues on load. */
function serve(accounts: unknown, status = 200) {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).endsWith('/list_login_accounts'))
      return Promise.resolve(reply(status, accounts))
    return Promise.resolve(reply(200, null))
  })
}

const pin = () => screen.getByLabelText(i18n.t('auth.credential')) as HTMLInputElement

/** The parsed request body of the LAST call to `command`, or undefined. */
function bodyOf(command: string): unknown {
  const calls = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith(command))
  const last = calls.at(-1)
  if (!last) return undefined
  return JSON.parse(String((last[1] as RequestInit).body))
}

beforeEach(() => {
  // Opt out of the desktop default: this suite IS the phone.
  delete window.__TAURI_INTERNALS__
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  invoke.mockReset()
  localStorage.clear()
  i18n.changeLanguage(DEFAULT_LOCALE)
  serve(ACCOUNTS)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the QR / local-access login screen', () => {
  it('asks the LAN bridge for the eligible accounts', async () => {
    renderScreen()
    await screen.findByTestId('login-account-1')

    // The real command, by name, over the browser transport.
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls).toContain('/api/v1/cmd/list_login_accounts')

    // Unauthenticated, exactly like `login`: no bearer token is sent, because
    // there is no session yet — that IS the state this page loads in.
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/list_login_accounts'))
    const init = call?.[1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('shows a selector for every account the backend returned', async () => {
    renderScreen()
    await screen.findByTestId('login-account-1')

    for (const account of ACCOUNTS) {
      expect(screen.getByTestId(`login-account-${account.id}`)).toBeInTheDocument()
    }
    // Nothing beyond them: the ids the backend sent are preserved exactly, and
    // no inactive or unauthorised account was invented locally. Scoped to the
    // rail, because the PIN reveal toggle is a toggle button too.
    const rail = within(screen.getByTestId('login-account-rail'))
    expect(rail.getAllByRole('button', { pressed: false })).toHaveLength(ACCOUNTS.length)
  })

  it('lays the accounts out in ONE horizontal row, not a grid', async () => {
    renderScreen()
    await screen.findByTestId('login-account-1')

    const rail = screen.getByTestId('login-account-rail')
    const track = rail.firstElementChild as HTMLElement
    // Every account is a direct child of the ONE track, in DOM order.
    expect(track.children).toHaveLength(ACCOUNTS.length)
    expect([...track.children].map((child) => child.getAttribute('data-testid'))).toEqual(
      ACCOUNTS.map((account) => `login-account-${account.id}`),
    )
    // A `grid` here would be the regression: the rail is a flex ROW.
    expect(track.className).toContain('flex')
    expect(track.className).not.toContain('grid')
    // Overflow is contained by the rail, so the PAGE never scrolls sideways.
    expect(rail.className).toContain('overflow-hidden')
  })

  it('marks the chosen account, and states the choice in words', async () => {
    renderScreen()
    await screen.findByTestId('login-account-1')

    fireEvent.click(screen.getByTestId('login-account-2'))

    expect(screen.getByTestId('login-account-2')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('login-account-1')).toHaveAttribute('aria-pressed', 'false')
    // Selection is never carried by scale alone.
    expect(screen.getByTestId('login-selected-account')).toHaveTextContent('Belly')
  })

  it('still reaches the login command over the LAN bridge', async () => {
    renderScreen()
    await screen.findByTestId('login-account-1')

    fireEvent.click(screen.getByTestId('login-account-1'))
    fireEvent.change(pin(), { target: { value: '1234' } })
    fireEvent.submit(pin().closest('form') as HTMLFormElement)

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).endsWith('/api/v1/cmd/login')),
      ).toBe(true),
    )
    // The selection goes to the REAL login command, carrying the chosen NAME
    // and nothing else: the rail changed how the account is chosen, not what
    // authenticates.
    expect(bodyOf('/cmd/login')).toEqual({
      input: { name: 'Bassam', password: '1234' },
    })
  })

  it('reports a refused account read rather than claiming there are no accounts', async () => {
    serve({ kind: 'unauthorized', message: 'auth.forbidden' }, 403)
    renderScreen()

    // An empty roster and a FAILED roster are different states. Conflating them
    // is how "there are no accounts" became the visible symptom of a 401.
    await waitFor(() => expect(screen.queryByTestId('login-account-1')).not.toBeInTheDocument())
    expect(screen.queryByText(i18n.t('auth.noAccounts'))).not.toBeInTheDocument()
  })
})
