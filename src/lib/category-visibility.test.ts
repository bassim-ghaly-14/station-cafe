import { beforeEach, describe, expect, it } from 'vitest'

import {
  CATEGORY_VISIBILITY_STORAGE_KEY,
  DEFAULT_VISIBLE_LIMIT,
  getCategoryVisibility,
  moveCategoryInList,
  reloadCategoryVisibility,
  resetCategoryVisibility,
  resolveVisibleCategories,
  sanitizeCategoryVisibility,
  sanitizeVisibleIds,
  setVisibleCategoryIds,
  toggleCategoryInList,
} from './category-visibility'

interface Fake {
  id: number
  name: string
}

function categories(count: number): Fake[] {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `صنف ${index + 1}` }))
}

describe('category visibility preference', () => {
  beforeEach(() => {
    localStorage.clear()
    reloadCategoryVisibility()
  })

  describe('sanitizing untrusted persisted data', () => {
    it('keeps only valid unique ids and drops everything unusable', () => {
      expect(sanitizeVisibleIds([3, 1, 3, 0, -2, 1.5, '4', null, 2])).toEqual([3, 1, 2])
    })

    it('treats a missing, non-object or null payload as "never configured"', () => {
      expect(sanitizeCategoryVisibility(undefined).visible).toBeNull()
      expect(sanitizeCategoryVisibility('nonsense').visible).toBeNull()
      expect(sanitizeCategoryVisibility({}).visible).toBeNull()
      expect(sanitizeCategoryVisibility({ visible: null }).visible).toBeNull()
    })

    it('never throws on a hand-edited or corrupt stored value', () => {
      localStorage.setItem(CATEGORY_VISIBILITY_STORAGE_KEY, '{not json')
      expect(reloadCategoryVisibility().visible).toBeNull()
    })
  })

  describe('default behaviour for an existing installation', () => {
    it('shows the first categories in the catalog order, capped, and hides nothing else', () => {
      const all = categories(10)

      // No stored preference = the default is derived, not persisted, so the
      // cashier is never forced to configure anything on first launch.
      expect(getCategoryVisibility().visible).toBeNull()
      expect(resolveVisibleCategories(all, getCategoryVisibility())).toEqual(
        all.slice(0, DEFAULT_VISIBLE_LIMIT),
      )
      // Every category is still reachable: none is removed from the catalog.
      expect(all).toHaveLength(10)
    })

    it('shows everything when the catalog has fewer categories than the cap', () => {
      const all = categories(3)
      expect(resolveVisibleCategories(all, getCategoryVisibility())).toEqual(all)
    })

    it('restores the untouched default on reset', () => {
      setVisibleCategoryIds([7, 8])
      resetCategoryVisibility()

      expect(getCategoryVisibility().visible).toBeNull()
      expect(localStorage.getItem(CATEGORY_VISIBILITY_STORAGE_KEY)).toBe(
        JSON.stringify({ visible: null }),
      )
    })
  })

  describe('pinning, unpinning and ordering', () => {
    it('pins and unpins a category without disturbing the rest of the order', () => {
      expect(toggleCategoryInList([5, 2], 9)).toEqual([5, 2, 9])
      expect(toggleCategoryInList([5, 2, 9], 2)).toEqual([5, 9])
    })

    it('moves a category and ignores moves that fall off either end', () => {
      expect(moveCategoryInList([1, 2, 3], 3, -1)).toEqual([1, 3, 2])
      // Already first / already last: a no-op, never a crash or a wrap-around.
      expect(moveCategoryInList([1, 3, 2], 1, -1)).toEqual([1, 3, 2])
      expect(moveCategoryInList([1, 3, 2], 2, 1)).toEqual([1, 3, 2])
    })

    it('ignores a move for a category that is not in the bar', () => {
      expect(moveCategoryInList([1], 4, -1)).toEqual([1])
    })

    it('never mutates the list it is given', () => {
      const ids = [1, 2, 3]
      moveCategoryInList(ids, 3, -1)
      toggleCategoryInList(ids, 9)
      expect(ids).toEqual([1, 2, 3])
    })

    it('supports a saved "only All" state, which is different from never configured', () => {
      setVisibleCategoryIds([])
      expect(getCategoryVisibility().visible).toEqual([])
      expect(resolveVisibleCategories(categories(5), getCategoryVisibility())).toEqual([])
    })

    it('renders the saved order, and silently drops a category that no longer exists', () => {
      const all = categories(4)
      setVisibleCategoryIds([4, 99, 1])

      expect(resolveVisibleCategories(all, getCategoryVisibility())).toEqual([all[3], all[0]])
    })
  })

  describe('persistence across an application restart', () => {
    it('survives a reload of the store (a fresh page reading the same storage)', () => {
      setVisibleCategoryIds([3, 1])

      // Simulate the restart: only localStorage survives.
      reloadCategoryVisibility()

      expect(getCategoryVisibility().visible).toEqual([3, 1])
      expect(
        resolveVisibleCategories(categories(4), getCategoryVisibility()).map((c) => c.id),
      ).toEqual([3, 1])
    })

    it('does not write anything until the cashier actually chooses something', () => {
      reloadCategoryVisibility()
      expect(localStorage.getItem(CATEGORY_VISIBILITY_STORAGE_KEY)).toBeNull()
    })
  })
})
