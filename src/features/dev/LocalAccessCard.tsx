/**
 * The Dev Settings "Station local access" card.
 *
 * Shows the manager the address their phone should use, a QR for it, and the
 * switch that actually turns the service on.
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
 * A QR is rendered ONLY while the service is actually listening. A code that
 * scans perfectly and then fails is worse than no code at all.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, CardHeader, Loader } from '@/components/ui'
import { StationQrCode } from '@/components/qr/StationQrCode'
import { useToast } from '@/components/ui/toast'
import { localAccessApi, type LocalAccess, type NetworkConfig } from '@/services/localAccessApi'
import { useErrText } from '@/lib/err'

export function LocalAccessCard() {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [access, setAccess] = useState<LocalAccess | null>(null)
  const [config, setConfig] = useState<NetworkConfig | null>(null)
  const [busy, setBusy] = useState(true)
  const [saving, setSaving] = useState(false)

  // Read the setting AND the observed state, so the toggle can show what is
  // configured while the body shows what is actually running. The two are
  // genuinely different things: a failed bind leaves `enabled: true` with
  // `running: false`.
  const load = useCallback(() => {
    setBusy(true)
    return Promise.all([localAccessApi.load(), localAccessApi.getConfig()])
      .then(([accessValue, configValue]) => {
        setAccess(accessValue)
        setConfig(configValue)
      })
      .catch((error) => toast(errText(error), 'error'))
      .finally(() => setBusy(false))
  }, [toast, errText])

  useEffect(() => {
    // The page's initial read of the local-access state and configuration.
    // External async init, started after the first commit.
    // oxlint-disable-next-line react/set-state-in-effect -- external async init.
    void load()
  }, [load])

  /** Persist AND act: the backend starts or stops the service right away. */
  const toggle = async (enabled: boolean) => {
    if (!config) return
    setSaving(true)
    try {
      await localAccessApi.save({ ...config, enabled })
      await load()
    } catch (error) {
      toast(errText(error), 'error')
    } finally {
      setSaving(false)
    }
  }

  const running = access?.apiRunning === true
  // The QR is shown only for a service that is genuinely listening.
  const showQr = running && Boolean(access?.svg && access?.url)

  return (
    <Card data-testid="dev-local-access">
      <CardHeader title={t('dev.localAccess')} subtitle={t('dev.localAccessDescription')} />

      {busy && <Loader />}

      {!busy && config && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void toggle(!config.enabled)}
              loading={saving}
              data-testid="dev-local-access-toggle"
              variant={config.enabled ? 'secondary' : 'default'}
            >
              {config.enabled ? t('dev.localAccessDisable') : t('dev.localAccessEnable')}
            </Button>
            {/* Runtime truth, not the setting: a failed bind says so. */}
            <span className="text-caption text-foreground-muted" dir="rtl">
              {running
                ? t('dev.localAccessRunning')
                : config.enabled
                  ? t('dev.localAccessFailed')
                  : t('dev.localAccessOff')}
            </span>
          </div>

          {showQr && access?.url && access?.svg && (
            <div className="flex flex-col gap-4 md:flex-row md:items-start" dir="ltr">
              {/* The SAME presentational component the QR Code page renders, so
                  the two surfaces cannot drift and the code is encoded, sized
                  and quieted in exactly one place. `data:` is already permitted
                  by the production CSP (img-src). */}
              <StationQrCode
                svg={access.svg}
                alt={t('dev.localAccessQrAlt')}
                className="w-full max-w-48 shrink-0 md:w-48"
                testId="dev-local-access-qr"
              />

              <div className="flex flex-col gap-2 text-start">
                {/* What the QR opens, stated first: the local web app, not an
                    API endpoint. The manager should know what tapping it does
                    before they tap it. */}
                <p className="text-body-strong" dir="ltr" data-testid="dev-local-access-name">
                  {t('dev.localAccessProductName')}
                </p>

                {/* The address a manager reads out or types. LTR: it is a URL. */}
                <p
                  className="font-mono text-body-strong"
                  dir="ltr"
                  data-testid="dev-local-access-url"
                >
                  {access.url}
                </p>

                {/* The security explanation is kept, verbatim in spirit: the QR
                    is an address, not a key. */}
                <p className="text-caption text-foreground-muted" dir="rtl">
                  {t('dev.localAuthStillRequired')}
                </p>

                {access.discoveryActive && (
                  <p className="text-caption text-foreground-muted" dir="rtl">
                    {t('dev.localDiscoveryOn')}
                  </p>
                )}

                {/* The IP fallback: the authoritative path, always available
                    even if the client cannot resolve a .local name. */}
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
        </div>
      )}
    </Card>
  )
}
