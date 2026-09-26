import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { getRoleVisual } from '@/lib/roles'
import { CustomerAvatar, customerAvatarTone, customerInitials } from './customer-visual'

function renderAvatar(props: {
  id: number
  name: string | null | undefined
  accessibilityLabel?: string
}) {
  return render(<CustomerAvatar {...props} />)
}

describe('customerInitials', () => {
  it('reads the first letters of the first two Arabic words', () => {
    expect(customerInitials('أحمد سيد')).toBe('أس')
  })

  it('uses a single letter for a one-word name', () => {
    expect(customerInitials('محمود')).toBe('م')
  })

  it('ignores diacritics and tatweel so the same person looks the same', () => {
    expect(customerInitials('أَحــمد')).toBe(customerInitials('أحمد'))
  })

  it('falls back to a visible glyph rather than an empty avatar', () => {
    expect(customerInitials('')).toBe('؟')
    expect(customerInitials('   ')).toBe('؟')
    expect(customerInitials(null)).toBe('؟')
  })
})

describe('customerAvatarTone', () => {
  it('is deterministic for the same customer ID', () => {
    for (const id of [1, 7, 42, 1234, 99999]) {
      expect(customerAvatarTone(id)).toEqual(customerAvatarTone(id))
    }
  })

  it('only ever returns a token from the dedicated customer palette', () => {
    const roleClasses = new Set(
      (['ADMIN', 'MANAGER', 'STAFF', null] as const).flatMap((role) => {
        const visual = getRoleVisual(role)
        return [visual.background, visual.avatarForeground]
      }),
    )
    for (let id = 1; id <= 500; id += 1) {
      const tone = customerAvatarTone(id)
      expect(tone.background).toMatch(/^bg-customer-avatar-\d-bg$/)
      expect(tone.foreground).toMatch(/^text-customer-avatar-\d-fg$/)
      // A customer must never be rendered in an employee role color.
      expect(roleClasses.has(tone.background)).toBe(false)
      expect(roleClasses.has(tone.foreground)).toBe(false)
    }
  })

  it('does not put consecutive IDs on consecutive tones', () => {
    // A naive `id % 8` would produce this exact stripe; the hash must not.
    const slots = Array.from({ length: 8 }, (_, index) => customerAvatarTone(index + 1).slot)
    expect(slots).not.toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})

describe('CustomerAvatar', () => {
  it('renders the initials and exposes the tone as a hook', () => {
    const { container } = renderAvatar({ id: 3, name: 'أحمد سيد' })
    expect(container.textContent).toBe('أس')
    expect(container.querySelector('[data-customer-avatar-tone]')).toHaveAttribute(
      'data-customer-avatar-tone',
      String(customerAvatarTone(3).slot),
    )
  })

  it('is decorative when the name is visible beside it', () => {
    const { container } = renderAvatar({ id: 3, name: 'أحمد سيد' })
    expect(container.querySelector('[role="img"]')).toBeNull()
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })

  it('announces the customer name when it IS the only identity', () => {
    const { getByRole } = renderAvatar({
      id: 3,
      name: 'أحمد سيد',
      accessibilityLabel: 'أحمد سيد',
    })
    expect(getByRole('img', { name: 'أحمد سيد' })).toBeInTheDocument()
  })
})
