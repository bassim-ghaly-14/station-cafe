/**
 * Accessible dialog (no Radix dependency): overlay + focus handling +
 * Escape-to-close. Focused, minimal — matches the app's design tokens.
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Dialog({
  open,
  onClose,
  title,
  children,
  className,
  wide,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  className?: string
  wide?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const el = ref.current
    el?.querySelector<HTMLElement>('input, button, select, textarea')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-brand-950/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        className={cn(
          'max-h-[90vh] w-full overflow-y-auto rounded-lg border border-brand-200 bg-surface-raised p-5 shadow-xl',
          wide ? 'max-w-2xl' : 'max-w-md',
          className,
        )}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-base font-bold text-brand-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="rounded p-1 text-brand-500 hover:bg-brand-100 hover:text-brand-800"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
