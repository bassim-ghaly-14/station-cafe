import { cn } from '@/lib/utils'
import type { InputHTMLAttributes, LabelHTMLAttributes, TextareaHTMLAttributes } from 'react'

const base =
  'w-full rounded-md border border-brand-300 bg-surface-raised px-3 py-2 text-sm text-brand-950 placeholder:text-brand-400 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-600 disabled:opacity-50'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(base, 'h-10', className)} {...props} />
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(base, 'min-h-20', className)} {...props} />
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-sm font-medium text-brand-800', className)} {...props} />
}

/** Form field with label, optional hint and error (Arabic messages). */
export function Field({
  label,
  error,
  children,
  htmlFor,
}: {
  label: string
  error?: string | null
  children: React.ReactNode
  htmlFor?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  )
}
