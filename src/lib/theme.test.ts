import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, getCurrentTheme, getInitialTheme, THEME_STORAGE_KEY } from './theme'

/** Make the OS preference report a dark or light system. */
function systemPrefersDark(dark: boolean) {
  // jsdom does not implement matchMedia at all, so it is defined outright
  // rather than spied on.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({ matches: dark, media: query }) as MediaQueryList,
  })
}

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    vi.restoreAllMocks()
  })

  it('honours an explicit stored light choice even when the system is dark', () => {
    systemPrefersDark(true)
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    expect(getInitialTheme()).toBe('light')
  })

  it('honours an explicit stored dark choice even when the system is light', () => {
    systemPrefersDark(false)
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    expect(getInitialTheme()).toBe('dark')
  })

  it('falls back to the system preference when nothing is stored', () => {
    systemPrefersDark(true)
    expect(getInitialTheme()).toBe('dark')
  })

  it('falls back to light when nothing is stored and the system is light', () => {
    systemPrefersDark(false)
    expect(getInitialTheme()).toBe('light')
  })

  // The boot script in index.html runs before any module is loaded, and repeats
  // this same decision so the first paint is already in the right theme. An
  // unrecognised stored value must therefore mean "no choice at all" in both
  // places, never a silent light.
  it('treats an unrecognised stored value as no choice at all', () => {
    systemPrefersDark(true)
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    expect(getInitialTheme()).toBe('dark')
  })

  it('applyTheme writes both the document attribute and the stored choice', () => {
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(getCurrentTheme()).toBe('dark')
  })

  it('getCurrentTheme reads light unless the document is explicitly dark', () => {
    expect(getCurrentTheme()).toBe('light')
    document.documentElement.dataset.theme = 'dark'
    expect(getCurrentTheme()).toBe('dark')
  })
})
