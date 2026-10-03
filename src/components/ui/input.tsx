import { cloneElement, isValidElement, useId, useState } from 'react'
import type { InputHTMLAttributes, LabelHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const base =
  'w-full rounded-md border border-border-strong bg-surface-input px-3 py-2 text-base text-foreground placeholder:text-placeholder-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:border-border disabled:bg-surface-muted disabled:text-foreground-disabled disabled:opacity-70'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(base, 'h-10', className)} {...props} />
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(base, 'min-h-20', className)} {...props} />
}

/**
 * A form label. It REQUIRES `htmlFor`: a label with no control is not a label,
 * it is unassociated text that a screen reader reads twice.
 *
 * `htmlFor` is destructured rather than left in the rest-spread on purpose. The
 * association is the one attribute this component exists to get right, so it is
 * named at the element instead of arriving invisibly through a spread — which
 * also means a future edit cannot quietly drop it.
 */
export function Label({
  className,
  htmlFor,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement> & { readonly htmlFor: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn('text-base font-bold text-foreground-muted', className)}
      {...props}
    />
  )
}

/**
 * Form field with label, optional hint and error (Arabic messages).
 *
 * The label is always associated with the control. When the caller does not
 * name the control itself, a stable id is generated here and applied to both the
 * label and the single child control, so clicking the label focuses the input
 * and assistive technology announces the pair together. A caller that already
 * sets an id — or passes `htmlFor` for a control rendered elsewhere — keeps
 * exactly what it declared.
 */
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
  const generatedId = useId()
  // Only a single element child can take an id. Anything else (a fragment, a
  // wrapper the caller controls) is left exactly as it was passed in.
  const control = isValidElement<{ id?: string }>(children) ? children : null
  const id = htmlFor ?? control?.props.id ?? generatedId

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {control && control.props.id === undefined && !htmlFor
        ? cloneElement(control, { id })
        : children}
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
 * THE password/PIN visibility implementation — the single source of truth for
 * whether a typed credential is masked. Every credential field in the app is
 * this control: a plain text password, and `PinInput` (the numeric 4–5 digit
 * variant the login screen, the employee dialog and the discount authorization
 * dialogs use), which renders THIS component and therefore shares its toggle
 * rather than re-implementing one.
 *
 * It is a pure UI abstraction: no credential rule, length rule or validation
 * lives here. Toggling flips `type` between `password` and `text` and nothing
 * else — the value, its length, its direction and its autocomplete are the
 * caller's, untouched.
 *
 * The toggle is DERIVED from the value rather than always rendered: an empty
 * field has nothing to reveal, so an eye sitting on it is a control that lies
 * about what it can do. It appears the moment there is plaintext to show and
 * goes again the moment the field is cleared. An EMPTY field therefore states
 * what it is — nothing entered yet — which is what makes it safe to reuse for a
 * stored credential the application cannot read back (see `EmployeeDialog`).
 *
 * RTL-friendly: the toggle sits at the inline-end edge (the LEFT side in the
 * Arabic UI) via logical properties, so it follows the text direction.
 */
import { useTranslation } from 'react-i18next'
import { Button } from './button'
import { Eye, EyeOff } from './icon'

export function PasswordInput({
  className,
  id,
  disabled,
  dir,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const { t } = useTranslation()
  /*
   * Whether there is anything to reveal.
   *
   * A controlled consumer (`PinInput` always is) states the value outright; an
   * uncontrolled one is mirrored here from `defaultValue` and every change, so
   * the derivation works for both without a new prop.
   */
  const [typed, setTyped] = useState(() => String(props.value ?? props.defaultValue ?? ''))
  const value = props.value === undefined ? typed : String(props.value)
  /*
   * What is currently revealed, tracked as the VALUE it was revealed at rather
   * than as a boolean. It is what makes "show/hide" honest about the one case a
   * boolean gets wrong: any change to the field — typing, pasting, clearing —
   * means the plaintext on screen is no longer the value the eye was opened
   * for, so it re-masks instead of leaving a stale reveal behind.
   */
  const [revealed, setRevealed] = useState<string | null>(null)
  const isRevealed = revealed !== null && revealed === value && value !== ''
  const onChange = props.onChange

  return (
    /*
     * The wrapper carries the control's OWN `direction`, so the toggle and the
     * reserved padding are always resolved against the SAME direction.
     *
     * `inset-inline-end` and `padding-inline-end` each resolve against the
     * computed `direction` of the element they are declared on. When a consumer
     * forces `dir="ltr"` on the input — which `PinInput` must, so digits read
     * left to right — the input's `padding-inline-end` resolves to its RIGHT,
     * while a toggle positioned in an RTL wrapper resolves to the wrapper's
     * LEFT. The two land on opposite edges: the reserve stops protecting the
     * space the eye actually occupies, and the centred digits slide underneath
     * it. Mirroring `dir` onto the wrapper keeps both on one edge.
     */
    <div className="relative" dir={dir}>
      <input
        {...props}
        id={id}
        dir={dir}
        disabled={disabled}
        onChange={(event) => {
          setTyped(event.target.value)
          onChange?.(event)
        }}
        type={isRevealed ? 'text' : 'password'}
        // The inline-end strip is reserved only while the toggle occupies it.
        className={cn(base, 'h-10', value !== '' && 'pe-11', className)}
      />
      {value !== '' ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          // A disabled field has nothing to reveal, so the toggle goes with it.
          disabled={disabled}
          onClick={() => setRevealed(isRevealed ? null : value)}
          aria-label={isRevealed ? t('auth.hidePassword') : t('auth.showPassword')}
          aria-pressed={isRevealed}
          // Positioned with LOGICAL properties, so in the Arabic RTL layout the
          // toggle sits at the inline-end (left) edge and follows the direction.
          className="absolute inset-y-0 inset-e-2 my-auto"
        >
          {isRevealed ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
        </Button>
      ) : null}
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
 *
 * `length` exists because the LOGIN PIN is the same kind of control with a
 * different maximum (the credential policy allows four to five digits). One
 * component with a length prop beats a second, near-identical PIN input that
 * could drift from this one.
 *
 * The visibility toggle is NOT re-implemented here: this renders
 * `PasswordInput`, so a PIN reveals exactly the way a password does, from the
 * same state, with the same accessible name. Normalization, capping and paste
 * handling stay exactly as they are — the toggle only flips the input's `type`.
 */
export function PinInput({
  className,
  id,
  value,
  onValueChange,
  length = DISCOUNT_PIN_LENGTH,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: string
  onValueChange: (value: string) => void
  /** Maximum accepted digits. Defaults to the discount PIN's fixed four. */
  length?: number
}) {
  return (
    <PasswordInput
      {...props}
      id={id}
      inputMode="numeric"
      autoComplete="one-time-code"
      dir="ltr"
      maxLength={length}
      value={value}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D+/g, '').slice(0, length)
        onValueChange(digits)
      }}
      // A paste carries whatever the clipboard held, so the same normalization
      // has to run on it. `maxLength` alone would let a pasted `1234-5678` in as
      // a five-character string the backend must then reject, instead of the
      // field quietly keeping the five digits it is allowed to hold.
      onPaste={(e) => {
        const pasted = e.clipboardData.getData('text')
        if (pasted && pasted.replace(/\D+/g, '').length <= length) return
        e.preventDefault()
        onValueChange(pasted.replace(/\D+/g, '').slice(0, length))
      }}
      // The trailing `pe` reserves the inline-end strip the visibility toggle
      // occupies, so the centred digits never slide underneath it. `h-12` and
      // the mono tracking override `PasswordInput`'s default `h-10`.
      className={cn(
        'h-12 text-center font-mono text-2xl tracking-[0.6em] ps-[0.6em]',
        // Only while there is something for the toggle to reveal.
        value.length > 0 && 'pe-14',
        className,
      )}
    />
  )
}

/** Whether a string is a well-formed shared discount PIN (4 ASCII digits). */
// The PIN validator belongs with the PIN input it validates, and shares its
// length constant.
// oxlint-disable-next-line react/only-export-components
export function isValidDiscountPin(value: string): boolean {
  return new RegExp(String.raw`^\d{${DISCOUNT_PIN_LENGTH}}$`).test(value)
}
