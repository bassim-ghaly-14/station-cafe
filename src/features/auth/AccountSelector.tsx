/**
 * The account selector — ONE horizontal row with the chosen account at its
 * visual centre.
 *
 * # Why a rail and not a grid
 *
 * The old picker was a three-column grid, which makes the SELECTED account
 * indistinguishable from every other one: it is one cell among nine, in
 * whatever position the roster happens to sort it into. Whoever is signing in
 * has to read nine tiles to work out which one is them. This rail puts the
 * chosen account in the middle at full size and recedes everything else, so
 * "who am I signing in as" is answered by the layout itself.
 *
 * The reference is the classic game character/item select, but only the
 * STRUCTURE of it — one focal item, neighbours smaller, distance fading. The
 * visual identity is entirely Station's existing one: the shared
 * `EmployeeAvatar`, the existing surface/border/primary tokens, the existing
 * focus ring. No neon, no arcade chrome, no new design language.
 *
 * # The centring is MEASURED, never counted
 *
 * The obvious implementation is `translateX(calc(-1 * index * itemWidth))`,
 * and it is wrong twice over: it hardcodes an item width, and it silently
 * reverses under `direction: rtl` — which this application always is. So the
 * offset is measured from the real layout instead: each item's physical
 * `offsetLeft` is compared to the viewport's physical centre. `offsetLeft` is
 * measured from the left edge regardless of writing direction, and the
 * transform is likewise physical, so one formula is correct in both
 * directions with no branching on `dir` at all.
 *
 * Two cases, both handled by measurement rather than by a count:
 *
 * - The rail FITS. No transform at all; the track is centred as a whole, so
 *   one user sits in the middle and two users sit either side of it. This is
 *   why a one-user and a two-user cafe get a composed layout rather than a
 *   translated one with a hole in it.
 * - The rail OVERFLOWS. The track is translated so the selected item's centre
 *   lands on the viewport's centre, and it animates there on every change.
 *
 * # Selecting an account is NOT authentication
 *
 * Unchanged from the grid this replaces, and deliberately so: the selection is
 * only the name a user would otherwise have typed. It is handed to the same
 * `auth::login`, which still verifies the Argon2id hash. The rail is a
 * different arrangement of the same controls, never a different set.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { cn } from '@/lib/utils'
import type { LoginAccount } from '@/services/authApi'
import { centerOffset, prominence, stepAccount } from './accountRail'

export interface AccountSelectorProps {
  readonly accounts: readonly LoginAccount[]
  /** The chosen account's NAME — the only identity this screen holds. */
  readonly selected: string | null
  readonly onSelect: (name: string) => void
  readonly disabled: boolean
}

export function AccountSelector({
  accounts,
  selected,
  onSelect,
  disabled,
}: Readonly<AccountSelectorProps>) {
  const { t } = useTranslation()
  const viewportRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef(new Map<number, HTMLButtonElement>())

  const activeIndex = accounts.findIndex((account) => account.name === selected)
  const [offset, setOffset] = useState(0)
  /** True only while the rail genuinely overflows and is being translated. */
  const [centered, setCentered] = useState(false)

  /**
   * Re-measure and re-centre.
   *
   * Runs on the selection, on the roster and on a viewport resize, because all
   * three change the answer: the track's width when a name wraps differently,
   * the offset when the selection moves, and the viewport's centre when a phone
   * rotates. `ResizeObserver` covers the roster and the orientation change in
   * one hook rather than by guessing at breakpoints.
   */
  const measure = useCallback(() => {
    const viewport = viewportRef.current
    const track = trackRef.current
    if (!viewport || !track) return

    const viewportWidth = viewport.clientWidth
    const trackWidth = track.scrollWidth
    // Nothing to centre when the rail already fits: the track is centred as a
    // whole, so translating it would push a card off the edge for nothing.
    if (viewportWidth <= 0 || trackWidth <= viewportWidth) {
      // oxlint-disable-next-line react/set-state-in-effect -- DOM measurement.
      setOffset(0)
      setCentered(false)
      return
    }

    if (activeIndex < 0) {
      // oxlint-disable-next-line react/set-state-in-effect -- DOM measurement.
      setOffset(0)
      setCentered(true)
      return
    }

    const item = itemRefs.current.get(accounts[activeIndex].id)
    if (!item) return
    // oxlint-disable-next-line react/set-state-in-effect -- DOM measurement.
    setOffset(centerOffset(viewportWidth, item.offsetLeft, item.offsetWidth))
    setCentered(true)
  }, [accounts, activeIndex])

  // The offset cannot be derived during render: the answer is not in the props,
  // it is in the box the browser has just laid out. `useLayoutEffect` is the
  // right hook precisely so the FIRST paint is already centred — an effect that
  // let the rail paint uncentred and then jumped would be a visible flicker on
  // every selection change, which is the whole thing this rail must not do.
  // oxlint-disable-next-line react/set-state-in-effect -- DOM measurement.
  useLayoutEffect(measure)

  useEffect(() => {
    const viewport = viewportRef.current
    const track = trackRef.current
    if (!viewport || !track || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(viewport)
    observer.observe(track)
    return () => observer.disconnect()
  }, [measure])

  /**
   * Arrow keys move along the row.
   *
   * Bound to each ACCOUNT BUTTON — the element that actually holds focus and the
   * element a keyboard user reaches by tabbing — rather than to the viewport.
   * A non-interactive wrapper carrying the listener is what the a11y rule
   * flags: the handler has to live on a control that can genuinely receive it,
   * and a keypress can no more be handled twice than it could before, since one
   * keypress targets exactly one focused button.
   *
   * Only the two horizontal arrows are claimed; every other key, including
   * Enter, Space and Tab, is left entirely to the button.
   */
  function onAccountKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (disabled || accounts.length < 2) return
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()

    // The rail is RTL in Arabic, so the visual direction of an arrow is read
    // from the RENDERED direction, never assumed from the locale. The button
    // INHERITS that direction from the rail, so reading it here yields the same
    // answer the viewport did.
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
    // ArrowLeft moves the focus left ON SCREEN, ArrowRight to the right.
    const visual = event.key === 'ArrowLeft' ? -1 : 1
    const next = stepAccount(index, visual, accounts.length, rtl)
    const account = accounts[next]
    if (!account) return

    onSelect(account.name)
    itemRefs.current.get(account.id)?.focus()
  }

  return (
    <div
      ref={viewportRef}
      role="group"
      aria-label={t('auth.selectAccount')}
      data-testid="login-account-rail"
      data-rail-centered={centered ? 'true' : 'false'}
      data-rail-offset={Math.round(offset)}
      // Controlled overflow: a long roster scrolls WITHIN the rail. The page
      // itself never scrolls sideways, which is what would break the PIN field
      // and the buttons underneath it on a phone.
      className="relative w-full overflow-hidden px-1 py-2"
    >
      <div
        ref={trackRef}
        className={cn(
          'flex w-max items-center justify-center gap-2 sm:gap-3',
          // Only the overflowing case animates; a rail that fits is centred by
          // layout, so a transition there would be a no-op with a visible delay.
          centered && 'transition-transform duration-300 ease-out motion-reduce:transition-none',
        )}
        style={{ transform: `translateX(${offset}px)` }}
      >
        {accounts.map((account, index) => {
          const selectedNow = account.name === selected
          const distance = activeIndex < 0 ? 1 : Math.abs(index - activeIndex)
          const { scale, opacity, lift } = prominence(distance)
          return (
            <button
              key={account.id}
              type="button"
              ref={(node) => {
                if (node) itemRefs.current.set(account.id, node)
                else itemRefs.current.delete(account.id)
              }}
              // A toggle, so assistive technology reports the state instead of
              // leaving the user to infer it from the scale.
              aria-pressed={selectedNow}
              disabled={disabled}
              onClick={() => onSelect(account.name)}
              // The arrow keys are claimed by the button that HOLDS focus, so the
              // step starts from this card's own index rather than from a
              // selection the user may not have reached yet.
              onKeyDown={(event) => onAccountKeyDown(event, index)}
              data-testid={`login-account-${account.id}`}
              data-selected={selectedNow ? 'true' : 'false'}
              data-distance={distance}
              className={cn(
                'flex shrink-0 flex-col items-center gap-1.5 rounded-lg border-2 p-2 sm:p-3',
                'transition-[transform,opacity,background-color,border-color] duration-300 ease-out motion-reduce:transition-none',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                'disabled:opacity-60',
                selectedNow
                  ? 'border-primary bg-accent'
                  : 'border-border-subtle bg-surface-card hover:border-border-strong',
              )}
              // Scale and opacity are STYLE, not classes: they are computed from
              // the distance to the selection, which is not a value a static
              // class list can express.
              style={{
                transform: `translateY(${lift}px) scale(${scale})`,
                opacity: disabled ? 0.6 : opacity,
              }}
            >
              {/* The EXISTING role avatar, fed the real login role — the same
                  treatment the Employees page gives this person, so the identity
                  a worker recognises from the roster is the one they see here.
                  The active account gets the LARGER SIZE of that same avatar
                  rather than a second avatar system. */}
              <EmployeeAvatar role={account.role} size={selectedNow ? 'lg' : 'md'} />
              <span
                className={cn(
                  'max-w-20 truncate text-sm font-medium sm:max-w-24',
                  selectedNow ? 'text-foreground-strong' : 'text-foreground-muted',
                )}
              >
                {account.name}
              </span>
              {/* The role in text, for anyone who cannot rely on the avatar's colour. */}
              <span className="sr-only">{t(`roles.${account.role}`)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
