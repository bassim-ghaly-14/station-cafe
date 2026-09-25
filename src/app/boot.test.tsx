import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { BOOT_MIN_DURATION_MS, useMinimumBootDelayElapsed } from './boot'

describe('useMinimumBootDelayElapsed', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('enforces a 3000ms minimum boot duration', () => {
    expect(BOOT_MIN_DURATION_MS).toBe(3000)
    vi.useFakeTimers()
    // Fresh boot start under the fake clock (the shared module clock started
    // under real time, so the test injects its own `from` timestamp).
    const startedAt = Date.now()
    const { result } = renderHook(() => useMinimumBootDelayElapsed(startedAt))
    // Boot just started: minimum has not elapsed yet.
    expect(result.current).toBe(false)
    // Just before the minimum: still not elapsed.
    act(() => {
      vi.advanceTimersByTime(BOOT_MIN_DURATION_MS - 1)
    })
    expect(result.current).toBe(false)
    // At the minimum: elapsed, boot may exit once initialization is ready.
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe(true)
  })

  it('resolves immediately when the minimum already elapsed', () => {
    vi.useFakeTimers()
    const longAgo = Date.now() - BOOT_MIN_DURATION_MS - 1000
    const { result } = renderHook(() => useMinimumBootDelayElapsed(longAgo))
    expect(result.current).toBe(true)
  })
})
