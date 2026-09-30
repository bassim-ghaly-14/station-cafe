/**
 * The Station QR Code page — daily operational access for EVERY signed-in role.
 *
 * What this page is
 * -----------------
 * One thing, plainly: the Station QR code, so anyone at the till can show it to
 * a customer's phone. It is a destination of its own (`/qr-code`), reachable
 * from the sidebar for ADMIN, MANAGER and STAFF alike.
 *
 * What this page is NOT
 * ---------------------
 * It is NOT a second Dev Settings. There is no activation switch here, no
 * enable/disable control, no port, no bind address and no diagnostic output.
 * Turning the local service on or off, and configuring it, remain exactly what
 * they were: Dev Settings, ADMIN-gated, with the backend enforcing it. This page
 * only READS.
 *
 * Why the data comes from the same place as Dev Settings
 * ------------------------------------------------------
 * The SVG, the URL and the "is it actually listening" truth all come from the
 * single `local_access_qr` command, and the URL itself is assembled in Rust
 * (`network::qr`). Nothing here encodes, builds or caches a code: this is a
 * viewer over the existing source of truth, which is why a code shown here and
 * a code shown in Dev Settings cannot disagree.
 *
 * The security wording is kept, not softened: scanning the code does not sign
 * anyone in. A QR on a counter is a sticker anyone can photograph, so it
 * carries an address and nothing else, and the page says so in Arabic.
 *
 * Authorization
 * -------------
 * `local_access_qr` authenticates the caller and nothing more; the service
 * still has to be genuinely listening before a code is shown, because a QR that
 * scans and then fails is worse than no QR at all. The activation and
 * configuration commands behind Dev Settings keep their existing MANAGER+ gate.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardHeader, Loader } from '@/components/ui'
import { QrCode as QrCodeIcon } from '@/components/ui/icon'
import { ErrorState } from '@/components/states'
import { StationQrCode } from '@/components/qr/StationQrCode'
import { localAccessApi, type LocalAccess } from '@/services/localAccessApi'
import { useErrText } from '@/lib/err'

export default function QrCodePage() {
  const { t } = useTranslation()
  const errText = useErrText(t)
  const [access, setAccess] = useState<LocalAccess | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)

  const load = useCallback(() => {
    setBusy(true)
    setError(null)
    return localAccessApi
      .load()
      .then((value) => setAccess(value))
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setBusy(false))
  }, [errText])

  useEffect(() => {
    // The page's initial read of the single `local_access_qr` command. External
    // async init, started after the first commit; `busy` already starts true.
    // oxlint-disable-next-line react/set-state-in-effect -- external async init.
    void load()
  }, [load])

  // A code is shown only for a service that is actually listening AND has
  // produced both halves of the pair. Rendering a half-answer would put a
  // broken-looking code on the counter.
  //
  // Read through locals rather than off `access` directly, so the narrowing is
  // the compiler's and the values cannot disagree with the condition.
  const running = access?.apiRunning === true
  const svg = running ? access?.svg : null
  const url = running ? access?.url : null

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-heading flex items-center gap-2">
          <QrCodeIcon size={22} aria-hidden />
          {t('qrCode.title')}
        </h1>

        <p className="text-caption text-foreground-subtle">{t('qrCode.subtitle')}</p>
      </header>

      <Card className="w-full">
        <CardHeader title={t('qrCode.cardTitle')} subtitle={t('qrCode.cardDescription')} />

        {busy ? (
          <div className="flex justify-center py-8">
            <Loader size="lg" label={t('qrCode.loading')} />
          </div>
        ) : error ? (
          // The project's own error state, with a retry — never an alert, and
          // never a stack trace: the message is the translated, user-facing one
          // `useErrText` produces from the backend's stable error code.
          <ErrorState message={error} onRetry={load} retryLabel={t('app.retry')} />
        ) : svg && url ? (
          <div className="flex flex-col items-center gap-4">
            {/* One maximum width, shared with the image's own cap, so the code
                fills the card on a phone and stops growing on a desktop. No
                fixed desktop dimension: it is `w-full` inside a card that is
                itself `w-full`, so it scales down with the viewport. */}
            <StationQrCode
              svg={svg}
              alt={t('dev.localAccessQrAlt')}
              className="w-full max-w-64"
              testId="qr-code-image"
            />

            {/* What the code opens, and what it is NOT. Both statements are the
                product's existing copy, reused verbatim rather than rewritten
                here, so the two surfaces cannot say different things. */}
            <div className="flex flex-col items-center gap-1 text-center">
              <p className="text-body font-bold text-foreground-strong">
                {t('dev.localAccessProductName')}
              </p>

              {/* LTR: it is a URL, and a URL reads left-to-right in Arabic too. */}
              <p
                dir="ltr"
                className="font-mono text-body font-bold text-foreground"
                data-testid="qr-code-url"
              >
                {url}
              </p>

              <p className="text-caption text-foreground-muted">
                {t('dev.localAuthStillRequired')}
              </p>
            </div>
          </div>
        ) : (
          /*
           * No code, and an honest reason. The service is either switched off
           * or failed to bind; the backend reports which, and the user is told
           * the code is unavailable rather than shown an address that leads
           * nowhere. Enabling it is an administrator's job in Dev Settings —
           * this page deliberately offers no control to do it.
           */
          <div
            className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border p-8 text-center"
            data-testid="qr-code-unavailable"
          >
            <p className="text-body font-medium text-foreground-muted">
              {t('dev.localAccessStopped')}
            </p>
          </div>
        )}
      </Card>
    </div>
  )
}
