import { cn } from '@/lib/utils'
import type { InputHTMLAttributes, LabelHTMLAttributes, TextareaHTMLAttributes } from 'react'

const base =
  'w-full rounded-md border border-border-strong bg-surface-input px-3 py-2 text-base text-foreground placeholder:text-placeholder-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:border-border disabled:bg-surface-muted disabled:text-foreground-disabled disabled:opacity-70'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(base, 'h-10', className)} {...props} />
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(base, 'min-h-20', className)} {...props} />
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-base font-bold text-foreground-muted', className)} {...props} />
}

/** Form field with label, optional hint and error (Arabic messages). */
export function Field({
  label,
  error,
  hint,
  children,
  htmlFor,
}: {
  label: string
  error?: string | null
  /** Non-validating explanatory text shown under the control. */
  hint?: string
  children: React.ReactNode
  htmlFor?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && !error ? <p className="text-caption">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
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
        className={cn(base, 'h-10', 'pe-11', className)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? t('auth.hidePassword') : t('auth.showPassword')}
        aria-pressed={visible}
        className="absolute inset-y-0 inset-e-2 my-auto flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground active:bg-surface-active"
      >
        {visible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
      </button>
    </div>
  )
}

/** The shared discount authorization PIN is exactly 4 ASCII digits. */
export const DISCOUNT_PIN_LENGTH = 4

/**
 * 4-digit numeric PIN field for the cafe's ONE shared discount PIN.
 *
 * The value is a STRING throughout, so a PIN with leading zeros (`0097`) is
 * never normalized into a number. Input is `dir="ltr"` (digits read left to
 * right in the Arabic RTL UI) and masked, with the four digits spaced so the
 * POS can count them at a glance.
 *
 * Only the characters the contract allows are accepted: non-digits are dropped
 * as they are typed, and the value is capped at four digits. The backend
 * re-validates the exact same rule — this is convenience, never security.
 */
export function PinInput({
  className,
  id,
  value,
  onValueChange,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: string
  onValueChange: (value: string) => void
}) {
  return (
    <input
      {...props}
      id={id}
      type="password"
      inputMode="numeric"
      autoComplete="one-time-code"
      dir="ltr"
      maxLength={DISCOUNT_PIN_LENGTH}
      value={value}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D+/g, '').slice(0, DISCOUNT_PIN_LENGTH)
        onValueChange(digits)
      }}
      className={cn(
        base,
        'h-12 text-center font-mono text-2xl tracking-[0.6em] ps-[0.6em]',
        className,
      )}
    />
  )
}

/** Whether a string is a well-formed shared discount PIN (4 ASCII digits). */
export function isValidDiscountPin(value: string): boolean {
  return new RegExp(`^\\d{${DISCOUNT_PIN_LENGTH}}$`).test(value)
}
