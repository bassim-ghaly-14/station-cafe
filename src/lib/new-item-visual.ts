/**
 * The "new item" catalog state — ONE definition of what a NEW card looks like,
 * shared by the card frame and the ribbon so the treatment can never drift into
 * two half-matching styles.
 *
 * Design intent
 * -------------
 * A NEW item must be recognisable in about one glance, so the signal is at the
 * CARD level, not only on a badge: a soft tinted surface, a solid accent edge on
 * the inline-start side (which is the reading side in Arabic, thanks to logical
 * properties), a stronger border and a slightly raised elevation. On top of
 * that sits a compact corner ribbon, and the title gets the accent colour so the
 * eye lands on the identity of the item rather than on decoration.
 *
 * Restraint, on purpose: no pulsing, no glow, no animation beyond the existing
 * 150ms colour transitions, the same `rounded-lg` radius as every other card,
 * and NO change to the price, the actions or the click target. The name, price
 * and stock line keep their own tokens, so contrast is unaffected in both
 * themes.
 *
 * Every colour comes from the Station `--new-*` family in `styles/colors.css`
 * (light + dark), so a rebrand stays a CSS edit.
 */

/** Applied to the card `<article>` when the item is NEW. */
export const NEW_CARD_FRAME =
  'border-new-border bg-new-soft shadow-[0_0_0_1px_var(--new-border),0_10px_24px_-16px_var(--new)]'

/** The inline-start accent edge: a solid, unmistakable vertical marker. */
export const NEW_CARD_EDGE = 'bg-new'

/** Title emphasis — the accent hue, still a foreground token (readable). */
export const NEW_CARD_TITLE = 'text-new-foreground'

/** The corner ribbon: solid accent, readable inverse text, no radius inflation. */
export const NEW_RIBBON = 'border-new bg-new text-new-inverse'

/**
 * A stable DOM hook so behavior-oriented tests (and QA) can assert the card
 * state itself instead of reading class names.
 */
export const NEW_CARD_TEST_ID = 'catalog-card-new'
