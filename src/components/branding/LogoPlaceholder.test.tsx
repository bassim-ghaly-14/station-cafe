import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LogoPlaceholder } from './LogoPlaceholder'

describe('LogoPlaceholder', () => {
  it('renders with an accessible label and never leaks a final logo', () => {
    render(<LogoPlaceholder />)
    expect(screen.getByRole('img', { name: 'Station Cafe' })).toBeInTheDocument()
  })
})
