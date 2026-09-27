import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProgressBar } from '@/components/ui/progress-bar'
import { Skeleton } from '@/components/ui/skeleton'
import { ListRowsSkeleton } from '@/components/ui/loading-skeletons'

describe('implicit status role after div/span -> output conversion', () => {
  it('ProgressBar still exposes role=status with its accessible name', () => {
    render(<ProgressBar label="جارٍ التحديث" />)
    const el = screen.getByRole('status', { name: 'جارٍ التحديث' })
    expect(el.tagName).toBe('OUTPUT')
  })

  it('Skeleton still exposes role=status when labelled', () => {
    render(<Skeleton accessibilityLabel="جارٍ التحميل" />)
    expect(screen.getByRole('status', { name: 'جارٍ التحميل' }).tagName).toBe('OUTPUT')
  })

  it('decorative Skeleton stays hidden and unnamed', () => {
    const { container } = render(<Skeleton accessibilityLabel="" />)
    const el = container.querySelector('output')!
    expect(el).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('sr-only loading text is still announced as a status region', () => {
    render(<ListRowsSkeleton rows={1} />)
    const el = screen.getByRole('status')
    expect(el.tagName).toBe('OUTPUT')
    expect(el).toHaveClass('sr-only')
  })
})
