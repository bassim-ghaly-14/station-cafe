import { describe, expect, it } from 'vitest'
import { discountLabelFor } from './orderDiscountLabel'

// The discount already on an order is shown read-only, next to the totals. This
// decides how that figure is written, so each branch is pinned: a FIXED
// discount is money, a legacy PERCENT discount is a per-mille figure, and a
// half-set discount has no label at all rather than a misleading zero.
describe('discountLabelFor', () => {
  it('writes a FIXED discount as money', () => {
    const label = discountLabelFor({ mode: 'FIXED', value: 1500 })
    expect(label).not.toBeNull()
    expect(label).toContain('15')
  })

  it('writes a legacy PERCENT discount as the per-mille figure it stores', () => {
    expect(discountLabelFor({ mode: 'PERCENT', value: 1000 })).toBe('1%')
    expect(discountLabelFor({ mode: 'PERCENT', value: 1250 })).toBe('1.25%')
  })

  it('has no label when no discount mode is set', () => {
    expect(discountLabelFor({ mode: null, value: 1500 })).toBeNull()
  })

  it('has no label when the mode carries no usable value', () => {
    expect(discountLabelFor({ mode: 'FIXED', value: null })).toBeNull()
    expect(discountLabelFor({ mode: 'PERCENT', value: null })).toBeNull()
  })

  it('has no label for a mode it does not recognise', () => {
    expect(discountLabelFor({ mode: 'SOMETHING_NEW', value: 1500 })).toBeNull()
  })
})
