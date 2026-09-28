import { formatMinorMoney } from '@/lib/money'
import type { DiscountSel } from '@/services/posApi'

/**
 * The read-only label for the discount already on an order.
 *
 * A FIXED discount is labelled with the money it actually removes, formatted as
 * money. A PERCENT selection is the legacy shape and is rendered as the number
 * it is, in per-mille, with no currency marker — it is a figure, not an amount.
 *
 * Anything else has no label: no mode, or a mode with no numeric value, which
 * is a half-set discount the backend has not confirmed. Showing "0" there would
 * be a lie about the order's total.
 *
 * This decides how money is shown on an open order, so it lives apart from the
 * panel markup and is pinned by a test: a wrong branch here is a cashier
 * reading the wrong figure off the screen.
 */
export function discountLabelFor(discount: DiscountSel): string | null {
  if (discount.mode === 'FIXED' && typeof discount.value === 'number') {
    return formatMinorMoney(discount.value, { variant: 'auto' })
  }
  if (discount.mode === 'PERCENT' && typeof discount.value === 'number') {
    return `${discount.value / 1000}%`
  }
  return null
}
