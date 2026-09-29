/**
 * The preview's display scale — the rule that makes a document FIT rather than
 * get cropped.
 *
 * The defect this pins down: the scale used to be the constant 1.3 (2 when
 * expanded) applied to a paper that is 80mm ≈ 302px wide. On a 360px phone the
 * space actually available for the paper is roughly 280px once the dialog, its
 * body padding and the viewer's own padding are paid for, so the document was
 * drawn 393px wide inside a clipping box and BOTH SIDES of every invoice were
 * cut off — with no way to scroll to them, because the fit was never allowed
 * to be anything but the desktop number.
 *
 * The assertions below are stated in the units that matter: at every phone
 * width the scaled paper must be no wider than the space it was measured in,
 * and on a desktop-sized surface the presentation's own scale must be exactly
 * what it has always been.
 */
import { describe, expect, it } from 'vitest'
import { CSS_PX_PER_MM, fitPreviewScale, paperWidthPx } from './preview-scale'

/** Station's paper: every template prints on 80mm. */
const PAPER_MM = 80

/**
 * The width a phone can actually offer the paper, derived from the chrome the
 * preview is really wrapped in rather than from a guessed number:
 * the dialog's side margins, the shared dialog body's `px-4`, and the viewer's
 * own `p-2` (which steps up to `p-3` from `sm`).
 */
function availableOnPhone(viewportWidth: number): number {
  const normalDialogMargin = 2 * 8 // w-[min(calc(100vw-1rem),30rem)] on a phone
  const bodyPadding = 2 * 16 // the shared Dialog body's px-4
  const viewerPadding = 2 * 8 // the viewer's p-2 on a phone
  return viewportWidth - normalDialogMargin - bodyPadding - viewerPadding
}

const PHONE_WIDTHS = [320, 360, 375, 390, 414, 430]

describe('paperWidthPx', () => {
  it('reads the CSS millimetre, not an approximation of it', () => {
    // 1in is exactly 96px and 25.4mm, so an 80mm paper is 302.36px — and the
    // scale that fits must be derived from that, not from a rounded constant.
    expect(CSS_PX_PER_MM).toBe(96 / 25.4)
    expect(paperWidthPx(PAPER_MM)).toBeCloseTo(302.36, 1)
  })
})

describe('fitPreviewScale', () => {
  it('never draws a document wider than the space it was measured in', () => {
    // The whole point: on EVERY supported phone width, in BOTH presentations,
    // `paper × scale` is inside the box. This is the assertion the old constant
    // scale could not pass at 320px.
    for (const width of PHONE_WIDTHS) {
      const available = availableOnPhone(width)
      for (const maxScale of [1.3, 2]) {
        const scale = fitPreviewScale(maxScale, available, PAPER_MM)
        expect(paperWidthPx(PAPER_MM) * scale, `${width}px at max ${maxScale}`).toBeLessThanOrEqual(
          available,
        )
        // And it uses the room it has: a phone is not showing a shrunken
        // desktop dialog, it is showing the document as large as it goes.
        expect(scale, `${width}px at max ${maxScale}`).toBeGreaterThan(0.5)
        expect(scale).toBeLessThanOrEqual(maxScale)
      }
    }
  })

  it('fills a fullscreen phone instead of leaving the desktop margins in place', () => {
    // Expanded is full bleed below `sm` — `max-w-none`, no side margin — so it
    // must reach a larger document than the same phone in its normal sheet.
    for (const width of PHONE_WIDTHS) {
      const normal = fitPreviewScale(1.3, availableOnPhone(width), PAPER_MM)
      const full = fitPreviewScale(2, availableOnPhone(width) + 16, PAPER_MM)
      expect(full, `${width}px`).toBeGreaterThan(normal)
    }
  })

  it('leaves a desktop-sized dialog at the scale it has always used', () => {
    // Normal: 30rem dialog - px-5 body - p-3 viewer. Expanded: 42rem (2xl).
    // Both are wide enough that the cap wins, which is what keeps the desktop
    // presentation untouched by a phone fix.
    const normal = fitPreviewScale(1.3, 30 * 16 - 40 - 24, PAPER_MM)
    const expanded = fitPreviewScale(2, 42 * 16 - 40 - 24, PAPER_MM)
    expect(normal).toBe(1.3)
    expect(expanded).toBe(2)
  })

  it('uses the presentation scale when the width is not measurable', () => {
    // Before layout, and in any environment without layout, the honest answer
    // is the presentation's own number rather than a guess derived from 0.
    expect(fitPreviewScale(1.3, 0, PAPER_MM)).toBe(1.3)
    expect(fitPreviewScale(2, Number.NaN, PAPER_MM)).toBe(2)
    expect(fitPreviewScale(1.3, 300, 0)).toBe(1.3)
  })

  it('rounds the fit DOWN, so a sub-pixel remainder cannot become a scrollbar', () => {
    // 302.36 × 1.005 is wider than 304; flooring to two decimals keeps the
    // document inside the measured box instead of a fraction over it.
    const available = 304
    const scale = fitPreviewScale(2, available, PAPER_MM)
    expect(scale).toBeLessThan(available / paperWidthPx(PAPER_MM))
    expect(paperWidthPx(PAPER_MM) * scale).toBeLessThanOrEqual(available)
  })
})
