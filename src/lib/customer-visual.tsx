/**
 * Customer identity visuals — deterministic avatar tone + name initials.
 *
 * This is the CUSTOMER counterpart of `lib/roles.ts`, and it is deliberately a
 * separate system: employee role colors (ADMIN / MANAGER / STAFF), the
 * authorization colors and the staff-status colors are never referenced here.
 * A customer must never be mistaken for an employee, and a future Station
 * rebrand that moves the role palette must not drag the customer palette with
 * it.
 *
 * Determinism
 * -----------
 * The tone comes from a stable hash of the customer's database ID, so a given
 * customer keeps the same avatar through re-renders, searches, filters, page
 * reloads and application restarts. `Math.random()` is never used for a visual
 * decision — a color that changes when you look away is not an identity.
 *
 * The color values themselves live in `styles/colors.css` as
 * `--customer-avatar-{1..8}-{bg,fg}`; this module only picks the slot and maps
 * it to the matching theme token class names, so rebranding stays a CSS edit.
 */
import { cn } from '@/lib/utils'

export type CustomerAvatarTone = {
  /** Stable 1-based palette slot, also exposed as a DOM/test hook. */
  slot: number
  background: string
  foreground: string
}

/** The eight muted jewel tones, in token order. */
const TONES: readonly CustomerAvatarTone[] = [
  { slot: 1, background: 'bg-customer-avatar-1-bg', foreground: 'text-customer-avatar-1-fg' },
  { slot: 2, background: 'bg-customer-avatar-2-bg', foreground: 'text-customer-avatar-2-fg' },
  { slot: 3, background: 'bg-customer-avatar-3-bg', foreground: 'text-customer-avatar-3-fg' },
  { slot: 4, background: 'bg-customer-avatar-4-bg', foreground: 'text-customer-avatar-4-fg' },
  { slot: 5, background: 'bg-customer-avatar-5-bg', foreground: 'text-customer-avatar-5-fg' },
  { slot: 6, background: 'bg-customer-avatar-6-bg', foreground: 'text-customer-avatar-6-fg' },
  { slot: 7, background: 'bg-customer-avatar-7-bg', foreground: 'text-customer-avatar-7-fg' },
  { slot: 8, background: 'bg-customer-avatar-8-bg', foreground: 'text-customer-avatar-8-fg' },
]

/**
 * FNV-1a over the stable customer ID. Small and fast, and — unlike a raw
 * `id % n` — it does not put consecutive IDs on consecutive tones, which is
 * exactly what made a naive modulo palette read as a rainbow stripe down the
 * table.
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

/** The palette tone for a customer ID. Same ID → same tone, always. */
export function customerAvatarTone(id: number): CustomerAvatarTone {
  return TONES[hashId(id) % TONES.length]
}

/** Arabic/Latin diacritics and tatweel, so "أَحمد" and "أحمد" look identical. */
const DIACRITICS = /[ً-ْـ]/g

/**
 * Initials for the avatar.
 *
 * Arabic names are read from the START of the first word, so "أحمد سيد" reads
 * as "أس"; a single-word name yields one letter, and a name made only of
 * spaces falls back to a neutral "؟" rather than an empty chip.
 */
export function customerInitials(name: string | null | undefined): string {
  const cleaned = (name ?? '').replace(DIACRITICS, '').trim()
  if (cleaned === '') return '؟'
  const words = cleaned.split(/\s+/).filter(Boolean)
  const letters = words
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .filter(Boolean)
  return letters.join('') || '؟'
}

const TONE_SIZES = {
  sm: { box: 'size-8 rounded-lg', glyph: 'text-sm' },
  md: { box: 'size-10 rounded-xl', glyph: 'text-base' },
  lg: { box: 'size-16 rounded-2xl', glyph: 'text-xl' },
} as const

export type CustomerAvatarSize = keyof typeof TONE_SIZES

/**
 * The customer avatar: deterministic tone + name initials.
 *
 * It stays decorative (`aria-hidden`) whenever a visible customer name is
 * rendered beside it, so the avatar is never the only source of identity; a
 * caller that really does use it alone passes `accessibilityLabel` and it is
 * announced as an image carrying the customer's name.
 */
export function CustomerAvatar({
  id,
  name,
  size = 'md',
  className,
  accessibilityLabel,
}: {
  id: number
  name: string | null | undefined
  size?: CustomerAvatarSize
  className?: string
  accessibilityLabel?: string
}) {
  const tone = customerAvatarTone(id)
  const dimensions = TONE_SIZES[size]
  return (
    <span
      data-testid="customer-avatar"
      data-customer-avatar-tone={tone.slot}
      role={accessibilityLabel ? 'img' : undefined}
      aria-label={accessibilityLabel}
      aria-hidden={accessibilityLabel ? undefined : true}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center font-bold leading-none',
        dimensions.box,
        dimensions.glyph,
        tone.background,
        tone.foreground,
        className,
      )}
    >
      {customerInitials(name)}
    </span>
  )
}
