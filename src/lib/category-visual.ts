/**
 * Catalog category identity — a deterministic, centralized color slot per
 * category.
 *
 * This is deliberately its OWN identity system, the counterpart of
 * `lib/roles.ts` (employee roles) and `lib/customer-visual.tsx` (customers). A
 * category is a business grouping; it is never a permission, a person, or an
 * availability state, so the category palette never borrows the role palette
 * and never borrows success / danger / warning / info. A "new" item is likewise
 * a separate concept with its own accent.
 *
 * Determinism
 * -----------
 * The slot comes from a stable FNV-1a hash of the category's DATABASE id, so a
 * category keeps the same color across re-renders, searches, filters, reloads
 * and application restarts. Nothing here is random and nothing is hardcoded
 * per card: a category created in the database automatically gets a color.
 *
 * The color VALUES live in `styles/colors.css` as
 * `--category-{1..6}-{bg,border,fg}`; this module only chooses the slot and
 * maps it to theme token class names, so rebranding stays a CSS edit.
 */

/** The six low-chroma category tones, in token order. */
export type CategoryTone = {
  /** Stable 1-based palette slot, also exposed as a DOM/test hook. */
  slot: number
  background: string
  border: string
  foreground: string
}

const TONES: readonly CategoryTone[] = [
  {
    slot: 1,
    background: 'bg-category-1-bg',
    border: 'border-category-1-border',
    foreground: 'text-category-1-fg',
  },
  {
    slot: 2,
    background: 'bg-category-2-bg',
    border: 'border-category-2-border',
    foreground: 'text-category-2-fg',
  },
  {
    slot: 3,
    background: 'bg-category-3-bg',
    border: 'border-category-3-border',
    foreground: 'text-category-3-fg',
  },
  {
    slot: 4,
    background: 'bg-category-4-bg',
    border: 'border-category-4-border',
    foreground: 'text-category-4-fg',
  },
  {
    slot: 5,
    background: 'bg-category-5-bg',
    border: 'border-category-5-border',
    foreground: 'text-category-5-fg',
  },
  {
    slot: 6,
    background: 'bg-category-6-bg',
    border: 'border-category-6-border',
    foreground: 'text-category-6-fg',
  },
]

/**
 * FNV-1a over the stable category id. Small and fast, and — unlike a raw
 * `id % n` — it does not place consecutively created categories on
 * consecutively repeating tones, which is what made a naive modulo palette
 * look striped.
 */
function hashId(id: number): number {
  let value = 0x811c9dc5
  const text = String(id)
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.codePointAt(index) as number
    value = Math.imul(value, 0x01000193)
  }
  return value >>> 0
}

/** The category tone for a category id. Same id → same tone, always. */
export function categoryTone(id: number): CategoryTone {
  return TONES[hashId(id) % TONES.length]
}
