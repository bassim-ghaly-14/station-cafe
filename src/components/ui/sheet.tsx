/**
 * Bottom sheet - the mobile counterpart of `Drawer`.
 *
 * Why a separate primitive rather than reusing `Drawer`
 * ----------------------------------------------------
 * `Drawer` is anchored to the inline END of the viewport and enters from the
 * side. That is right for a record inspector beside a list on a wide screen,
 * but on a phone a side panel is a full-width takeover that slides in from an
 * edge the thumb is not on, and it competes with the bottom navigation for the
 * same gesture area. A sheet rises from the bottom edge, where the thumb
 * already is, and reads as "a layer above the current screen" rather than "a
 * different screen".
 *
 * Mobile behaviour this owns
 * --------------------------
 *  - The scrim covers the viewport; tapping it closes, and so does Escape.
 *  - The panel is anchored to the bottom and capped at 85dvh, so a long list
 *    scrolls INSIDE the sheet while the page behind it does not move. That is
 *    the one nested scroll here, and it is deliberate: without it, dragging
 *    inside a long menu would scroll the page out from under the menu.
 *  - `env(safe-area-inset-bottom)` keeps the last row clear of the iPhone
 *    home indicator and the Telegram WebApp's own bottom chrome.
 *  - The body never scrolls the page behind it (`overscroll-contain`).
 *  - `100dvh` rather than `100vh`, so the sheet is sized by the VISIBLE
 *    viewport and is not taller than the screen when the mobile keyboard or a
 *    collapsing URL bar is in play.
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from './button'
import { DialogActions } from './dialog-actions'
import { X } from './icon'

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  className,
}: {
  readonly open: boolean
  readonly onClose: () => void
  /** Used as the panel's accessible name when it is a plain string. */
  readonly title: ReactNode
  readonly children: ReactNode
  /** Pinned action row; the body scrolls, the footer never leaves the sheet. */
  readonly footer?: ReactNode
  readonly className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const { t } = useTranslation()

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const target =
      ref.current?.querySelector<HTMLElement>('[data-sheet-autofocus]') ??
      ref.current?.querySelector<HTMLElement>('button')
    target?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-overlay motion-safe:animate-[drawer-scrim-in_150ms_ease-out]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cn(
          'flex max-h-[85dvh] w-full flex-col rounded-t-xl border-t border-border-strong bg-surface-dialog shadow-xl',
          'pb-[env(safe-area-inset-bottom)] motion-safe:animate-[sheet-panel-in_200ms_cubic-bezier(0.22,1,0.36,1)]',
          className,
        )}
      >
        {/* The drag affordance is decorative: it signals that this panel is a
            layer that came from the bottom edge, which is what a sheet is. */}
        <div aria-hidden className="flex justify-center pt-2">
          <span className="h-1 w-10 rounded-full bg-border-strong" />
        </div>

        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <h2 className="text-section truncate">{title}</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t('app.close')}
          >
            <X size={16} aria-hidden />
          </Button>
        </div>

        {/* The body owns the scroll so the header and footer stay put on a
            short screen; `min-h-0` is what lets a flex child actually shrink,
            and `overscroll-contain` stops the page behind from moving. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
          {children}
        </div>

        {footer ? (
          <DialogActions className="border-t border-border-subtle px-4 py-3">
            {footer}
          </DialogActions>
        ) : null}
      </div>
    </div>
  )
}
