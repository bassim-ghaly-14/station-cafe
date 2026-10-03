/**
 * The Dev Settings "Danger zone".
 *
 * ADMIN-only. These three actions clear or rebuild the whole database; the
 * service authorizes each one as ADMIN regardless of what this page renders, so
 * this section only decides what is REACHABLE.
 *
 * It owns no action of its own: each button hands the work back to the page,
 * which owns the reseed grant, the session and the settings reload.
 */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import { RefreshCw, Sparkles, Trash2, TriangleAlert } from '@/components/ui/icon'

/** The page's busy flag, exactly as the page tracks it. */
export type DevSettingsBusy =
  'settings' | 'tables' | 'seed' | 'demo' | 'clear' | 'pin' | 'period' | null

export function DevDangerZone({
  busy,
  onLoadOfficial,
  onRequestDemo,
  onRequestClear,
}: {
  busy: DevSettingsBusy
  onLoadOfficial: () => void
  onRequestDemo: () => void
  onRequestClear: () => void
}) {
  const { t } = useTranslation()

  return (
    <section
      aria-labelledby="dev-danger-zone"
      data-testid="dev-danger-zone"
      className="flex flex-col gap-4 rounded-lg border border-destructive-border bg-destructive-soft/40 p-4"
    >
      <div className="flex flex-col gap-1">
        <h2
          id="dev-danger-zone"
          className="flex items-center gap-2 text-base font-bold text-destructive-soft-foreground"
        >
          <TriangleAlert size={18} aria-hidden />
          {t('dev.dangerZone')}
        </h2>

        <p className="text-xs text-foreground-subtle">{t('dev.dangerZoneDescription')}</p>
      </div>

      {/* Load official data */}
      <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <RefreshCw size={18} aria-hidden className="mt-0.5 shrink-0 text-foreground-muted" />

          <div className="min-w-0">
            <h3 className="text-sm font-bold text-foreground-strong">
              {t('dev.dangerZoneLoadTitle')}
            </h3>

            <p className="text-xs text-foreground-muted">{t('dev.dangerZoneLoadDescription')}</p>
          </div>
        </div>

        <Button
          className="shrink-0 self-start sm:self-auto"
          loading={busy === 'seed'}
          disabled={busy !== null}
          onClick={onLoadOfficial}
        >
          <RefreshCw size={16} aria-hidden />
          {t('dev.dangerZoneLoadTitle')}
        </Button>
      </div>

      {/* Load DEMO data — deliberately a SEPARATE card from the official one.
          The two actions are visually and verbally distinct: different icon,
          different heading, an explicit "demo" label, and its own destructive
          confirmation. They must never be confusable. */}
      <div className="flex flex-col gap-3 rounded-md border border-warning-border bg-warning-soft/40 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Sparkles size={18} aria-hidden className="mt-0.5 shrink-0 text-foreground-muted" />

          <div className="min-w-0">
            <h3 className="text-sm font-bold text-foreground-strong">{t('dev.demoTitle')}</h3>

            <p className="text-xs text-foreground-muted">{t('dev.demoDescription')}</p>
          </div>
        </div>

        <Button
          className="shrink-0 self-start sm:self-auto"
          loading={busy === 'demo'}
          disabled={busy !== null}
          onClick={onRequestDemo}
        >
          <Sparkles size={16} aria-hidden />
          {t('dev.demoTitle')}
        </Button>
      </div>

      {/* Clear database */}
      <div className="flex flex-col gap-3 rounded-md border border-destructive-border bg-surface-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Trash2 size={18} aria-hidden className="mt-0.5 shrink-0 text-destructive" />

          <div className="min-w-0">
            <h3 className="text-sm font-bold text-foreground-strong">
              {t('dev.dangerZoneClearTitle')}
            </h3>

            <p className="text-xs text-foreground-muted">{t('dev.dangerZoneClearDescription')}</p>
          </div>
        </div>

        <Button
          className="shrink-0 self-start sm:self-auto"
          variant="destructive"
          loading={busy === 'clear'}
          disabled={busy !== null}
          onClick={onRequestClear}
        >
          <Trash2 size={16} aria-hidden />
          {t('dev.dangerZoneClearTitle')}
        </Button>
      </div>
    </section>
  )
}
