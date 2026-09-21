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

export function ToastProvider({ children }: { children: ReactNode }) {
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
      <div aria-live="polite" className="fixed bottom-4 left-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              'rounded-md border px-4 py-3 text-sm shadow-md',
              t.tone === 'success' && 'border-green-200 bg-green-50 text-green-900',
              t.tone === 'error' && 'border-red-200 bg-red-50 text-red-900',
              t.tone === 'info' && 'border-brand-200 bg-surface-raised text-brand-900',
            )}
          >
            {t.message}
          </div>
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
