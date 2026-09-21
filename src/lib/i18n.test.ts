import { describe, expect, it } from 'vitest'
import { isRtl } from './i18n'

describe('i18n locale helpers', () => {
  it('treats Arabic as RTL', () => {
    expect(isRtl('ar-EG')).toBe(true)
  })

  it('treats English as LTR (future locale support)', () => {
    expect(isRtl('en-US')).toBe(false)
  })
})
