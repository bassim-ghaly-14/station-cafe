import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { Check } from './icon'
import { Badge } from './badge'
import { EmployeeAvatar } from './employee-avatar'
import i18n from '@/lib/i18n'
import { getRoleVisual } from '@/lib/roles'
import { Loader } from './loader'
import { Skeleton } from './skeleton'
import { PasswordInput, PinInput, Switch, Field, Input } from './input'
import { invoiceBadgeVariant, printJobBadgeVariant, tableBadgeVariant } from '@/lib/status-badge'

describe('Badge', () => {
  it.each(['neutral', 'success', 'warning', 'danger', 'info', 'brand'] as const)(
    'renders the %s variant with centralized token classes',
    (variant) => {
      const { container } = render(<Badge variant={variant}>الحالة</Badge>)
      expect(container.firstElementChild).toHaveTextContent('الحالة')
      expect(container.firstElementChild?.className).toContain(`badge-${variant}`)
    },
  )

  it('supports compact sizing, dots, icons, and class overrides', () => {
    const { container } = render(
      <Badge variant="success" size="sm" dot icon={Check} className="custom-badge">
        نشط
      </Badge>,
    )
    const badge = container.firstElementChild
    expect(badge).toHaveClass('text-xs', 'custom-badge')
    expect(badge?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(badge?.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
  })
})

describe('Switch', () => {
  /** The switch is a real role="switch" button, not a styled checkbox. */
  function renderSwitch(props: Partial<Parameters<typeof Switch>[0]> = {}) {
    const onCheckedChange = vi.fn()
    const { container, rerender } = render(
      <Switch checked onCheckedChange={onCheckedChange} label="إظهار التصنيف" {...props} />,
    )
    const control = screen.getByRole('switch', { name: 'إظهار التصنيف' })
    return {
      control,
      thumb: () => container.querySelector('[aria-hidden="true"]'),
      onCheckedChange,
      rerender: (next: Partial<Parameters<typeof Switch>[0]>) =>
        rerender(
          <Switch checked onCheckedChange={onCheckedChange} label="إظهار التصنيف" {...next} />,
        ),
    }
  }

  it('keeps the accessible name, ON/OFF state, and keyboard affordance', () => {
    const { control, rerender } = renderSwitch()

    expect(control).toHaveAttribute('aria-checked', 'true')
    // Not a native checkbox, so activation is the button's own click (Enter/Space).
    expect(control.tagName).toBe('BUTTON')
    expect(control).toHaveAttribute('type', 'button')
    expect(control.className).toContain('focus-visible:outline-focus')
    // The thumb is decorative: the state is announced once, by aria-checked.
    expect(control.querySelector('[aria-hidden="true"]')).toBeInTheDocument()

    rerender({ checked: false })
    expect(control).toHaveAttribute('aria-checked', 'false')
  })

  it('paints the state tone green when on and soft neutral when off', () => {
    const { control, thumb, rerender } = renderSwitch({ tone: 'state' })

    // ON: the shared success green, not a new hardcoded one.
    expect(control).toHaveClass('bg-switch-on-track', 'border-switch-on-track-border')
    expect(thumb()).toHaveClass('bg-switch-on-thumb')
    // No magenta/brown identity leaks into the state tone.
    expect(control.className).not.toMatch(/new|surface-muted|foreground-muted/)

    rerender({ checked: false, tone: 'state' })
    expect(control).toHaveClass('bg-switch-off-track', 'border-switch-off-track-border')
    expect(thumb()).toHaveClass('bg-switch-off-thumb')
    expect(control.className).not.toMatch(/new|surface-muted|foreground-muted/)
  })

  it('keeps the NEW accent as the default so unrelated switches are unchanged', () => {
    // The catalog's "new item" toggle relies on this default to match the NEW
    // card frame; it must not silently turn green.
    const { control, thumb } = renderSwitch()

    expect(control).toHaveClass('bg-new-soft', 'border-new-border')
    expect(thumb()).toHaveClass('bg-new')
  })

  it('keeps the thumb travelling on the logical inline-start edge in RTL', () => {
    const { thumb, rerender } = renderSwitch({ tone: 'state' })

    // Asserted on the resolved logical class, not on the source spelling:
    // tailwind-merge rewrites `start-[…]` to its `inset-s-[…]` alias. What
    // matters for Arabic is that the offset is LOGICAL and never a physical
    // left/right, and that ON parks the knob at the far edge while OFF rests
    // it at the near one.
    const classOf = () => thumb()?.className ?? ''
    expect(classOf()).toMatch(/inset-s-\[calc\(100%-1\.375rem\)\]/)
    expect(classOf()).not.toMatch(/(^|[\s:])(left|right|ml|mr)-/)

    // …and the OFF position is the resting edge.
    rerender({ checked: false, tone: 'state' })
    expect(classOf()).toMatch(/inset-s-1\.5/)
    expect(classOf()).not.toMatch(/(^|[\s:])(left|right|ml|mr)-/)
  })
})

describe('Loader', () => {
  it('is decorative without a label and labelled when standalone', () => {
    const { container, rerender } = render(<Loader size="sm" />)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    rerender(<Loader size="lg" label="جارٍ التحميل" />)
    expect(screen.getByRole('status', { name: 'جارٍ التحميل' })).toHaveClass('size-8')
  })
})

describe('Skeleton', () => {
  it('renders accessible and decorative variants with overrides', () => {
    const { container, rerender } = render(<Skeleton className="h-10 w-full" />)
    expect(screen.getByRole('status', { name: 'جارٍ التحميل…' })).toHaveClass('h-10', 'w-full')
    rerender(<Skeleton variant="circle" accessibilityLabel="" className="size-12" />)
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
    expect(container.firstElementChild).toHaveClass('rounded-full', 'size-12')
  })
})

describe('semantic badge mappings', () => {
  it('uses canonical role styling while preserving generic variants', () => {
    const visual = getRoleVisual('ADMIN')
    const { container } = render(
      <>
        <Badge role="ADMIN">مدير</Badge>
        <Badge variant="success">نشط</Badge>
      </>,
    )
    const [roleBadge, genericBadge] = Array.from(container.children)

    expect(roleBadge).toHaveClass(
      visual.badgeBackground,
      visual.badgeForeground,
      visual.badgeBorder,
    )
    expect(genericBadge).toHaveClass(
      'border-badge-success-border',
      'bg-badge-success-bg',
      'text-badge-success-fg',
    )
  })

  it('uses the same canonical role definition for Badge and EmployeeAvatar', () => {
    const visual = getRoleVisual('MANAGER')
    const { container } = render(
      <>
        <Badge role="MANAGER">مدير</Badge>
        <EmployeeAvatar role="MANAGER" />
      </>,
    )
    const [badge, avatar] = Array.from(container.children)

    expect(badge).toHaveClass(visual.badgeBackground, visual.badgeForeground, visual.badgeBorder)
    expect(avatar).toHaveClass(visual.background, visual.avatarForeground)
  })

  it.each([
    ['PAID', 'success'],
    ['PARTIALLY_PAID', 'warning'],
    ['CREDIT', 'warning'],
    ['UNKNOWN', 'neutral'],
  ])('maps invoice %s to %s', (status, expected) =>
    expect(invoiceBadgeVariant(status)).toBe(expected),
  )

  it.each([
    ['DONE', 'success'],
    ['FAILED', 'danger'],
    ['PENDING', 'warning'],
  ])('maps print job %s to %s', (status, expected) =>
    expect(printJobBadgeVariant(status)).toBe(expected),
  )

  it.each([
    ['EMPTY', 'danger'],
    ['OPEN', 'info'],
    ['OCCUPIED', 'success'],
  ])('maps table %s to %s', (status, expected) => expect(tableBadgeVariant(status)).toBe(expected))
})

describe('credential visibility (PasswordInput — the one implementation)', () => {
  /** The toggle is a real control with a translated, state-aware name. */
  function toggle(): HTMLButtonElement {
    return screen.getByRole('button', { name: i18n.t('auth.showPassword') })
  }

  it('starts hidden and reveals, then re-masks, without touching the value', () => {
    render(<PasswordInput aria-label="الرمز" defaultValue="2214" />)
    const input = screen.getByLabelText('الرمز') as HTMLInputElement

    // Default state is HIDDEN — the eye invites the user to look.
    expect(input).toHaveAttribute('type', 'password')
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(toggle())
    expect(input).toHaveAttribute('type', 'text')
    // The name FLIPS with the state, so it always names the action available.
    expect(screen.getByRole('button', { name: i18n.t('auth.hidePassword') })).toBeInTheDocument()
    // The value is untouched: the toggle flips `type` and nothing else.
    expect(input.value).toBe('2214')

    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.hidePassword') }))
    expect(input).toHaveAttribute('type', 'password')
    expect(input.value).toBe('2214')
  })

  it('never submits the form it sits in', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <PasswordInput aria-label="الرمز" defaultValue="2214" />
      </form>,
    )
    // `type="button"`, not a submit button: revealing a credential must never
    // post the surrounding form.
    expect(toggle()).toHaveAttribute('type', 'button')
    fireEvent.click(toggle())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('renders NO toggle while the field is empty — nothing to reveal', () => {
    render(<PasswordInput aria-label="الرمز" />)
    const input = screen.getByLabelText('الرمز') as HTMLInputElement

    expect(input.value).toBe('')
    // The eye is not merely disabled: it is absent, because a live control that
    // reveals nothing reads as a broken screen.
    expect(
      screen.queryByRole('button', { name: i18n.t('auth.showPassword') }),
    ).not.toBeInTheDocument()
    // And no space is reserved for a toggle that is not there.
    expect(input.className).not.toContain('pe-11')
  })

  it('offers the toggle as soon as a value is typed, and takes it back on clear', () => {
    const onChange = vi.fn()
    const { rerender } = render(<PasswordInput aria-label="الرمز" onChange={onChange} />)
    const input = screen.getByLabelText('الرمز') as HTMLInputElement

    fireEvent.change(input, { target: { value: '2214' } })
    expect(onChange).toHaveBeenCalled()
    const button = screen.getByRole('button', { name: i18n.t('auth.showPassword') })
    expect(input.className).toContain('pe-11')

    fireEvent.click(button)
    expect(input).toHaveAttribute('type', 'text')

    fireEvent.change(input, { target: { value: '' } })
    expect(screen.queryByRole('button', { name: /كلمة المرور/ })).not.toBeInTheDocument()
    // Clearing re-masks: there is no plaintext left to leave visible.
    expect(input).toHaveAttribute('type', 'password')
    // The consumer's own handler is still called exactly as before.
    expect(onChange).toHaveBeenCalledTimes(2)

    rerender(<PasswordInput aria-label="الرمز" onChange={onChange} />)
    expect(screen.queryByRole('button', { name: /كلمة المرور/ })).not.toBeInTheDocument()
  })

  it('is operable and named for assistive technology', () => {
    render(<PasswordInput aria-label="الرمز" defaultValue="2214" />)
    const button = toggle()
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveAccessibleName(i18n.t('auth.showPassword'))
    expect(button).toHaveClass('focus-visible:outline-focus')
  })

  it('is disabled with its field, so a busy form cannot be revealed', () => {
    render(<PasswordInput aria-label="الرمز" defaultValue="2214" disabled />)
    expect(toggle()).toBeDisabled()
  })
})

describe('PinInput', () => {
  /** The PIN is the SAME control: numeric, masked, and revealing the same way. */
  function renderPin(props: Partial<Parameters<typeof PinInput>[0]> = {}) {
    const onValueChange = vi.fn()
    const { rerender } = render(
      <PinInput aria-label="الرمز" value="2214" onValueChange={onValueChange} {...props} />,
    )
    return {
      input: screen.getByLabelText('الرمز') as HTMLInputElement,
      onValueChange,
      rerender: (next: Partial<Parameters<typeof PinInput>[0]>) =>
        rerender(
          <PinInput aria-label="الرمز" value="2214" onValueChange={onValueChange} {...next} />,
        ),
    }
  }

  it('reveals through the shared component, keeping the digits', () => {
    const { input } = renderPin()
    expect(input).toHaveAttribute('type', 'password')
    expect(input.inputMode).toBe('numeric')

    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.showPassword') }))
    expect(input).toHaveAttribute('type', 'text')
    expect(input.value).toBe('2214')
    // The reveal changed no rule: still digits, still the same cap.
    expect(input).toHaveAttribute('maxlength', '4')
    expect(input).toHaveAttribute('inputmode', 'numeric')
  })

  it('resolves the toggle and the reserved padding against the SAME direction', () => {
    // The defect this pins: `PinInput` forces `dir="ltr"` on the input so digits
    // read left to right, but the app itself is `dir="rtl"`. CSS logical
    // properties resolve per ELEMENT, so an `inset-inline-end` toggle in an RTL
    // wrapper lands on the LEFT while the input's `padding-inline-end` reserve
    // lands on the RIGHT. The eye then sat on top of the centred digits with
    // nothing reserved for it. The wrapper must carry the input's own direction.
    const { input } = renderPin({ length: 5, value: '2214' })
    const wrapper = input.parentElement as HTMLElement
    const toggle = screen.getByRole('button', { name: i18n.t('auth.showPassword') })

    expect(input).toHaveAttribute('dir', 'ltr')
    // One direction for both edges, so the reserve and the button coincide.
    expect(wrapper).toHaveAttribute('dir', 'ltr')
    expect(toggle.parentElement).toBe(wrapper)
    expect(wrapper.className).toContain('relative')
    // The toggle is still positioned logically, so it follows whatever that
    // direction is — it is not pinned to a physical side.
    expect(toggle.className).toContain('inset-e-2')
    // And the reserve the digits must never slide under is still there.
    expect(input.className).toContain('pe-14')
  })

  it('still refuses a letter, a symbol, or a sixth digit', () => {
    const { input, onValueChange } = renderPin({ length: 5, value: '' })
    fireEvent.change(input, { target: { value: '12a-34' } })
    expect(onValueChange).toHaveBeenLastCalledWith('1234')
  })
})

describe('Field', () => {
  it('associates its label with the control even when the caller names no id', () => {
    render(
      <Field label="المبلغ المستلم">
        <Input data-testid="amount" />
      </Field>,
    )
    const input = screen.getByTestId('amount')
    // The label points at the control, so clicking it focuses the input and a
    // screen reader announces the pair as one thing.
    expect(input.getAttribute('id')).toBeTruthy()
    expect(screen.getByText('المبلغ المستلم')).toHaveAttribute(
      'for',
      input.getAttribute('id') ?? '',
    )
  })

  it('keeps a caller-supplied id instead of replacing it', () => {
    render(
      <Field label="ملاحظة">
        <Input id="my-note" data-testid="note" />
      </Field>,
    )
    expect(screen.getByTestId('note')).toHaveAttribute('id', 'my-note')
    expect(screen.getByText('ملاحظة')).toHaveAttribute('for', 'my-note')
  })

  it('honours an explicit htmlFor for a control rendered elsewhere', () => {
    render(
      <>
        <Field label="الاسم" htmlFor="outside-control">
          <span>controlled elsewhere</span>
        </Field>
        <input id="outside-control" />
      </>,
    )
    expect(screen.getByText('الاسم')).toHaveAttribute('for', 'outside-control')
  })

  it('leaves a non-control child exactly as passed', () => {
    const { container } = render(
      <Field label="مجمّع">
        <div data-testid="group">anything</div>
      </Field>,
    )
    expect(container.querySelector('div[data-testid="group"]')).toBeTruthy()
  })
})
