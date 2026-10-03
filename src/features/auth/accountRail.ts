/**
 * The account rail's GEOMETRY, as pure functions.
 *
 * Split from the component so the arithmetic can be asserted directly. jsdom
 * performs no layout — every `clientWidth`, `scrollWidth` and `offsetLeft` it
 * reports is zero — so a centring bug is invisible to a DOM-level test here
 * and would have to be taken on trust. These functions are the whole of it, and
 * they are testable exactly.
 */

/**
 * How far the rail is translated, in pixels.
 *
 * Negative when the rail overflows to the right of the selection, positive when
 * it overflows to the left — so the returned value is used directly as
 * `translateX(offset)`.
 *
 * Both inputs are PHYSICAL: `itemLeft` is `offsetLeft`, measured from the left
 * edge whatever the writing direction, and the transform is physical too. That
 * is why one formula serves RTL and LTR without a single branch on `dir` — the
 * alternative, `index * itemWidth`, has to hardcode a width AND reverses.
 */
export function centerOffset(viewportWidth: number, itemLeft: number, itemWidth: number): number {
  const itemCenter = itemLeft + itemWidth / 2
  return viewportWidth / 2 - itemCenter
}

/**
 * The account an ArrowLeft / ArrowRight should move to.
 *
 * `delta` is VISUAL: `+1` is one step to the RIGHT on screen, `-1` to the left.
 *
 * Arrow keys name a direction on screen, so they must be resolved against the
 * writing direction rather than against the array index. In this RTL
 * application `accounts[0]` is the RIGHTMOST card, so "one step to the right" is
 * the PREVIOUS index — the opposite of LTR. Treating the key as an index step is
 * precisely the bug that makes an RTL rail feel broken while looking perfectly
 * correct in code, so the two directions are kept explicitly apart here.
 *
 * Selection wraps, because a rail with a fixed end and no feedback is a dead end
 * for a keyboard user who cannot see the faded items.
 */
export function stepAccount(current: number, delta: number, length: number, rtl: boolean): number {
  if (length === 0) return 0
  // In an RTL rail the list index runs the other way, so a visual step is an
  // index step backwards.
  const alongList = rtl ? -delta : delta
  return (current + alongList + length) % length
}

/**
 * Visual weight of an item, by how many positions it sits from the selection.
 *
 * Progressive rather than binary: a neighbour is clearly secondary and a
 * distant one clearly backgrounded, so the eye is drawn to the middle without
 * anything having to shout. Tuned to Station's own surface tokens rather than
 * to any borrowed scale.
 */
export function prominence(distance: number): { scale: number; opacity: number; lift: number } {
  if (distance <= 0) return { scale: 1, opacity: 1, lift: 0 }
  if (distance === 1) return { scale: 0.88, opacity: 0.72, lift: 2 }
  if (distance === 2) return { scale: 0.8, opacity: 0.52, lift: 4 }
  return { scale: 0.74, opacity: 0.34, lift: 6 }
}
