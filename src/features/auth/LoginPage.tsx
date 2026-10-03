/**
 * تسجيل الدخول — the station login screen (RTL, no browser alerts, accessible).
 *
 * # The flow
 *
 * Choose your account, then type your PIN. There is no username field, because
 * the person at the till knows their own face, not their own username spelling.
 *
 * # The account list is real data, never a hardcoded array
 *
 * The rail is fed by `list_login_accounts`, the existing `users` ⨝ `employees`
 * projection filtered to ACTIVE logins whose employee record is also ACTIVE. Two
 * consequences that matter: an INACTIVE employee never gets a card, so nobody is
 * offered a choice guaranteed to fail; and a person added on the Employees page
 * appears here on the next load, with no second list to keep in step.
 *
 * The desktop till and a phone that scanned the QR run this EXACT screen — the
 * LAN listener serves the same embedded bundle — so this file is also the QR
 * login screen. There is no second account source to fall out of step.
 *
 * # Selecting an account is NOT authentication
 *
 * This is the property worth stating plainly, because an account picker looks
 * like it could be one. The selection is only the string a user would otherwise
 * have typed into a username box. It is handed to the very same `auth::login`
 * command, which still verifies the Argon2id hash and still decides the session.
 * Picking somebody else's card gets an attacker no closer to a session than
 * typing that person's name did — they still have to know a 4–5 digit PIN.
 *
 * # The PIN field
 *
 * Four to five digits, shaped so that is hard to get wrong: non-digits are
 * stripped on every keystroke AND on paste, the value is capped at five, and the
 * keyboard is numeric. A sixth digit is therefore never held in state at all,
 * rather than being accepted and trimmed at submit time. The backend re-validates
 * all of it; this is immediate feedback, not the boundary.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Logo } from '@/components/branding/Logo'
import { ErrorState } from '@/components/states'
import { Button, Field, PinInput, Skeleton } from '@/components/ui'
import {
  CREDENTIAL_MAX_DIGITS,
  CREDENTIAL_MIN_DIGITS,
  authApi,
  isValidCredential,
  normalizeCredentialInput,
  type LoginAccount,
} from '@/services/authApi'
import { AccountSelector } from './AccountSelector'
import { useSession } from './useSession'

export default function LoginPage() {
  const { t } = useTranslation()
  const { login } = useSession()

  const [accounts, setAccounts] = useState<LoginAccount[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** The chosen account's NAME — the only identity this screen holds. */
  const [selected, setSelected] = useState<string | null>(null)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    authApi
      .loginAccounts()
      .then((result) => {
        if (!active) return
        setAccounts(result)
        setLoadError(null)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setLoadError((cause as { message?: string }).message ?? 'internal_error')
      })
    return () => {
      active = false
    }
  }, [])

  /**
   * Choose an account.
   *
   * The PIN is cleared on EVERY switch. A PIN left in the field after moving to
   * another card is a credential sitting on screen under someone else's name —
   * the exact confusion this screen exists to remove.
   */
  function select(name: string) {
    setSelected(name)
    setPin('')
    setFieldError(null)
    setFormError(null)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setFieldError(null)
    setFormError(null)

    if (!selected) {
      setFieldError(t('auth.selectAccountRequired'))
      return
    }
    if (!isValidCredential(pin)) {
      setFieldError(
        t('auth.credentialFormat', {
          min: CREDENTIAL_MIN_DIGITS,
          max: CREDENTIAL_MAX_DIGITS,
        }),
      )
      return
    }

    setBusy(true)
    try {
      // The selected name goes to the SAME `login` a typed username reached.
      await login(selected, pin)
    } catch (err) {
      const code = (err as { message?: string }).message ?? 'internal_error'
      setFormError(t([`errors.${code}`, 'errors.internal_error']))
    } finally {
      setBusy(false)
    }
  }

  // `accounts` is null ONLY while the first read is in flight, so narrowing it
  // once here lets the render below treat it as a real list without a
  // non-null assertion at every use.
  const list = accounts ?? []
  const loading = accounts === null && !loadError

  return (
    <main
      dir="rtl"
      className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-4"
    >
      <div className="flex flex-col items-center gap-3">
        <Logo size={88} />
        <h1 className="text-heading">{t('app.name')}</h1>
      </div>

      <form
        onSubmit={submit}
        className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-border-strong bg-surface-dialog p-6 shadow-sm"
      >
        {/* The account picker. */}
        <section aria-labelledby="login-accounts-label" className="flex flex-col gap-2">
          <h2 id="login-accounts-label" className="text-sm font-bold text-foreground-muted">
            {t('auth.selectAccount')}
          </h2>

          {loading ? (
            <div className="flex items-center justify-center gap-3" aria-busy="true">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton
                  key={index}
                  variant="rect"
                  className="h-24 w-20 rounded-lg"
                  accessibilityLabel=""
                />
              ))}
            </div>
          ) : loadError ? (
            <ErrorState message={t([`errors.${loadError}`, 'errors.internal_error'])} />
          ) : list.length === 0 ? (
            <p className="text-sm text-foreground-muted">{t('auth.noAccounts')}</p>
          ) : (
            /* The ONE account rail. The chosen account is centred by measurement,
               so one user, two users and a full roster all compose correctly. */
            <AccountSelector
              accounts={list}
              selected={selected}
              onSelect={select}
              disabled={busy}
            />
          )}
        </section>

        {/* Who is signing in, said in words — so the state is never carried by
            the selection ring alone. */}
        <p
          className="text-sm text-foreground-subtle"
          aria-live="polite"
          data-testid="login-selected-account"
        >
          {selected ? t('auth.selectedAccount', { name: selected }) : t('auth.noAccountSelected')}
        </p>

        <Field
          label={t('auth.credential')}
          htmlFor="login-pin"
          error={fieldError}
          hint={t('auth.credentialHint', {
            min: CREDENTIAL_MIN_DIGITS,
            max: CREDENTIAL_MAX_DIGITS,
          })}
        >
          <PinInput
            id="login-pin"
            value={pin}
            // Normalized on every change, so a sixth digit, a letter and a
            // pasted hyphen all fail to enter the field in the first place.
            onValueChange={(next) => {
              setPin(normalizeCredentialInput(next))
              if (fieldError) setFieldError(null)
            }}
            length={CREDENTIAL_MAX_DIGITS}
            disabled={busy}
            autoComplete="current-password"
            // Enter submits from here, which is the natural thing to try.
            enterKeyHint="go"
          />
        </Field>

        <Button type="submit" size="lg" variant="default" disabled={busy} loading={busy}>
          {busy ? t('auth.signingIn') : t('auth.signIn')}
        </Button>

        {formError ? (
          <div role="alert">
            <ErrorState message={formError} />
          </div>
        ) : null}
      </form>

      <p className="text-xs text-foreground-subtle">{t('app.tagline')}</p>
    </main>
  )
}
