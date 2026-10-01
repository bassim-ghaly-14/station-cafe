/**
 * Accessible dialog (no Radix dependency): overlay + focus handling +
 * Escape-to-close. Focused, minimal — matches the app's design tokens.
 *
 * Focus lifecycle
 * ---------------
 * Initial focus runs EXACTLY ONCE per opening, driven solely by the `open`
 * transition. It is deliberately not re-attempted on later renders: re-running
 * it moves focus out of whatever the user is currently editing (the first
 * focusable in DOM order is the header close button, not the field), which is
 * exactly what made a single-keystroke input unusable.
 *
 * `onClose` is read through a ref rather than listed as an effect dependency —
 * callers legitimately pass an inline arrow whose identity changes every
 * render. The Escape handler always invokes the latest callback while the
 * listener itself is registered once per opening.
 *
 * A control that should receive initial focus opts in with
 * `data-dialog-autofocus`; otherwise the first focusable element is used.
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from './button'
import { X } from './icon'

const FOCUSABLE = 'input, button, select, textarea'

export function Dialog({
  open,
  onClose,
  title,
  children,
  className,
  wide,
  /**
   * Extra controls rendered in the sticky header, before the close button.
   *
   * The header is the one part of the dialog that never scrolls away, so a
   * control the user must be able to reach while reading a long body belongs
   * here rather than inside `children`. `shrink-0` keeps it from being
   * compressed by a long title, and the title itself is `min-w-0`, so a wide
   * Arabic title shrinks instead of pushing the controls off the dialog.
   */
  headerActions,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly title: ReactNode
  readonly children: ReactNode
  readonly className?: string
  readonly wide?: boolean
  readonly headerActions?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const { t } = useTranslation()

  // Keep the latest callback without making it an effect dependency.
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const el = ref.current
    /*
     * The close control is named explicitly rather than left to "first
     * focusable in DOM order": a caller that puts a control in `headerActions`
     * would otherwise change where focus lands on every opening. The close
     * button is the dialog's own dismiss control, so it stays the default
     * target whatever else the header carries.
     */
    const target =
      el?.querySelector<HTMLElement>('[data-dialog-autofocus]') ??
      el?.querySelector<HTMLElement>('[data-dialog-close]') ??
      el?.querySelector<HTMLElement>(FOCUSABLE)
    target?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    /*
     * Dismiss by pressing the empty scrim.
     *
     * The scrim is a backdrop, not a control: it carries no role, no tab stop,
     * and no keyboard semantics, because it is not reachable and nothing inside
     * the dialog needs it to be. So it cannot carry a React `onMouseDown` either
     * — a mouse handler on a non-interactive element is an accessibility smell
     * (typescript:S6848), and it is not one here: it only ever runs for a press
     * that landed on the scrim itself.
     *
     * It is therefore bound as a native listener on the element, next to the
     * Escape listener, for the same duration and through the same callback
     * ref. The semantics are identical to the previous inline handler: the
     * listener is on the scrim and `mousedown` bubbles, so the `target`
     * comparison is what keeps a press inside the dialog from closing it, and a
     * press that starts inside the dialog and ends on the scrim still does not
     * close it.
     */
    const scrim = scrimRef.current
    const onScrimMouseDown = (e: MouseEvent) => {
      if (e.target === scrim) onCloseRef.current()
    }
    scrim?.addEventListener('mousedown', onScrimMouseDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      scrim?.removeEventListener('mousedown', onScrimMouseDown)
    }
  }, [open])

  if (!open) return null
  return (
    <div
      ref={scrimRef}
      className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-overlay p-0 sm:items-center sm:p-4"
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cn(
          /*
           * Mobile: a SHEET. Anchored to the bottom edge, full width, no side
           * margin, and rounded only at the top — which is what a dialog becomes
           * when the screen it has to fit inside is 360px wide and the soft
           * keyboard is up. Anchoring it to the bottom also puts the primary
           * action under the thumb rather than at the top of the screen.
           *
           * Desktop: unchanged — a centred card with side margin and a full
           * border radius.
           *
           * `dvh` (not `vh`) everywhere: on a phone `100vh` is the height of
           * the screen with the URL bar HIDDEN, so a `vh`-based cap produces a
           * dialog taller than what is actually visible and its footer lands
           * below the fold. `100dvh` is the height the user can really see.
           *
           * `overscroll-contain` stops the scroll from chaining out to the page
           * behind once the dialog's own content is exhausted, which on a
           * phone otherwise slides the page out from under the dialog.
           */
          'flex max-h-[92dvh] w-full max-w-full flex-col overflow-y-auto overscroll-contain rounded-t-xl border border-border-strong bg-surface-dialog shadow-xl sm:max-h-[90dvh] sm:rounded-lg',
          // `max-w-full` is the guard the whole mobile treatment rests on: the
          // sheet is `w-full` inside a viewport-wide scrim, and a long Arabic
          // title or a wide control could otherwise push it past the screen
          // edge. The desktop caps are unchanged.
          wide ? 'sm:max-w-2xl' : 'sm:max-w-md',
          className,
        )}
      >
        {/*
         * The header is `sticky` INSIDE the scrolling dialog rather than
         * sitting outside it. A dialog's body is one scroll container, so a
         * title that scrolled away on a long form is a title the user could
         * not find; sticking it costs no layout and no scroll listener.
         */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-4 bg-surface-dialog px-4 pt-4 pb-3 sm:px-5 sm:pt-5">
          <h2 className="min-w-0 text-base font-bold text-foreground-strong">{title}</h2>
          {headerActions}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-dialog-close=""
            onClick={onClose}
            aria-label={t('app.close')}
          >
            <X size={16} aria-hidden />
          </Button>
        </div>

        {/*
         * The body. The bottom padding carries the safe-area inset on a phone,
         * so the last field clears the iPhone home indicator and the Telegram
         * WebApp's own bottom chrome; `sm:` drops it back to a plain gap on
         * desktop, which has no inset to clear.
         *
         * The mobile keyboard is handled by the browser scrolling the focused
         * input into view INSIDE this container — which is why the dialog, not
         * the page behind it, is the scroll container on a phone.
         */}
        <div className="px-4 pt-1 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:px-5 sm:pb-5">
          {children}
        </div>
      </div>
    </div>
  )
}
