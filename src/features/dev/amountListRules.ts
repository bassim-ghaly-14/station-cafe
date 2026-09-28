/**
 * The list rules behind an editable amount list.
 *
 * They are named, pure and separate from the component so the three list
 * states — replace this one, remove this one, swap with the neighbour — are
 * stated once and can be checked without rendering anything. A move that would
 * fall off either end of the list is a no-op, never a wrap-around: the buttons
 * that trigger it are already disabled there, so this is the second line of
 * defence rather than a silent reordering.
 */

/** Replace one entry, leaving the rest of the order untouched. */
export function replaceAmountAt(values: readonly string[], index: number, next: string): string[] {
  return values.map((value, current) => (current === index ? next : value))
}

export function removeAmountAt(values: readonly string[], index: number): string[] {
  return values.filter((_, current) => current !== index)
}

/** Swap with the neighbour; a move that would fall off either end is a no-op. */
export function moveAmount(values: readonly string[], index: number, offset: -1 | 1): string[] {
  const target = index + offset
  if (target < 0 || target >= values.length) {
    return [...values]
  }

  const next = [...values]
  const moved = next[index]
  next[index] = next[target]
  next[target] = moved
  return next
}
