/**
 * The Dev Settings "Application Updates" card — Station's ONLY update surface.
 *
 * What this card must be: manual, explicit, ADMIN-only (through the existing
 * Dev Settings gate) and desktop-only. What it must never be: automatic. There
 * is no check on mount, no check on page load, no polling and no timer.
 * Nothing here reaches the network until a manager presses "Check for Updates",
 * and nothing is downloaded until they press "Update" and confirm. That is what
 * keeps Station offline-first: the cafe PC never talks to GitHub on its own.
 *
 * One busy state, one source of truth.
 *
 * `phase` is a single state value rather than a handful of booleans, because
 * scattered flags can disagree with each other mid-transition — and a
 * disagreement here means a double install or a permanently dead button. Both
 * actions derive `disabled` from the same value, so "busy" has exactly one
 * definition in the component.
 *
 * The safety gate is the reason this is not just two buttons. Installing an
 * update closes the app, and Station's data lives in a SQLite file that must
 * not be touched while a shift or a business day is open. The gate therefore
 * runs TWICE: once when the manager presses Update, so they learn before
 * confirming, and again from `confirmInstall`, immediately before the download,
 * against the authoritative `day_shift_state` command rather than anything
 * cached in this component. A shift can open on the POS floor at any moment;
 * the check closest to the download is the one that counts.
 *
 * Signature verification is not re-implemented here and no `.sig` is fetched by
 * hand: the plugin verifies the bundle against the compiled public key inside
 * Rust, before anything is installed.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogActions,
  ProgressBar,
} from '@/components/ui'
import { Download, Package, RefreshCw } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import {
  UpdateError,
  checkForUpdate,
  currentVersion,
  installUpdate,
  isUpdateSupported,
  relaunchApp,
  type PendingUpdate,
  type UpdateErrorCode,
  type UpdateProgress,
} from '@/services/updateApi'
import { shiftApi } from '@/services/shiftApi'

/**
 * The one busy state. `idle` is the only value that enables an action, so
 * "both actions are disabled while busy" is one condition instead of a promise
 * about four booleans.
 */
type Phase = 'idle' | 'checking' | 'confirming' | 'downloading' | 'installing' | 'restarting'

const IDLE_PROGRESS: UpdateProgress = { downloaded: 0, total: null, percent: null }

export function ApplicationUpdatesCard() {
  const { t } = useTranslation()
  const toast = useToast()

  const supported = isUpdateSupported()
  const [phase, setPhase] = useState<Phase>('idle')
  const [version, setVersion] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingUpdate | null>(null)
  const [progress, setProgress] = useState<UpdateProgress>(IDLE_PROGRESS)

  /**
   * A ref, not state: the in-flight flag has to be readable SYNCHRONOUSLY from
   * a second click handler, and `phase` only updates on the next render. Two
   * clicks inside one tick would otherwise both read `phase === 'idle'` and
   * start two installs.
   */
  const running = useRef(false)

  /** Display-only read of the installed version. Its failure hides nothing. */
  useEffect(() => {
    if (!supported) return
    let active = true
    // External async init after the first commit.
    // oxlint-disable-next-line react/set-state-in-effect -- external async init.
    void currentVersion().then((value) => {
      if (active) setVersion(value)
    })
    return () => {
      active = false
    }
  }, [supported])

  /** Every updater failure is a translation key, so no stack trace reaches a screen. */
  const reportError = useCallback(
    (error: unknown, fallback: UpdateErrorCode) => {
      toast(t(error instanceof UpdateError ? error.code : fallback), 'error')
    },
    [t, toast],
  )

  const busy = phase !== 'idle'
  /** Release a held update without installing it. Never throws. */
  const discard = useCallback((update: PendingUpdate | null) => {
    if (update) void update.dispose()
  }, [])

  const handleCheck = useCallback(async () => {
    if (!supported || running.current) return
    running.current = true
    setPhase('checking')
    setProgress(IDLE_PROGRESS)
    try {
      const found = await checkForUpdate()
      if (!found) {
        // "No update" is a real answer, not a failure.
        toast(t('dev.updateUpToDate'), 'success')
        return
      }
      // A previous, unchecked offer is released before a new one is held.
      discard(pending)
      setPending(found)
    } catch (error) {
      reportError(error, 'dev.updateCheckFailed')
    } finally {
      running.current = false
      // Always usable again: a failed check must leave a working retry button.
      setPhase('idle')
    }
  }, [discard, pending, reportError, supported, t, toast])

  /**
   * The safety gate: true when Station must not restart right now.
   *
   * `day_shift_state` is the authoritative command: it reports the business day
   * AND whether ANY shift is active, not only the caller's. A shift a cashier
   * opened on the POS floor counts exactly as much as the admin's own, which is
   * why no UI-cached shift state is trusted here.
   */
  const blockedByOpenWork = useCallback(async (): Promise<boolean> => {
    const state = await shiftApi.state()
    return state.day !== null || state.any_active_shift
  }, [])

  /** Open the confirmation — only after the gate has cleared. */
  const handleUpdate = useCallback(async () => {
    if (!pending || !supported || running.current) return
    running.current = true
    try {
      // Gate BEFORE the dialog, so a manager mid-shift is told now rather than
      // after accepting a dialog whose promise they cannot keep.
      if (await blockedByOpenWork()) {
        toast(t('dev.updateBlockedOpenWork'), 'error')
        return
      }
      setPhase('confirming')
    } catch {
      // The gate itself could not be read. Refusing is the safe answer: a POS
      // must never restart because a status read failed.
      toast(t('dev.updateBlockedOpenWork'), 'error')
    } finally {
      running.current = false
    }
  }, [blockedByOpenWork, pending, supported, t, toast])

  const confirmInstall = useCallback(async () => {
    if (!pending || running.current) return
    running.current = true
    setPhase('installing')
    let fresh: PendingUpdate | null = null
    let reachedRestart = false
    try {
      // Re-check availability. An Update object from an earlier check may have
      // been withdrawn since; installing it blindly would install something
      // nobody re-verified.
      fresh = await checkForUpdate()
      if (!fresh) {
        discard(pending)
        setPending(null)
        toast(t('dev.updateNoLongerAvailable'), 'info')
        return
      }

      // The gate again — and this is the LAST thing before any byte moves.
      if (await blockedByOpenWork()) {
        await fresh.dispose()
        toast(t('dev.updateBlockedOpenWork'), 'error')
        return
      }

      setPhase('downloading')
      setProgress(IDLE_PROGRESS)
      await installUpdate(fresh, setProgress)

      // On Windows the NSIS installer has taken over by this point.
      setPhase('restarting')
      await relaunchApp()
      // The process is on its way out. The terminal state stays 'restarting'
      // rather than snapping back to idle, so the last thing on screen is an
      // honest "Station is restarting", never a re-armed Check button.
      reachedRestart = true
    } catch (error) {
      // The application is untouched and still usable; returning to idle leaves
      // the manager a working retry rather than a dead button. Nothing claims
      // the update succeeded when it did not.
      reportError(error, 'dev.updateFailed')
    } finally {
      if (fresh && fresh !== pending) discard(fresh)
      running.current = false
      if (!reachedRestart) setPhase('idle')
    }
  }, [blockedByOpenWork, discard, pending, reportError, t, toast])

  /** Cancel closes the dialog and releases the held update resource. */
  const cancelInstall = useCallback(() => {
    if (running.current) return
    discard(pending)
    setPending(null)
    setProgress(IDLE_PROGRESS)
    setPhase('idle')
  }, [discard, pending])
  if (!supported) {
    // LAN / browser: the page still renders and says plainly why there is no
    // update button here. No Tauri updater module is ever loaded on this path.
    return (
      <Card data-testid="dev-application-updates">
        <CardHeader
          title={t('dev.applicationUpdates')}
          subtitle={t('dev.applicationUpdatesDescription')}
        />
        <p className="text-sm text-foreground-muted" dir="rtl" data-testid="dev-update-unsupported">
          {t('dev.updateUnsupported')}
        </p>
      </Card>
    )
  }

  const percent = progress.percent

  return (
    <Card data-testid="dev-application-updates">
      <CardHeader
        title={t('dev.applicationUpdates')}
        subtitle={t('dev.applicationUpdatesDescription')}
        actions={
          pending ? (
            // The badge shows the bare version; the aria-label is what assistive
            // technology announces, so it states the fact in a sentence instead
            // of reading a bare "0.2.0" with no context.
            <Badge
              variant="info"
              size="sm"
              icon={Package}
              data-testid="dev-update-available-badge"
              aria-label={t('dev.updateAvailable', { version: pending.version })}
            >
              {pending.version}
            </Badge>
          ) : null
        }
      />

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            loading={phase === 'checking'}
            disabled={busy}
            onClick={() => void handleCheck()}
            data-testid="dev-update-check"
          >
            <RefreshCw size={16} aria-hidden />
            {phase === 'checking' ? t('dev.updateChecking') : t('dev.updateCheck')}
          </Button>

          {pending && (
            <Button
              variant="success"
              disabled={busy}
              onClick={() => void handleUpdate()}
              data-testid="dev-update-install"
            >
              <Download size={16} aria-hidden />
              {t('dev.updateToLatest')}
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-foreground-muted">{t('dev.updateInstalledVersion')}</span>
          {/* LTR + monospace: a version is neither Arabic nor prose. */}
          <span
            className="font-mono text-foreground-strong"
            dir="ltr"
            data-testid="dev-update-version"
          >
            {version ?? '—'}
          </span>
        </div>

        {phase === 'downloading' && (
          <div className="flex flex-col gap-2" data-testid="dev-update-progress">
            {/* The bar is the app's own indeterminate ProgressBar, so the
                percentage beside it is the honest, accessible read-out. */}
            <ProgressBar label={t('dev.updateDownloading')} />
            <p className="text-caption text-foreground-muted" dir="rtl">
              {percent === null
                ? t('dev.updateDownloading')
                : t('dev.updateDownloadPercent', { percent })}
            </p>
          </div>
        )}

        {phase === 'installing' && (
          <p
            className="text-caption text-foreground-muted"
            dir="rtl"
            data-testid="dev-update-installing"
          >
            {t('dev.updateInstalling')}
          </p>
        )}

        {phase === 'restarting' && (
          <div className="flex flex-col gap-2" data-testid="dev-update-restarting">
            <p className="text-caption text-foreground-muted">{t('dev.updateReadyToRestart')}</p>
            <p className="text-caption text-foreground-muted">{t('dev.updateRestarting')}</p>
          </div>
        )}
      </div>

      <Dialog
        open={phase === 'confirming'}
        onClose={cancelInstall}
        title={t('dev.updateConfirmTitle')}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-6 text-foreground" dir="rtl">
            {t('dev.updateConfirmBody')}
          </p>

          <DialogActions>
            <Button
              variant="outline"
              disabled={phase !== 'confirming'}
              onClick={cancelInstall}
              data-testid="dev-update-cancel"
            >
              {t('dev.updateCancel')}
            </Button>

            {/* success, never destructive: installing an update is the intended
                outcome of this dialog, not a destruction of cafe data. */}
            <Button
              variant="success"
              loading={phase === 'downloading' || phase === 'installing'}
              disabled={phase !== 'confirming'}
              onClick={() => void confirmInstall()}
              data-testid="dev-update-confirm"
            >
              <Download size={16} aria-hidden />
              {t('dev.updateToLatest')}
            </Button>
          </DialogActions>
        </div>
      </Dialog>
    </Card>
  )
}
