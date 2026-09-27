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
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly title: ReactNode
  readonly children: ReactNode
  readonly className?: string
  readonly wide?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const { t } = useTranslation()

  // Keep the latest callback without making it an effect dependency.
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const el = ref.current
    const target =
      el?.querySelector<HTMLElement>('[data-dialog-autofocus]') ??
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
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
          'max-h-[90vh] w-full overflow-y-auto rounded-lg border border-border-strong bg-surface-dialog p-5 shadow-xl',
          wide ? 'max-w-2xl' : 'max-w-md',
          className,
        )}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-base font-bold text-foreground-strong">{title}</h2>
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
        {children}
      </div>
    </div>
  )
}
