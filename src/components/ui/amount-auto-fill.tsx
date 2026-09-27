/**
 * Amount auto-fill shortcut — the ONE reusable "fill this field with a known
 * amount" control.
 *
 * A POS shortcut that shows a bare number next to an amount input is
 * indistinguishable from a second amount field, and repeating the same number
 * twice reads as a mistake. This component makes the intent explicit instead:
 *
 *   * it is a compact ACTION, not a value — a dashed outline, a spark icon and
 *     a muted amount mark it as an affordance rather than a reading;
 *   * it carries visible text saying what pressing it does, so the cashier
 *     understands it without hovering;
 *   * `active` marks the state where the field already holds this amount, so
 *     the shortcut never looks like a second, equal control;
 *   * it is a real `<button>`, so it is tabbable, activates with Enter/Space
 *     and is announced — the shared Button's focus-visible ring applies.
 *
 * The caller owns the amount and the field value: this component never
 * computes money and never holds its own copy of the input.
 */
import { Button } from './button'
import { MoneyDisplay } from './money'
import { Sparkles } from './icon'
import { cn } from '@/lib/utils'

export function AmountAutoFill({
  amount,
  /** What pressing it does, e.g. «ملء المبلغ المستلم». */
  label,
  /** Visible affordance text shown beside/below the control. */
  hint,
  active = false,
  disabled = false,
  onFill,
  className,
}: {
  readonly amount: number
  readonly label: string
  readonly hint?: string
  /** The field already holds this amount. */
  readonly active?: boolean
  readonly disabled?: boolean
  readonly onFill: () => void
  readonly className?: string
}) {
  return (
    <div className={cn('flex flex-col items-start gap-0.5', className)}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        // Dashed + muted: an affordance, deliberately unlike the solid
        // controls that commit a value.
        className={cn(
          'border-dashed font-normal',
          active ? 'border-primary text-primary' : 'text-foreground-muted hover:text-foreground',
        )}
        aria-pressed={active}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={onFill}
      >
        <Sparkles size={14} aria-hidden />
        <MoneyDisplay amount={amount} className={cn(!active && 'opacity-80')} />
      </Button>
      {hint ? <span className="text-caption text-foreground-subtle">{hint}</span> : null}
    </div>
  )
}
