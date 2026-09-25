import { render, screen } from '@testing-library/react'
import { getRoleVisual } from '@/lib/roles'
import { EmployeeAvatar } from './employee-avatar'

function avatarFor(role?: string | null) {
  render(<EmployeeAvatar role={role} accessibilityLabel="Employee identity" />)
  return screen.getByRole('img', { name: 'Employee identity' })
}

describe('EmployeeAvatar', () => {
  it.each(['ADMIN', 'MANAGER', 'STAFF'] as const)(
    'uses the canonical %s role visual for the avatar',
    (role) => {
      const avatar = avatarFor(role)
      const visual = getRoleVisual(role)

      expect(avatar).toHaveAttribute('data-employee-role', role)
      expect(avatar).toHaveClass(visual.background, visual.avatarForeground)
    },
  )

  it.each([null, undefined, 'UNKNOWN'])('uses fallback styling for role %s', (role) => {
    const avatar = avatarFor(role)
    const visual = getRoleVisual(role)

    expect(avatar).toHaveAttribute('data-employee-role', 'FALLBACK')
    expect(avatar).toHaveClass(visual.background, visual.avatarForeground)
  })

  it('always renders the same Lucide user icon', () => {
    const { container: adminContainer } = render(<EmployeeAvatar role="ADMIN" />)
    const adminIcon = adminContainer.querySelector('svg')?.outerHTML
    const { container: staffContainer } = render(<EmployeeAvatar role="STAFF" />)
    const staffIcon = staffContainer.querySelector('svg')?.outerHTML

    expect(adminIcon).toBeTruthy()
    expect(adminIcon).toBe(staffIcon)
  })

  it('is decorative when a visible employee name already provides the accessible identity', () => {
    const { container } = render(<EmployeeAvatar role="MANAGER" />)
    expect(container.querySelector('[role="img"]')).toBeNull()
    expect(screen.getByTestId('employee-avatar')).toHaveAttribute('aria-hidden', 'true')
  })
})
