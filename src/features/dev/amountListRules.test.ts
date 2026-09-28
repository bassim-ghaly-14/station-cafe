/**
 * The list rules behind the dev settings' amount lists, checked on their own.
 *
 * The order of a service-charge or discount list is itself the setting, so
 * "move up", "move down" and "remove" each have to touch exactly one entry and
 * leave the rest alone — and a move off either end must change nothing at all.
 */
import { describe, expect, it } from 'vitest'

import { moveAmount, removeAmountAt, replaceAmountAt } from './amountListRules'

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
