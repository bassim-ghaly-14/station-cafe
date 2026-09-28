/**
 * A reusable confirmation dialog, built ON TOP of the existing `Dialog`.
 *
 * # Why this exists
 *
 * Station must never change state from a single click, and the confirmation for
 * that must be the SAME everywhere: one overlay, one focus lifecycle, one Escape
 * behaviour, one visual language. So this is not a bespoke modal — it delegates
 * entirely to `Dialog` and adds only what every confirmation needs:
 *
 *  - a `body` sentence naming WHO is affected and WHAT happens;
 *  - an optional `detail` line stating a consequence worth knowing first;
 *  - a cancel/confirm footer whose confirm variant is chosen from the OUTCOME
 *    (`destructive` for a stop, `default` for a positive one);
 *  - a `busy` state that disables the cancel button and shows a spinner, so a
 *    slow command cannot be fired twice.
 *
 * # What it is NOT
 *
 * This is an interaction affordance, not an authorization boundary. Showing,
 * hiding or disabling a button never grants or refuses anything: the service
 * re-checks the caller's authority on every command regardless of what the user
 * was shown, and a caller that invokes the Tauri command directly bypasses this
 * dialog entirely. That is precisely why the backend check is the real one.
 */
import { useTranslation } from 'react-i18next'
import { Button } from './button'
import { Dialog } from './dialog'
import { DialogActions } from './dialog-actions'

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  detail,
  confirmLabel,
  cancelLabel,
  /** `destructive` for an outcome that removes access; `default` for a positive one. */
  destructive = false,
  busy = false,
}: {
  readonly open: boolean
  readonly onClose: () => void
  /** Runs only on an explicit confirm. The caller owns the request and the toast. */
  readonly onConfirm: () => void
  readonly title: string
  /** The question itself — it must name the person and the action. */
  readonly body: string
  /** An optional second sentence stating a consequence worth knowing first. */
  readonly detail?: string
  readonly confirmLabel?: string
  readonly cancelLabel?: string
  readonly destructive?: boolean
  readonly busy?: boolean
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <p className="text-body text-foreground-muted">{body}</p>
      {detail ? <p className="mt-2 text-caption text-foreground-subtle">{detail}</p> : null}
      {/* The shared action row: on a phone the two buttons stack full width
          rather than sharing a 296px line and wrapping raggedly, which is what
          put a narrower "confirm" beside a wider "cancel" on a 320px screen. */}
      <DialogActions className="mt-5">
        <Button variant="outline" onClick={onClose} disabled={busy}>
          {cancelLabel ?? t('app.cancel')}
        </Button>
        <Button
          variant={destructive ? 'destructive' : 'default'}
          onClick={onConfirm}
          loading={busy}
          data-dialog-autofocus
        >
          {confirmLabel ?? t('app.confirm')}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
