import { cn } from '@/lib/utils'
import type { InputHTMLAttributes, LabelHTMLAttributes, TextareaHTMLAttributes } from 'react'

const base =
  'w-full rounded-md border border-brand-300 bg-surface-raised px-3 py-2 text-base text-brand-950 placeholder:text-brand-400 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-600 disabled:opacity-50'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(base, 'h-10', className)} {...props} />
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(base, 'min-h-20', className)} {...props} />
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-base font-bold text-brand-800', className)} {...props} />
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

/**
 * Password input with an accessible visibility toggle (eye / eye-off).
 * RTL-friendly: the toggle sits at the inline-end edge; layout is untouched.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff } from './icon'

export function PasswordInput({
  className,
  id,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)

  return (
    <div className="relative">
      <input
        {...props}
        id={id}
        type={visible ? 'text' : 'password'}
        className={cn(className, 'pe-10')}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? t('auth.hidePassword') : t('auth.showPassword')}
        aria-pressed={visible}
        className="absolute inset-y-0 end-2 my-auto flex h-7 w-7 items-center justify-center rounded text-brand-500 hover:bg-brand-100 hover:text-brand-800 focus-visible:outline-2 focus-visible:outline-brand-600"
      >
        {visible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
      </button>
    </div>
  )
}
