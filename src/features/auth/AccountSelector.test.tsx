/**
 * The centred account rail.
 *
 * The layout claims are not the interesting part — the ARITHMETIC is. A rail
 * can look perfect at three accounts and sit half a card off-centre at seven,
 * and nothing in a screenshot of the common case would reveal it. So the
 * centring is asserted three ways:
 *
 *  1. as arithmetic, through the exported `centerOffset` / `stepAccount`, which
 *     is the only part jsdom cannot exercise honestly (it reports every layout
 *     measurement as zero);
 *  2. through the DOM, with the layout values jsdom does not compute injected;
 *  3. through the properties that must hold at EVERY roster size.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { AccountSelector } from './AccountSelector'
import { centerOffset, stepAccount } from './accountRail'
import type { LoginAccount } from '@/services/authApi'

function account(id: number): LoginAccount {
  return { id, name: `user-${id}`, role: 'ADMIN' }
}

/**
 * Give the rail a real geometry.
 *
 * jsdom performs no layout, so `clientWidth`, `scrollWidth` and `offsetLeft`
 * are all zero and every centring path would take its "nothing to measure"
 * branch. These stubs give the rail a fixed viewport and fixed-width, evenly
 * spaced cards — the layout a browser actually produces — so the centring code
 * runs for real instead of being skipped.
 */
function giveLayout(viewportWidth: number, cardWidth: number, gap = 8) {
  const rail = screen.getByTestId('login-account-rail')
  const track = rail.firstElementChild as HTMLElement

  Object.defineProperty(rail, 'clientWidth', { configurable: true, value: viewportWidth })
  Object.defineProperty(track, 'scrollWidth', {
    configurable: true,
    value: track.children.length * cardWidth + (track.children.length - 1) * gap,
  })
  ;[...track.children].forEach((child, index) => {
    Object.defineProperty(child, 'offsetWidth', { configurable: true, value: cardWidth })
    Object.defineProperty(child, 'offsetLeft', {
      configurable: true,
      value: index * (cardWidth + gap),
    })
  })
  return { rail, track }
}

function rail() {
  return screen.getByTestId('login-account-rail')
}

/**
 * Render the rail inside a document of the given writing direction.
 *
 * The `dir` ATTRIBUTE is used rather than a stubbed `getComputedStyle`: jsdom
 * resolves `direction` from `dir` through inheritance, so this exercises the
 * real code path — the component asks the browser which way it is running —
 * instead of proving only that it called a mock.
 */
function renderIn(dir: 'rtl' | 'ltr', node: React.ReactElement) {
  document.documentElement.dir = dir
  return render(<div dir={dir}>{node}</div>)
}

beforeEach(() => {
  i18n.changeLanguage(DEFAULT_LOCALE)
  document.documentElement.dir = 'rtl'
})

describe('the centring arithmetic', () => {
  it("puts the selected card's centre on the viewport's centre", () => {
    // A 300px viewport with 60px cards 8px apart. The middle card of five
    // starts at 136 and spans to 196, so its centre (166) sits 16px RIGHT of
    // the viewport's centre (150) — and the rail is translated back by exactly
    // that. This is the whole point: the offset is not a multiple of anything,
    // it is whatever the real layout needs.
    expect(centerOffset(300, 136, 60)).toBe(-16)
    // The first card has to be pushed right by half the viewport less its own
    // half-width — which is what makes the SELECTED card the centred one.
    expect(centerOffset(300, 0, 60)).toBe(120)
    // And symmetrically for the last card.
    expect(centerOffset(300, 272, 60)).toBe(-152)
  })

  it('is correct for any viewport and any card width, not just one layout', () => {
    for (const viewport of [280, 320, 480, 900]) {
      for (const cardWidth of [56, 72, 96]) {
        const gap = 8
        for (let index = 0; index < 7; index += 1) {
          const offset = centerOffset(viewport, index * (cardWidth + gap), cardWidth)
          // After translating by `offset`, the card's centre IS the centre.
          const centred = index * (cardWidth + gap) + cardWidth / 2 + offset
          expect(Math.abs(centred - viewport / 2)).toBeLessThan(1e-9)
        }
      }
    }
  })
})
describe('arrow keys', () => {
  /**
   * The property, stated once so every case below is a consequence of it: an
   * arrow moves to the card that is VISUALLY in that direction, whatever the
   * writing direction. Nothing here may be phrased as "the index changes by
   * one", because that is the mistake.
   */
  it('moves to the card on the named side, in either direction', () => {
    const onSelect = vi.fn()
    const selector = (selected: string) => (
      <AccountSelector
        accounts={[1, 2, 3].map(account)}
        selected={selected}
        onSelect={onSelect}
        disabled={false}
      />
    )

    // LTR: screen-right from the first card is the second.
    const ltr = renderIn('ltr', selector('user-1'))
    fireEvent.keyDown(rail(), { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenLastCalledWith('user-2')
    ltr.unmount()

    // RTL — the direction this application actually ships in: the list runs the
    // other way, so screen-right from the RIGHTMOST card is the one at the end.
    onSelect.mockClear()
    renderIn('rtl', selector('user-1'))
    fireEvent.keyDown(rail(), { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenLastCalledWith('user-3')
  })

  it('treats the arrow as a direction on screen, not as an index step', () => {
    const onSelect = vi.fn()
    renderIn(
      'rtl',
      <AccountSelector
        accounts={[1, 2, 3].map(account)}
        selected="user-2"
        onSelect={onSelect}
        disabled={false}
      />,
    )
    // In RTL the FIRST card is the rightmost, so screen-left is the NEXT one.
    fireEvent.keyDown(rail(), { key: 'ArrowLeft' })
    expect(onSelect).toHaveBeenLastCalledWith('user-3')
    // ...and screen-right is the previous one. An implementation that simply
    // added or subtracted one index would get BOTH of these backwards.
    fireEvent.keyDown(rail(), { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenLastCalledWith('user-1')
  })

  it('resolves a visual direction into a list index, and wraps at both ends', () => {
    // LTR: the index order runs left to right, so a visual step is a plain one.
    expect(stepAccount(0, 1, 3, false)).toBe(1)
    expect(stepAccount(2, 1, 3, false)).toBe(0)
    // RTL: index 0 is the RIGHTMOST card, so a step to the right moves the
    // index BACKWARDS — from 0 it wraps to the end of the list.
    expect(stepAccount(1, 1, 3, true)).toBe(0)
    expect(stepAccount(0, 1, 3, true)).toBe(2)
    expect(stepAccount(0, -1, 3, true)).toBe(1)
    // A rail with one card, or none, never indexes out of bounds.
    expect(stepAccount(0, 1, 1, true)).toBe(0)
    expect(stepAccount(0, 1, 0, true)).toBe(0)
  })

  it('leaves every other key to the buttons', () => {
    const onSelect = vi.fn()
    render(
      <AccountSelector
        accounts={[1, 2].map(account)}
        selected={null}
        onSelect={onSelect}
        disabled={false}
      />,
    )
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'a']) {
      fireEvent.keyDown(rail(), { key })
    }
    // Tab especially: claiming it would trap keyboard users on the rail.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('does nothing while a submission is in flight', () => {
    const onSelect = vi.fn()
    render(
      <AccountSelector
        accounts={[1, 2, 3].map(account)}
        selected={null}
        onSelect={onSelect}
        disabled
      />,
    )
    fireEvent.keyDown(rail(), { key: 'ArrowRight' })
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('the rail on screen', () => {
  it('centres the selected card, and moves the rail when the selection changes', () => {
    const onSelect = vi.fn()
    const roster = [1, 2, 3, 4, 5].map(account)
    const view = (selected: string) => (
      <AccountSelector accounts={roster} selected={selected} onSelect={onSelect} disabled={false} />
    )

    const { rerender } = render(view('user-2'))
    // The geometry is given first, then the rail is re-measured — the same order
    // a real viewport change arrives in.
    giveLayout(300, 60)
    rerender(view('user-2'))

    // Cards 60px wide, 8px apart: the second card spans 68→128, so its centre is
    // 98 while the viewport's centre is 150 — the rail moves right by 52.
    expect(Number(rail().dataset.railOffset)).toBe(52)
    expect((rail().firstElementChild as HTMLElement).style.transform).toBe('translateX(52px)')
    // The overflowing rail is the one that animates.
    expect((rail().firstElementChild as HTMLElement).className).toContain('transition-transform')
    expect(rail().dataset.railCentered).toBe('true')

    rerender(view('user-4'))
    // The fourth card spans 204→264, centre 234: a different offset, in the
    // other direction. The SELECTED card is what ends up in the middle — not a
    // fixed margin that happens to look right for one position.
    expect(Number(rail().dataset.railOffset)).toBe(-84)
  })

  it('does not translate a rail that already fits, at any small roster size', () => {
    for (const size of [1, 2, 3]) {
      const roster = Array.from({ length: size }, (_, i) => account(i + 1))
      const view = (
        <AccountSelector accounts={roster} selected="user-1" onSelect={vi.fn()} disabled={false} />
      )
      const { rerender, unmount } = render(view)
      // A viewport wide enough for the whole rail: the track is centred by
      // layout, so a transform here would only introduce a hole.
      giveLayout(1000, 60)
      rerender(view)
      expect(rail().dataset.railCentered).toBe('false')
      expect(Number(rail().dataset.railOffset)).toBe(0)
      expect((rail().firstElementChild as HTMLElement).style.transform).toBe('translateX(0px)')
      unmount()
    }
  })

  it('emphasises the selected card and recedes the others by distance', () => {
    render(
      <AccountSelector
        accounts={[1, 2, 3, 4, 5].map(account)}
        selected="user-3"
        onSelect={vi.fn()}
        disabled={false}
      />,
    )

    const card = (id: number) => screen.getByTestId(`login-account-${id}`)
    // Distance is measured from the selection in BOTH directions.
    expect(card(3)).toHaveAttribute('data-distance', '0')
    expect(card(2)).toHaveAttribute('data-distance', '1')
    expect(card(4)).toHaveAttribute('data-distance', '1')
    expect(card(1)).toHaveAttribute('data-distance', '2')
    expect(card(5)).toHaveAttribute('data-distance', '2')

    const opacity = (id: number) => Number(card(id).style.opacity)
    const scale = (id: number) => Number(/scale\(([\d.]+)\)/.exec(card(id).style.transform)![1])

    expect(opacity(3)).toBe(1)
    expect(scale(3)).toBe(1)
    // Neighbours are smaller and dimmer, and the effect deepens with distance.
    expect(opacity(2)).toBeLessThan(1)
    expect(scale(2)).toBeLessThan(1)
    expect(opacity(1)).toBeLessThan(opacity(2))
    expect(scale(1)).toBeLessThan(scale(2))

    // Selection is ALSO carried by state, not only by these numbers.
    expect(card(3)).toHaveAttribute('aria-pressed', 'true')
    expect(card(2)).toHaveAttribute('aria-pressed', 'false')
  })

  it('gives the selected card the larger avatar, from the shared one', () => {
    render(
      <AccountSelector
        accounts={[1, 2].map(account)}
        selected="user-1"
        onSelect={vi.fn()}
        disabled={false}
      />,
    )
    const avatar = (id: number) =>
      within(screen.getByTestId(`login-account-${id}`)).getByTestId('employee-avatar')

    // One avatar system, two of its existing sizes.
    expect(avatar(1).className).toContain('size-10')
    expect(avatar(2).className).toContain('size-8')
    // And the role still drives it.
    expect(avatar(1)).toHaveAttribute('data-employee-role', 'ADMIN')
  })

  it('reports the selection through accessible state, not only through scale', () => {
    render(
      <AccountSelector
        accounts={[1, 2, 3].map(account)}
        selected="user-2"
        onSelect={vi.fn()}
        disabled={false}
      />,
    )
    expect(rail()).toHaveAttribute('aria-label', i18n.t('auth.selectAccount'))
    expect(screen.getByTestId('login-account-2')).toHaveAttribute('aria-pressed', 'true')
    // The name is real text, not an image or a generated glyph.
    expect(screen.getByTestId('login-account-2')).toHaveTextContent('user-2')
  })

  it('re-measures when the viewport changes, so a rotation cannot leave it off-centre', () => {
    const view = (selected: string) => (
      <AccountSelector
        accounts={[1, 2, 3, 4, 5].map(account)}
        selected={selected}
        onSelect={vi.fn()}
        disabled={false}
      />
    )
    const { rerender } = render(view('user-4'))
    // A viewport wide enough for the whole rail: nothing to translate.
    giveLayout(600, 60)
    rerender(view('user-4'))
    expect(Number(rail().dataset.railOffset)).toBe(0)

    // A narrower phone — a rotation, or a smaller browser. The same card now
    // needs a real offset, and it is recomputed rather than left stale.
    giveLayout(300, 60)
    rerender(view('user-4'))
    expect(Number(rail().dataset.railOffset)).toBe(-84)
  })

  it('never lets the page scroll sideways, whatever the roster size', () => {
    render(
      <AccountSelector
        accounts={Array.from({ length: 9 }, (_, i) => account(i + 1))}
        selected={null}
        onSelect={vi.fn()}
        disabled={false}
      />,
    )
    // Overflow is the RAIL's, and the rail is a block-level child of a
    // full-width column — so a nine-person cafe cannot push the PIN field or
    // the sign-in button outside the viewport.
    expect(rail().className).toContain('w-full')
    expect(rail().className).toContain('overflow-hidden')
    expect((rail().firstElementChild as HTMLElement).className).toContain('w-max')
  })
})
