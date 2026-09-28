/**
 * The Dev Settings "Station local access" card.
 *
 * Shows the manager the address their phone should use, and a QR for it.
 *
 * What this card must never imply: that scanning the QR signs you in. The QR
 * is a phone number for a building — it carries an address and nothing else.
 * The wording below says so explicitly in Arabic, because a QR on a counter
 * that looks like a login is exactly how a cafe ends up with a stranger
 * "logged in". Authentication stays where it already is: the manager still
 * signs in on the API with their own Station account.
 *
 * The URL is BUILT IN RUST and merely displayed here, so no credential can be
 * assembled into the payload from this side.
 *
 * Reuses the page's own `Card`/`CardHeader`/loading pieces and every word is a
 * translation key, matching `ChartColorsCard` next to it.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardHeader, Loader } from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { localAccessApi, type LocalAccess } from '@/services/localAccessApi'
import { useErrText } from '@/lib/err'

export function LocalAccessCard() {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [access, setAccess] = useState<LocalAccess | null>(null)
  const [busy, setBusy] = useState(true)

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    void localAccessApi
      .load()
      .then((value) => {
        if (!cancelled) setAccess(value)
      })
      .catch((error) => {
        if (!cancelled) toast(errText(error), 'error')
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [toast, errText])

  return (
    <Card data-testid="dev-local-access">
      <CardHeader title={t('dev.localAccess')} subtitle={t('dev.localAccessDescription')} />

      {busy && <Loader />}

      {!busy && access && (
        <div className="flex flex-col gap-4 md:flex-row md:items-start" dir="ltr">
          {/* The QR is a real endpoint response, rendered as an inline image.
              `data:` is already permitted by the production CSP (img-src). */}
          <img
            src={`data:image/svg+xml;utf8,${encodeURIComponent(access.svg)}`}
            alt={t('dev.localAccessQrAlt')}
            className="h-48 w-48 shrink-0 rounded-lg bg-white p-1"
            data-testid="dev-local-access-qr"
          />

          <div className="flex flex-col gap-2 text-start">
            {/* The address a manager reads out or types. LTR: it is a URL. */}
            <p className="font-mono text-body-strong" dir="ltr" data-testid="dev-local-access-url">
              {access.url}
            </p>

            <p className="text-caption text-foreground-muted" dir="rtl">
              {t('dev.localAuthStillRequired')}
            </p>

            {!access.apiRunning && (
              <p className="text-caption text-warning" dir="rtl" data-testid="dev-local-access-off">
                {t('dev.localAccessStopped')}
              </p>
            )}

            {access.discoveryActive && (
              <p className="text-caption text-foreground-muted" dir="rtl">
                {t('dev.localDiscoveryOn')}
              </p>
            )}

            {/* The IP fallback: the authoritative path, always available even if
                the client cannot resolve a .local name or multicast is blocked. */}
            {access.otherHosts.length > 0 && (
              <p className="text-caption text-foreground-muted" dir="rtl">
                {t('dev.localAccessOtherAddresses')}
                <span dir="ltr" className="ms-2 font-mono">
                  {access.otherHosts.join('، ')}
                </span>
              </p>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}
