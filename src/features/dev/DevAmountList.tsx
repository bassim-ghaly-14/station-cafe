/**
 * The editable amount list the dev settings use for the service-charge and
 * discount quick-pick options.
 *
 * The two lists are the same decision — an ordered, editable set of money
 * options — and they were written out twice, which is exactly the kind of copy
 * that drifts: the discount list quietly lost the reorder buttons and the two
 * could end up validating differently. One component, one set of list rules.
 *
 * The list operations are named rather than inlined, so "replace this one",
 * "remove this one" and "swap with its neighbour" read as what they do and the
 * three list states — the first item cannot move up, the last cannot move down,
 * and a single item has neither — are stated once.
 *
 * WHOLE AMOUNTS ONLY. A service charge or a quick-pick discount is set in whole
 * pounds here, so the EXISTING `<input>` is integer-oriented: `step={1}` gives
 * the browser's own arrows a step of one (10 → 11 → 12, and back),
 * `isAllowedAmountKey` stops a ".", an "e" or a sign at the keystroke, and
 * `acceptAmountDraft` refuses anything non-integer that still reaches `onChange`
 * — nothing is ever rounded. Two guards are needed because a number field
 * SANITISES what it cannot represent: a typed "+" arrives as "", which is
 * indistinguishable from a deliberate clear, so it has to be stopped as a key.
 * This is a Dev Settings presentation rule for these two lists only — it says
 * nothing about how money is represented or stored anywhere else. The rows
 * themselves are untouched: the same single input, the same reorder buttons, the
 * same remove button, no second field and no second set of controls.
 *
 * REACT IDENTITY IS POSITION, NEVER THE AMOUNT. An earlier version keyed each
 * row by its own value, which meant that the single keystroke that changed the
 * value also changed the key: React unmounted the row and mounted a fresh
 * `<input>`, so the field the user was typing into was destroyed after exactly
 * one character and had to be clicked again. The order of the list is itself
 * the setting and an entry is addressed by where it sits, so the index is the
 * row's identity — the same reasoning `ThermalReceipt` uses for its ops.
 */
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui'
import { ArrowRight, Plus, Trash2 } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'

import {
  acceptAmountDraft,
  isAllowedAmountKey,
  moveAmount,
  removeAmountAt,
  replaceAmountAt,
} from './amountListRules'

export function DevAmountList({
  label,
  amounts,
  onChange,
  addLabel,
  removeLabel,
  reorderable = false,
  className,
}: {
  /** The field label; also the accessible name prefix of each amount field. */
  readonly label: string
  readonly amounts: string[]
  readonly onChange: (next: string[]) => void
  readonly addLabel: string
  readonly removeLabel: string
  /** Whether an entry can be moved up or down within the list. */
  readonly reorderable?: boolean
  readonly className?: string
}) {
  const { t } = useTranslation()

  return (
    <div className={className}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {amounts.map((amount, index) => (
          <div key={index} className="flex min-w-0 items-center gap-2">
            <Input
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              aria-label={`${label} ${index + 1}`}
              value={amount}
              className="w-24 min-w-0 flex-none"
              onKeyDown={(e) => {
                // The guard that `onChange` cannot be: a browser sanitises a
                // "+" or "-" typed into a number field to "", which is
                // indistinguishable from a deliberate clear. Stopping the key is
                // the only place where the two are still different.
                if (!isAllowedAmountKey(e.key)) e.preventDefault()
              }}
              onChange={(e) => {
                // A fraction, an exponent or a bare sign is refused HERE rather
                // than rounded: the field simply keeps showing the last whole
                // number it accepted, and the native stepper arrows (step=1)
                // move that whole number by exactly one.
                const next = acceptAmountDraft(e.target.value)
                if (next === null) return

                onChange(replaceAmountAt(amounts, index, next))
              }}
            />

            {reorderable ? (
              <>
                <Button
                  size="icon"
                  variant="outline"
                  disabled={index === 0}
                  aria-label={t('dev.moveUp')}
                  onClick={() => onChange(moveAmount(amounts, index, -1))}
                >
                  <ArrowRight size={16} aria-hidden className="rotate-90" />
                </Button>

                <Button
                  size="icon"
                  variant="outline"
                  disabled={index === amounts.length - 1}
                  aria-label={t('dev.moveDown')}
                  onClick={() => onChange(moveAmount(amounts, index, 1))}
                >
                  <ArrowRight size={16} aria-hidden className="-rotate-90" />
                </Button>
              </>
            ) : null}

            <Button
              size="icon"
              variant="destructiveGhost"
              aria-label={removeLabel}
              onClick={() => onChange(removeAmountAt(amounts, index))}
            >
              <Trash2 size={16} aria-hidden />
            </Button>
          </div>
        ))}
      </div>

      <Button variant="outline" className="self-start" onClick={() => onChange([...amounts, ''])}>
        <Plus size={16} aria-hidden />
        {addLabel}
      </Button>
    </div>
  )
}
