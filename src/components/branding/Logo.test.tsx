import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Logo } from './Logo'

describe('Logo', () => {
  it('renders with an accessible label', () => {
    render(<Logo />)
    expect(screen.getByRole('img', { name: 'Station Cafe' })).toBeInTheDocument()
  })
})
