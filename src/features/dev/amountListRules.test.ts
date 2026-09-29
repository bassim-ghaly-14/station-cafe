/**
 * The list rules behind the dev settings' amount lists, checked on their own.
 *
 * The order of a service-charge or discount list is itself the setting, so
 * "move up", "move down" and "remove" each have to touch exactly one entry and
 * leave the rest alone — and a move off either end must change nothing at all.
 */
import { describe, expect, it } from 'vitest'

import {
  acceptAmountDraft,
  isAllowedAmountKey,
  moveAmount,
  parseAmountDraft,
  removeAmountAt,
  replaceAmountAt,
} from './amountListRules'

const LIST = ['10', '20', '30']

describe('replaceAmountAt', () => {
  it('changes only the addressed entry and keeps the order', () => {
    expect(replaceAmountAt(LIST, 1, '25')).toEqual(['10', '25', '30'])
  })
})

describe('removeAmountAt', () => {
  it('drops only the addressed entry', () => {
    expect(removeAmountAt(LIST, 0)).toEqual(['20', '30'])
    expect(removeAmountAt(LIST, 2)).toEqual(['10', '20'])
  })
})

describe('moveAmount', () => {
  it('swaps an entry with its neighbour, in both directions', () => {
    expect(moveAmount(LIST, 1, -1)).toEqual(['20', '10', '30'])
    expect(moveAmount(LIST, 1, 1)).toEqual(['10', '30', '20'])
  })

  it('is a no-op at either end, never a wrap-around', () => {
    expect(moveAmount(LIST, 0, -1)).toEqual(LIST)
    expect(moveAmount(LIST, 2, 1)).toEqual(LIST)
  })
})

/**
 * The whole-amount rule behind the Dev Settings amount fields.
 *
 * The boundary matters more than the arithmetic: a refused draft must never
 * become state, so the field keeps the last whole number it accepted rather
 * than being rounded under the cursor.
 */
describe('parseAmountDraft', () => {
  it('accepts the whole amounts a manager actually types', () => {
    for (const raw of ['1', '5', '10', '50', '100', '500', '1000']) {
      expect(parseAmountDraft(raw)).toBe(Number(raw))
    }
  })

  it('refuses a decimal rather than rounding it', () => {
    // 10.5 must not become 11, and 100.25 must not become 100: silently
    // rounding is a different value from the one that was typed.
    expect(parseAmountDraft('10.5')).toBeNull()
    expect(parseAmountDraft('100.25')).toBeNull()
    expect(parseAmountDraft('1.5')).toBeNull()
    expect(parseAmountDraft('0.5')).toBeNull()
  })

  it('refuses the numeric formats that are not integer input for this field', () => {
    // `Number()` evaluates every one of these, which is exactly why the text
    // has to be matched rather than converted.
    expect(parseAmountDraft('1e2')).toBeNull()
    expect(parseAmountDraft('1E2')).toBeNull()
    expect(parseAmountDraft('+')).toBeNull()
    expect(parseAmountDraft('-')).toBeNull()
    expect(parseAmountDraft('-10')).toBeNull()
    expect(parseAmountDraft('+10')).toBeNull()
    expect(parseAmountDraft(' 10 ')).toBeNull()
    expect(parseAmountDraft('10,5')).toBeNull()
    expect(parseAmountDraft('abc')).toBeNull()
  })

  it('refuses the empty draft, which is a moment of editing rather than an amount', () => {
    expect(parseAmountDraft('')).toBeNull()
  })
})

describe('acceptAmountDraft', () => {
  it('passes a whole amount through unchanged', () => {
    expect(acceptAmountDraft('10')).toBe('10')
    expect(acceptAmountDraft('100')).toBe('100')
    expect(acceptAmountDraft('500')).toBe('500')
  })

  it('refuses a decimal, an exponent and a sign, so the last value stands', () => {
    expect(acceptAmountDraft('10.5')).toBeNull()
    expect(acceptAmountDraft('100.25')).toBeNull()
    expect(acceptAmountDraft('1e2')).toBeNull()
    expect(acceptAmountDraft('1E2')).toBeNull()
    expect(acceptAmountDraft('+')).toBeNull()
    expect(acceptAmountDraft('-')).toBeNull()
  })

  it('lets the caller clear the field, which is how a fresh amount is started', () => {
    expect(acceptAmountDraft('')).toBe('')
  })
})

/**
 * The keystroke guard, which has to exist BECAUSE of `type="number"`.
 *
 * A number field sanitises a value it cannot represent, so "+" and "-" never
 * arrive as text — the field just reports "". A value-level rule cannot tell
 * that apart from a deliberate clear, and refusing it would make the field
 * impossible to empty.
 */
describe('isAllowedAmountKey', () => {
  it('lets the digits through', () => {
    for (const digit of ['0', '1', '5', '9']) {
      expect(isAllowedAmountKey(digit)).toBe(true)
    }
  })

  it('stops the keys that build a decimal, an exponent or a sign', () => {
    for (const key of ['.', ',', 'e', 'E', '+', '-', 'a', '/', ' ']) {
      expect(isAllowedAmountKey(key)).toBe(false)
    }
  })

  it('leaves the editing and navigation keys alone, so the field stays usable', () => {
    // Named keys have a length greater than one; stopping them would make the
    // amount impossible to clear, retype or navigate.
    for (const key of ['Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight', 'Enter', 'F5']) {
      expect(isAllowedAmountKey(key)).toBe(true)
    }
  })
})
