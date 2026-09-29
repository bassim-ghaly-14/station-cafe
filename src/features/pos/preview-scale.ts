/**
 * The on-screen display scale of a printed document.
 *
 * The paper is 80mm of REAL estate and is never resized: `zoom` scales the
 * whole rendered document as one unit, which is what keeps the screen preview
 * faithful to the print IR. What has to adapt is the SCALE, and it cannot be a
 * constant:
 *
 *   80mm ≈ 302px unscaled. At the desktop scale of 1.3 that is 393px and at the
 *   expanded scale of 2 it is 605px — both comfortably inside a 480–672px
 *   desktop dialog, and both far wider than the ~250–340px a phone can offer
 *   once the dialog, its body padding and the viewer's own padding are paid
 *   for. A fixed scale therefore produced a document that was CROPPED on a
 *   phone (the centering layer is `min-w-max` inside a clipping viewer), and
 *   enlarging it just cropped more.
 *
 * So the scale is the largest value, capped by the presentation, whose scaled
 * paper still fits the width actually measured on screen. Two consequences are
 * deliberate:
 *
 *  - a desktop dialog is wide enough that the cap always wins, so 1.3 and 2
 *    are exactly what a desktop has always shown;
 *  - the result is floored to two decimals, so it can only ever be SMALLER
 *    than the exact fit — the paper can never round up past the space it was
 *    measured against and become a horizontal scrollbar.
 *
 * Nothing here touches the document, the paper width or the printer: this is
 * the display-scale boundary and nothing else.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * CSS reference pixels per millimetre. CSS defines 1in as exactly 96px and
 * 1in as 25.4mm, so a `width: 80mm` box is this many pixels wide — which is
 * how a millimetre measurement in the print IR becomes a width to fit into.
 */
export const CSS_PX_PER_MM = 96 / 25.4

/** The unscaled on-screen width of a document of `paperMm` millimetres. */
export function paperWidthPx(paperMm: number): number {
  return paperMm * CSS_PX_PER_MM
}

/**
 * The scale to show a document at: `maxScale` on a surface with room, and the
 * exact fit (floored) on one without.
 *
 * An unmeasured surface — before layout, or in an environment with no layout
 * at all — reports 0, and the presentation's own scale is used unchanged.
 */
export function fitPreviewScale(maxScale: number, availablePx: number, paperMm: number): number {
  if (!(availablePx > 0) || !(paperMm > 0)) return maxScale
  const fit = availablePx / paperWidthPx(paperMm)
  return Math.min(maxScale, Math.floor(fit * 100) / 100)
}

/**
 * The live content width of a measured element, in CSS pixels.
 *
 * A CALLBACK ref rather than an object ref, because the element being measured
 * is mounted and unmounted with the document itself: an object ref read inside
 * an effect is still `null` if the effect ran against the loading state, and a
 * measurement that never re-runs is the very constant this replaced. A callback
 * ref runs exactly when the node attaches and when it detaches.
 *
 * `ResizeObserver` rather than a `resize` listener because the width that
 * matters changes without the window doing anything: the dialog grows when the
 * preview is expanded and shrinks when it is collapsed.
 *
 * Environments with no layout and no `ResizeObserver` (jsdom) report 0, which
 * is the "unmeasured" case in `fitPreviewScale`.
 */
export function useMeasuredWidth(): {
  readonly ref: (element: HTMLElement | null) => void
  readonly width: number
} {
  const [width, setWidth] = useState(0)
  const observerRef = useRef<ResizeObserver | null>(null)

  const ref = useCallback((element: HTMLElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!element) {
      setWidth(0)
      return
    }
    setWidth(element.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    observerRef.current = observer
  }, [])

  useEffect(() => () => observerRef.current?.disconnect(), [])

  return { ref, width }
}
