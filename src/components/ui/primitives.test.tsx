import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { Check } from './icon'
import { Badge } from './badge'
import { EmployeeAvatar } from './employee-avatar'
import { getRoleVisual } from '@/lib/roles'
import { Loader } from './loader'
import { Skeleton } from './skeleton'
import { Switch, Field, Input } from './input'
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
