/** Toast notifications — no browser alert()/confirm() anywhere. */
import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type ToastTone = 'success' | 'error' | 'info'
interface Toast {
  id: number
  tone: ToastTone
  message: string
}

const ToastCtx = createContext<{
  toast: (message: string, tone?: ToastTone) => void
} | null>(null)

let nextId = 1

export function ToastProvider({ children }: Readonly<{ readonly children: ReactNode }>) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const toast = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = nextId++
    setToasts((t) => [...t, { id, tone, message }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000)
  }, [])

  const value = useMemo(() => ({ toast }), [toast])
  return (
    <ToastCtx.Provider value={value}>
      {children}
      {/*
        The toast stack's own placement, and both of its problems were real:

        - `w-80` is 320px, so `left-4` put the right-hand edge 16px PAST a 320px
          viewport. Below `sm` the stack is `inset-x-3` — a `calc(100% - 1.5rem)`
          track — so a toast is always inside the screen whatever its width.
        - `bottom-4` put the stack UNDER the phone's fixed bottom navigation, so
          a confirmation was invisible exactly when it mattered. Below `md` the
          stack is lifted by the bar's own height plus the safe-area inset, which
          is the same figure `AppShell` reserves as page padding.

        Logical properties throughout, so it mirrors correctly in RTL.
      */}
      <div
        aria-live="polite"
        className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-60 flex flex-col gap-2 sm:inset-x-auto sm:bottom-4 sm:left-4 sm:w-80"
      >
        {toasts.map((t) => (
          <output
            key={t.id}
            className={cn(
              'block rounded-md border px-4 py-3 text-sm shadow-md',
              t.tone === 'success' &&
                'border-success-border bg-success-soft text-success-foreground',
              t.tone === 'error' &&
                'border-destructive-border bg-destructive-soft text-destructive-soft-foreground',
              t.tone === 'info' && 'border-info-border bg-info-soft text-foreground-strong',
            )}
          >
            {t.message}
          </output>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastCtx)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx.toast
}
