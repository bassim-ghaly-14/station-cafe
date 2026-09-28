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
 */
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui'
import { ArrowRight, Plus, Trash2 } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'

import { moveAmount, removeAmountAt, replaceAmountAt } from './amountListRules'

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
          <div key={amount} className="flex min-w-0 items-center gap-2">
            <Input
              type="number"
              min="0.01"
              step="0.01"
              aria-label={`${label} ${index + 1}`}
              value={amount}
              className="w-24 min-w-0 flex-none"
              onChange={(e) => onChange(replaceAmountAt(amounts, index, e.target.value))}
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
