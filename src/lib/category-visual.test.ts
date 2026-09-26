/**
 * The category palette is a DETERMINISTIC, centralized identity: a category's
 * color must survive re-renders, filters, reloads and restarts, and it must
 * never leak into the employee-role palette or hardcode a raw color.
 */
import { describe, expect, it } from 'vitest'

import { categoryTone } from './category-visual'

describe('categoryTone', () => {
  it('is deterministic: the same category id always yields the same tone', () => {
    for (const id of [1, 2, 3, 7, 42, 1000]) {
      expect(categoryTone(id)).toEqual(categoryTone(id))
    }
  })

  it('always resolves to a slot inside the centralized six-tone palette', () => {
    for (let id = 1; id <= 60; id += 1) {
      const tone = categoryTone(id)
      expect(tone.slot).toBeGreaterThanOrEqual(1)
      expect(tone.slot).toBeLessThanOrEqual(6)
      // Theme token classes, never raw colors: rebranding stays a CSS edit.
      expect(tone.background).toMatch(/^bg-category-\d-bg$/)
      expect(tone.border).toMatch(/^border-category-\d-border$/)
      expect(tone.foreground).toMatch(/^text-category-\d-fg$/)
    }
  })

  it('keeps categories clear of the employee role palette', () => {
    for (let id = 1; id <= 40; id += 1) {
      const tone = categoryTone(id)
      for (const className of [tone.background, tone.border, tone.foreground]) {
        expect(className).not.toContain('role-')
      }
    }
  })

  it('keeps categories clear of the semantic status families', () => {
    for (let id = 1; id <= 40; id += 1) {
      const tone = categoryTone(id)
      for (const className of [tone.background, tone.border, tone.foreground]) {
        expect(className).not.toMatch(/success|danger|destructive|warning|badge-/)
      }
    }
  })
})
