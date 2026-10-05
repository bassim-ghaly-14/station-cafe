/**
 * Copy-to-clipboard — the ONE copy interaction in the application.
 *
 * What this component is
 * ----------------------
 * A generic control that takes a `value`, copies it, and says so. It knows
 * nothing about customers, employees, phone numbers or QR codes: a consumer
 * supplies a string and gets a button, a success state and an accessible name
 * in return. The clipboard write, the feedback timer and the icon swap all live
 * here, so no page ever re-implements them.
 *
 * Why the capability gate lives in the component
 * ----------------------------------------------
 * This bundle is served two ways: the Tauri desktop shell on the till, and the
 * same `dist/` over plain `http://` to whatever phone scanned the QR. In that
 * second origin `navigator.clipboard` is simply `undefined`, because the API is
 * only exposed in a SECURE context — so a copy button there could only ever
 * throw and its `catch` would raise a generic error toast. A control that looks
 * functional and can never succeed is worse than no control, so when the
 * capability is absent this renders NOTHING at all.
 *
 * It is not hidden with CSS, and that is deliberate: a `display: none` button is
 * still in the accessibility tree and still focusable by a screen reader. The
 * check is kept alongside `isDesktop()` rather than instead of it, so a browser
 * that genuinely does expose the clipboard — a localhost origin, or a future
 * HTTPS listener — keeps a working control instead of losing a feature the
 * platform actually supports. The same check is repeated at the moment of the
 * click, because the capability is a property of the browser and a control that
 * cannot copy must never be able to reach the "copied" state.
 *
 * Feedback
 * --------
 * Three things happen on a successful copy, and all three are needed:
 *
 *  1. the glyph becomes a check and the button takes the existing `success`
 *     semantic colour — visible without reading anything;
 *  2. the accessible name becomes the "copied" string, so the state is never
 *     communicated by an icon change alone;
 *  3. a toast in the project's existing `ToastProvider` stack is raised, whose
 *     container is `aria-live="polite"`, so a screen reader announces it without
 *     focus ever moving.
 *
 * The state is deliberately temporary: it returns to Copy after a short delay,
 * because the button's resting meaning is "copy this", not "this was copied
 * once". A second click restarts the window rather than queueing, so repeated
 * clicks cannot leave the check stuck on.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { isDesktop } from '@/services/ipc'
import { Button, type ButtonProps } from './button'
import { Check, Copy } from './icon'
import { useToast } from './toast'

/**
 * How long the success state lasts before the button returns to Copy.
 *
 * Long enough to be noticed without reading, short enough that a later copy
 * elsewhere on the screen is never contradicted by a stale check mark.
 */
const FEEDBACK_MS = 1500

/**
 * Whether copying can mean anything at all in this origin. See the note above:
 * the desktop shell always has a clipboard; a browser is judged on the API
 * itself rather than on the shell, so a supporting browser keeps the feature.
 */
function canCopy(): boolean {
  return (
    isDesktop() ||
    (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function')
  )
}

export interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'children' | 'type'> {
  /** The exact text placed on the clipboard. */
  readonly value: string
  /** The accessible name in its resting state, e.g. "نسخ التليفون". */
  readonly label: string
  /** The accessible name while the success state is showing. */
  readonly copiedLabel: string
  /**
   * Optional VISIBLE text, for a control that reads as a labelled button rather
   * than an icon beside a value — the QR page's "نسخ الرابط" is that shape, and
   * an icon-only control there would be a redesign. Omit it for the icon form
   * used beside a customer or employee number. When present the button's width
   * follows the text, which is why `copiedLabel` should be kept short.
   */
  readonly text?: string
}
/**
 * The copy control. `label` / `copiedLabel` are required rather than defaulted
 * so that a screen reader always gets a name that says WHAT is being copied,
 * not a generic "copy" repeated down a list of rows.
 */
export function CopyButton({
  value,
  label,
  copiedLabel,
  text,
  className,
  size,
  ...props
}: CopyButtonProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The feedback window is owned by this component, so it must not outlive it.
  // A row that scrolls away, or a dialog that closes mid-feedback, would
  // otherwise schedule a state update on an unmounted component.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  const copy = useCallback(async () => {
    // Re-checked at the moment of the click, not only at render: see the note
    // on `canCopy`. A control that cannot copy must never reach the success
    // state, and must never raise a misleading toast.
    const write = typeof navigator !== 'undefined' ? navigator.clipboard?.writeText : undefined
    if (typeof write !== 'function') return

    try {
      await write.call(navigator.clipboard, value)
      setCopied(true)
      toast(t('app.copied'), 'success')
      // A repeated click restarts the window instead of queueing another, so
      // the check can never outlive its own reset.
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), FEEDBACK_MS)
    } catch {
      // The write failed, so there is no success state and no "copied" claim.
      toast(t('app.error'), 'error')
    }
  }, [toast, t, value])

  // Rendered conditionally rather than hidden with `display: none`, for the
  // accessibility reason documented above.
  if (!canCopy()) return null

  return (
    <Button
      {...props}
      onClick={() => void copy()}
      // The icon form beside a number is a compact `ghost` control; the labelled
      // form keeps the QR page's own `secondary` button, so neither presentation
      // invents a style the design does not already have.
      variant={text ? 'secondary' : 'ghost'}
      size={size ?? (text ? 'md' : 'icon-sm')}
      // `aria-label` and `title` travel together, which is this project's
      // established icon-button convention (see `TableActionButton`): the
      // native tooltip is the only tooltip system in the design, and both are
      // kept in step so the visible and announced names can never disagree.
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
      className={cn(
        text ? 'transition-colors' : 'shrink-0',
        copied ? 'text-success' : 'text-foreground-subtle hover:text-foreground',
        className,
      )}
    >
      {/* The glyph is decorative in BOTH states — the accessible name above
          carries the meaning — so it is hidden rather than announced twice. */}
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {text ? <span>{copied ? copiedLabel : text}</span> : null}
    </Button>
  )
}
