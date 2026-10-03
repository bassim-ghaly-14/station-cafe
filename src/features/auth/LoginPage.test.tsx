/**
 * The login screen is where the account picker and the PIN policy meet, so
 * these tests assert the four things that actually matter:
 *
 *  1. the cards come from the BACKEND list, not a hardcoded array;
 *  2. selecting a card stores ONLY the identity and never a credential, and
 *     switching clears the PIN;
 *  3. the field cannot hold a sixth digit, a letter, or a pasted hybrid;
 *  4. signing in still goes through the real `login` command with the selected
 *     name — the picker grants nothing by itself.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import LoginPage from './LoginPage'

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  loginAccounts: vi.fn(),
}))

vi.mock('./useSession', () => ({
  useSession: () => ({ login: mocks.login }),
}))

vi.mock('@/services/authApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/authApi')>()
  return { ...original, authApi: { loginAccounts: mocks.loginAccounts } }
})

const ACCOUNTS = [
  { id: 1, name: 'Bassam', role: 'ADMIN' },
  { id: 2, name: 'Belly', role: 'ADMIN' },
  { id: 3, name: 'amira', role: 'MANAGER' },
  { id: 4, name: 'momo', role: 'STAFF' },
]

const pin = () => screen.getByLabelText(i18n.t('auth.credential')) as HTMLInputElement

async function renderPage() {
  render(<LoginPage />)
  await waitFor(() => expect(mocks.loginAccounts).toHaveBeenCalled())
  await screen.findByTestId('login-account-1')
}

beforeEach(() => {
  i18n.changeLanguage(DEFAULT_LOCALE)
  mocks.login.mockReset().mockResolvedValue(undefined)
  mocks.loginAccounts.mockReset().mockResolvedValue(ACCOUNTS)
})

describe('the account picker', () => {
  it('renders the accounts the backend returned, with an avatar and a name', async () => {
    await renderPage()

    for (const account of ACCOUNTS) {
      const card = screen.getByTestId(`login-account-${account.id}`)
      expect(within(card).getByText(account.name)).toBeInTheDocument()
      // The EXISTING role avatar, fed the real role — not a new visual system.
      expect(within(card).getByTestId('employee-avatar')).toHaveAttribute(
        'data-employee-role',
        account.role,
      )
    }
  })

  it('offers no username field — the account IS the identity', async () => {
    await renderPage()

    expect(screen.queryByLabelText(i18n.t('auth.name'))).not.toBeInTheDocument()
    expect(screen.queryByLabelText(i18n.t('auth.password'))).not.toBeInTheDocument()
  })

  it('marks the selected account, and states the selection in words', async () => {
    await renderPage()

    const summary = screen.getByTestId('login-selected-account')
    expect(summary).toHaveTextContent(i18n.t('auth.noAccountSelected'))

    fireEvent.click(screen.getByTestId('login-account-2'))

    expect(screen.getByTestId('login-account-2')).toHaveAttribute('aria-pressed', 'true')
    // The previously selected card is no longer marked.
    expect(screen.getByTestId('login-account-1')).toHaveAttribute('aria-pressed', 'false')
    expect(summary).toHaveTextContent('Belly')
  })

  it('clears the PIN when the account is switched', async () => {
    await renderPage()

    fireEvent.click(screen.getByTestId('login-account-1'))
    fireEvent.change(pin(), { target: { value: '1234' } })
    expect(pin().value).toBe('1234')

    fireEvent.click(screen.getByTestId('login-account-3'))

    // A credential left on screen under another person's name is exactly the
    // confusion this screen exists to remove.
    expect(pin().value).toBe('')
  })

  it('signs in through the real login command with the selected account', async () => {
    await renderPage()

    fireEvent.click(screen.getByTestId('login-account-1'))
    fireEvent.change(pin(), { target: { value: '55555' } })
    fireEvent.submit(pin().closest('form') as HTMLFormElement)

    await waitFor(() => expect(mocks.login).toHaveBeenCalledWith('Bassam', '55555'))
  })

  it('refuses to submit before an account is chosen', async () => {
    await renderPage()

    fireEvent.change(pin(), { target: { value: '55555' } })
    fireEvent.submit(pin().closest('form') as HTMLFormElement)

    expect(mocks.login).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('auth.selectAccountRequired'))
  })

  it('never renders anything that looks like a stored credential', async () => {
    await renderPage()

    fireEvent.click(screen.getByTestId('login-account-2'))
    fireEvent.change(pin(), { target: { value: '2214' } })

    // The field is a password field, and no card carries a credential.
    expect(pin().type).toBe('password')
    for (const account of ACCOUNTS) {
      expect(screen.getByTestId(`login-account-${account.id}`)).not.toHaveTextContent('2214')
    }
  })

  it('sends the account identifier EXACTLY as the backend spelled it', async () => {
    await renderPage()

    // The authentication identifier is the `users.name` the backend returned.
    // It is never re-cased, trimmed, normalized or reconstructed from the text
    // on screen, because a transformation here would produce an identifier the
    // repository's exact-match lookup could never find — an account that is
    // listed on the picker and can never be signed into. Asserted against the
    // verbatim string for each account, including the mixed-case ones.
    for (const account of ACCOUNTS) {
      mocks.login.mockClear()
      fireEvent.click(screen.getByTestId(`login-account-${account.id}`))
      fireEvent.change(pin(), { target: { value: '2214' } })
      fireEvent.submit(pin().closest('form') as HTMLFormElement)

      await waitFor(() => expect(mocks.login).toHaveBeenCalledTimes(1))
      const [sentName, sentPin] = mocks.login.mock.calls[0]
      // The strongest available statement: what went out is byte-for-byte the
      // name the backend sent, for a lower-case, a Capitalised and an
      // all-lower-case account alike.
      expect(sentName).toBe(account.name)
      expect(sentName).toBe(sentName.trim())
      expect(sentPin).toBe('2214')
    }

    // And the mixed-case account specifically: a lower-casing bug anywhere
    // between the payload and the repository would turn "Belly" into "belly"
    // and no lookup could ever find it again.
    expect(ACCOUNTS.map((a) => a.name)).toContain('Belly')
  })

  it('shows the selected account as the backend spelled it', async () => {
    await renderPage()

    // "Belly" is mixed case, so this fails loudly if the summary line ever
    // title-cases, lower-cases or otherwise massages the name it displays.
    fireEvent.click(screen.getByTestId('login-account-2'))

    const summary = screen.getByTestId('login-selected-account')
    expect(summary).toHaveTextContent('Belly')
    expect(summary).not.toHaveTextContent('belly')
  })

  it('explains an empty roster instead of showing an empty grid', async () => {
    mocks.loginAccounts.mockResolvedValue([])
    render(<LoginPage />)

    expect(await screen.findByText(i18n.t('auth.noAccounts'))).toBeInTheDocument()
  })
})

describe('the PIN field', () => {
  it('keeps only digits', async () => {
    await renderPage()
    fireEvent.click(screen.getByTestId('login-account-1'))

    fireEvent.change(pin(), { target: { value: 'a1b2' } })
    expect(pin().value).toBe('12')

    fireEvent.change(pin(), { target: { value: '1-2 3' } })
    expect(pin().value).toBe('123')
  })

  it('refuses a sixth digit — the field can never hold one', async () => {
    await renderPage()
    fireEvent.click(screen.getByTestId('login-account-1'))

    fireEvent.change(pin(), { target: { value: '123456' } })
    expect(pin().value).toBe('12345')

    // Typing onto a full field changes nothing either.
    fireEvent.change(pin(), { target: { value: '1234567' } })
    expect(pin().value).toBe('12345')
  })

  it('normalizes a pasted value that carries separators or extra digits', async () => {
    await renderPage()
    fireEvent.click(screen.getByTestId('login-account-1'))

    fireEvent.paste(pin(), { clipboardData: { getData: () => '2214-7788' } })

    expect(pin().value).toBe('22147')
  })

  it('asks for a numeric keyboard and hides the digits', async () => {
    await renderPage()

    expect(pin().inputMode).toBe('numeric')
    expect(pin().type).toBe('password')
  })

  it('rejects a too-short PIN before it reaches the backend', async () => {
    await renderPage()
    fireEvent.click(screen.getByTestId('login-account-1'))

    fireEvent.change(pin(), { target: { value: '123' } })
    fireEvent.submit(pin().closest('form') as HTMLFormElement)

    expect(mocks.login).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      i18n.t('auth.credentialFormat', { min: 4, max: 5 }),
    )
  })

  it('accepts both a four and a five digit PIN', async () => {
    await renderPage()

    fireEvent.click(screen.getByTestId('login-account-1'))
    fireEvent.change(pin(), { target: { value: '1234' } })
    fireEvent.submit(pin().closest('form') as HTMLFormElement)
    await waitFor(() => expect(mocks.login).toHaveBeenCalledWith('Bassam', '1234'))

    fireEvent.click(screen.getByTestId('login-account-2'))
    fireEvent.change(pin(), { target: { value: '55555' } })
    fireEvent.submit(pin().closest('form') as HTMLFormElement)
    await waitFor(() => expect(mocks.login).toHaveBeenCalledWith('Belly', '55555'))
  })
})

/**
 * The visibility toggle is NOT login-specific: the field is the shared
 * `PinInput`, which renders the shared `PasswordInput`, so the reveal here is
 * the same control — and the same state — used by the employee dialog. These
 * tests assert the INTEGRATION (the screen really exposes it, and revealing a
 * PIN never signs anyone in), because a working component nobody renders would
 * still look like a removed feature.
 */
describe('the credential reveal toggle', () => {
  it('reveals the typed PIN, re-masks it, and keeps the value intact', async () => {
    await renderPage()
    fireEvent.click(screen.getByTestId('login-account-1'))
    fireEvent.change(pin(), { target: { value: '2214' } })

    const show = screen.getByRole('button', { name: i18n.t('auth.showPassword') })
    expect(pin().type).toBe('password')

    fireEvent.click(show)
    expect(pin().type).toBe('text')
    expect(pin().value).toBe('2214')
    // The eye now offers the opposite action, named in words.
    expect(screen.getByRole('button', { name: i18n.t('auth.hidePassword') })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.hidePassword') }))
    expect(pin().type).toBe('password')
    expect(pin().value).toBe('2214')
  })

  it('does not submit the form — revealing a credential is not signing in', async () => {
    await renderPage()
    fireEvent.click(screen.getByTestId('login-account-1'))
    fireEvent.change(pin(), { target: { value: '2214' } })

    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.showPassword') }))

    expect(mocks.login).not.toHaveBeenCalled()
  })

  it('still signs in with the same PIN after it has been revealed', async () => {
    await renderPage()
    fireEvent.click(screen.getByTestId('login-account-1'))
    fireEvent.change(pin(), { target: { value: '2214' } })

    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.showPassword') }))
    fireEvent.submit(pin().closest('form') as HTMLFormElement)

    // Presentation only: the revealed value is the same string, sent as before.
    await waitFor(() => expect(mocks.login).toHaveBeenCalledWith('Bassam', '2214'))
  })
})
