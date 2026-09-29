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

/**
 * The raw text a dev-settings amount field is allowed to hold: whole digits and
 * nothing else.
 *
 * `type="number"` is a rendering hint, not a validation. A number input happily
 * accepts "10.5", "1e2" and a bare sign, and `Number()` evaluates all three — so
 * without a rule at the boundary, a whole-amount setting ends up holding a
 * fraction. Matching the text against the ONE shape an amount is allowed to have
 * keeps the rejected keystrokes out of state entirely, so the field keeps
 * showing the last whole number it accepted instead of being silently rounded
 * under the cursor.
 *
 * Returns null for anything else. The empty string is a moment of editing rather
 * than an amount, so the CALLER lets it through — it is the same empty draft the
 * "add amount" button starts a new row with.
 */
export function parseAmountDraft(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null

  const value = Number.parseInt(raw, 10)
  return Number.isSafeInteger(value) ? value : null
}

/**
 * The text a dev-settings amount field may keep, or null to refuse the edit.
 *
 * The component asks this rather than testing a regular expression of its own, so
 * "is this a whole amount" is stated once next to the other list rules and the
 * boundary can be checked without rendering anything.
 */
export function acceptAmountDraft(raw: string): string | null {
  return raw === '' || parseAmountDraft(raw) !== null ? raw : null
}

/**
 * Whether a keystroke may reach a dev-settings amount field at all.
 *
 * `acceptAmountDraft` alone is not enough, and the reason is specific to
 * `type="number"`: the browser SANITISES a value it cannot represent, so a lone
 * "+" or "-" never arrives as text at all — the field simply reports the empty
 * string, which is byte-for-byte what a deliberate clear reports. By the time
 * `onChange` runs, "the user typed a sign" and "the user cleared the field" are
 * the same event, and refusing it would make the field impossible to empty.
 *
 * So the shape is decided one step earlier, while the key is still identifiable:
 * digits get through, so do the editing keys (clear, delete, caret movement) and
 * the modifier combinations that let a manager select and retype. Everything
 * else — ".", "e", "E", "+", "-" and any letter — is stopped before it can
 * produce a value the field would then have to round.
 */
export function isAllowedAmountKey(key: string): boolean {
  // Navigation, deletion and anything the browser sends with a non-printable
  // name ("Backspace", "ArrowLeft", "Enter", "F5") is not typed text.
  if (key.length !== 1) return true

  return /[0-9]/.test(key)
}
