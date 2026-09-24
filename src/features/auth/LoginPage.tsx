/** Arabic-first login screen (RTL, no browser alerts, accessible focus). */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Logo } from '@/components/branding/Logo'
import { ErrorState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Field, Input, PasswordInput } from '@/components/ui/input'
import { useSession } from './useSession'

export default function LoginPage() {
  const { t } = useTranslation()
  const { login } = useSession()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<'name' | 'password' | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setFieldError(null)
    setFormError(null)
    if (!name.trim()) {
      setError(t('auth.nameRequired'))
      setFieldError('name')
      return
    }
    if (!password) {
      setError(t('auth.passwordRequired'))
      setFieldError('password')
      return
    }
    setBusy(true)
    try {
      await login(name.trim(), password)
    } catch (err) {
      const code = (err as { message?: string }).message ?? 'internal_error'
      setFormError(t([`errors.${code}`, 'errors.internal_error']))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main
      dir="rtl"
      className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background p-4"
    >
      <div className="flex flex-col items-center gap-3">
        <Logo size={88} />
        <h1 className="text-heading">{t('app.name')}</h1>
      </div>

      <form
        onSubmit={submit}
        className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-border bg-surface p-6 shadow-sm"
      >
        <Field
          label={t('auth.name')}
          htmlFor="login-name"
          error={fieldError === 'name' ? error : null}
        >
          <Input
            id="login-name"
            value={name}
            autoComplete="username"
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field
          label={t('auth.password')}
          htmlFor="login-password"
          error={fieldError === 'password' ? error : null}
        >
          <PasswordInput
            id="login-password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
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
