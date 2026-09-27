/**
 * Accessible side panel (no Radix dependency): scrim + focus handling +
 * Escape-to-close, anchored to the INLINE END of the viewport so it opens on
 * the reading side in RTL without a direction-specific class.
 *
 * It is the counterpart of `Dialog` for content that is taller than a dialog
 * should be: a record with identity, statistics and a history reads as a panel
 * BESIDE the list, so the list behind it stays visible and the user never loses
 * their place. The page itself is untouched — there is no navigation.
 *
 * Focus lifecycle matches `Dialog`: initial focus runs once per opening (driven
 * by the `open` transition only, so re-renders never steal the field the user
 * is typing in), and `onClose` is read through a ref because callers pass an
 * inline arrow whose identity changes every render.
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from './button'
import { X } from './icon'

const FOCUSABLE = 'input, button, select, textarea, [tabindex]'

/**
 * Preset widths. Every one is `w-full` with a `max-width`, so a narrow window
 * gets a full-width panel and only a wide one gets the capped measurement —
 * there is no hardcoded pixel width that can break a supported screen.
 */
const WIDTHS = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-xl',
  lg: 'sm:max-w-2xl lg:max-w-[46rem]',
} as const

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  header,
  width = 'md',
  className,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly title: ReactNode
  /** Optional second line under the title, rendered by the caller. */
  readonly subtitle?: ReactNode
  readonly children: ReactNode
  /** Pinned action row; the body scrolls, the footer never leaves the panel. */
  readonly footer?: ReactNode
  /**
   * Replaces the default title block in the header while the panel keeps
   * `title` as its accessible name. A caller with a richer header (an avatar,
   * badges) opts in here instead of forking the whole primitive.
   */
  readonly header?: ReactNode
  /** Preset widths. All are `w-full` first, so narrow screens stay intact. */
  readonly width?: 'sm' | 'md' | 'lg'
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
    const el = ref.current
    const target =
      el?.querySelector<HTMLElement>('[data-drawer-autofocus]') ??
      el?.querySelector<HTMLElement>(FOCUSABLE)
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
      className="fixed inset-0 z-50 flex justify-end overflow-hidden bg-overlay motion-safe:animate-[drawer-scrim-in_150ms_ease-out]"
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
          'flex h-full w-full flex-col border-s border-border-strong bg-surface-dialog shadow-xl motion-safe:animate-[drawer-panel-in_180ms_cubic-bezier(0.22,1,0.36,1)]',
          WIDTHS[width],
          className,
        )}
      >
        {/* The header sits OUTSIDE the scrolling body, so it is already sticky
            with no scroll listener and no layout jitter. */}
        <div className="flex items-start justify-between gap-4 border-b border-border-subtle bg-surface-dialog px-5 py-4">
          {header ?? (
            <div className="min-w-0">
              <h2 className="text-section truncate">{title}</h2>
              {subtitle ? <div className="mt-0.5 text-caption">{subtitle}</div> : null}
            </div>
          )}
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
            short window; `min-h-0` is what lets a flex child actually shrink. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {children}
        </div>

        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}
