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
  readonly label: string
  readonly error?: string | null
  /** Non-validating explanatory text shown under the control. */
  readonly hint?: string
  readonly children: React.ReactNode
  readonly htmlFor?: string
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

/**
 * Track/thumb colors per switch tone. Every entry is a SEMANTIC token class —
 * no hex — so a switch never hardcodes a color and never borrows an identity
 * that does not describe it.
 *
 * - `new`  — the "new item" accent. It stays the default because the catalog's
 *   NEW toggle deliberately matches the magenta card frame/ribbon it sits next
 *   to; turning a switch green there would break that pairing.
 * - `state` — the plain on/off reading: a green track when ON and a soft
 *   neutral when OFF. Used by switches that report a CONDITION (is this
 *   category visible?) rather than an item identity.
 */
const SWITCH_TONES = {
  new: {
    on: 'border-new-border bg-new-soft',
    off: 'border-border-strong bg-surface-muted',
    onThumb: 'bg-new',
    offThumb: 'bg-foreground-muted',
  },
  state: {
    on: 'border-switch-on-track-border bg-switch-on-track',
    off: 'border-switch-off-track-border bg-switch-off-track',
    onThumb: 'bg-switch-on-thumb',
    offThumb: 'bg-switch-off-thumb',
  },
} as const

/**
 * Accessible on/off switch.
 *
 * A real `<button role="switch" aria-checked>` rather than a styled checkbox,
 * because the catalog's "new item" control must be operable with the keyboard,
 * announce its state, and expose a visible focus ring in both themes. The label
 * is a visible sibling text, so no `aria-label` is needed here; callers that
 * render an icon-only switch pass `label`.
 *
 * The color identity is a per-caller `tone` rather than a fixed one, because
 * the two jobs are genuinely different: `new` matches the NEW item accent, and
 * `state` is the conventional green-on / neutral-off switch.
 *
 * RTL-safe: the knob travels with logical inset properties, so the switch
 * reads "on to the right" in Arabic exactly as it does "on to the left" in LTR.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  id,
  disabled,
  tone = 'new',
  className,
}: {
  readonly checked: boolean
  readonly onCheckedChange: (checked: boolean) => void
  /** Accessible name; required when no visible label element is associated. */
  readonly label?: string
  readonly id?: string
  readonly disabled?: boolean
  /**
   * Which semantic identity paints the track and thumb. Defaults to `new` so
   * existing callers keep their current appearance; pass `state` for a switch
   * that reports a condition rather than an item's "new" identity.
   */
  readonly tone?: keyof typeof SWITCH_TONES
  readonly className?: string
}) {
  const palette = SWITCH_TONES[tone]
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative h-6 w-11 shrink-0 cursor-pointer rounded-full border transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        'disabled:cursor-not-allowed disabled:opacity-70',
        checked ? palette.on : palette.off,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full transition-[inset-inline-start]',
          'motion-reduce:transition-none',
          checked
            ? `inset-s-[calc(100%-1.375rem)] ${palette.onThumb}`
            : `inset-s-1.5 ${palette.offThumb}`,
        )}
      />
    </button>
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
  return new RegExp(String.raw`^\d{${DISCOUNT_PIN_LENGTH}}$`).test(value)
}
