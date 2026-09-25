import { render, screen } from '@testing-library/react'
import { Check } from './icon'
import { Badge } from './badge'
import { EmployeeAvatar } from './employee-avatar'
import { getRoleVisual } from '@/lib/roles'
import { Loader } from './loader'
import { Skeleton } from './skeleton'
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
