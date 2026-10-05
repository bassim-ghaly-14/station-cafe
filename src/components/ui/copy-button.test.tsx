/**
 * The shared copy control.
 *
 * What these tests hold in place
 * ------------------------------
 *  - A successful click copies EXACTLY the value it was given, and says so
 *    three ways at once: a check glyph, the "copied" accessible name, and a
 *    toast. The state is not communicated by the icon alone.
 *  - The success state is TEMPORARY and resets on its own, and a repeated click
 *    restarts that window rather than leaving the check stuck on.
 *  - A failed write raises an error toast and NEVER claims success — the worst
 *    possible outcome for this control is telling a user something is on the
 *    clipboard when it is not.
 *  - The capability gate is preserved: nothing at all is rendered in an origin
 *    with no clipboard.
 *  - Accessibility: a real accessible name, keyboard operable, a native `title`
 *    kept in step with the name, and a decorative glyph.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { CopyButton, ToastProvider } from '@/components/ui'

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

/** The button, found by its resting accessible name. */
const control = () => screen.getByRole('button', { name: 'نسخ التليفون' })

/** Installs a clipboard whose `writeText` resolves, and returns the spy. */
function clipboardOk() {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

/** Installs a clipboard whose `writeText` rejects. */
function clipboardFails() {
  const writeText = vi.fn().mockRejectedValue(new Error('denied'))
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

function renderCopy(over: { text?: string } = {}) {
  return render(
    <ToastProvider>
      <CopyButton
        value="01012345678"
        label="نسخ التليفون"
        copiedLabel="تم النسخ"
        data-testid="copy"
        {...over}
      />
    </ToastProvider>,
  )
}

describe('CopyButton', () => {
  beforeEach(() => {
    // The suite default is the desktop shell, which is what the copy feature is
    // for; the browser cases below delete the marker to model a LAN origin.
    window.__TAURI_INTERNALS__ = {}
    clipboardOk()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('copies exactly the value it was given', async () => {
    const writeText = clipboardOk()
    renderCopy()

    fireEvent.click(control())

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('01012345678'))
  })

  it('shows the success state and announces it three ways', async () => {
    renderCopy()
    expect(control()).toHaveAttribute('title', 'نسخ التليفون')

    fireEvent.click(control())

    // The accessible NAME changes, so the state is not carried by the icon
    // alone, and the native tooltip travels with it in step.
    const copied = await screen.findByRole('button', { name: 'تم النسخ' })
    expect(copied).toHaveAttribute('title', 'تم النسخ')
    // The glyph actually swapped: a check is drawn, not a second copy.
    expect(copied.querySelector('.lucide-check')).toBeTruthy()
    expect(copied.querySelector('.lucide-copy')).toBeFalsy()
    // And the project's own toast stack carries the announcement.
    expect(screen.getByText('تم النسخ')).toBeInTheDocument()
  })

  it('returns to the copy state on its own', async () => {
    vi.useFakeTimers()
    clipboardOk()
    renderCopy()

    fireEvent.click(control())
    // With fake timers installed, `waitFor`/`findBy` cannot be used — they poll
    // on the very clock that is now stopped. The clipboard write resolves as a
    // microtask, so a single `act` flush is what a click actually awaits.
    await act(async () => undefined)
    expect(screen.getByRole('button', { name: 'تم النسخ' })).toBeInTheDocument()

    // Time alone takes the control back to Copy — the button's resting meaning
    // is "copy this", not "this was copied once".
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })

    expect(screen.getByRole('button', { name: 'نسخ التليفون' })).toBeInTheDocument()
  })

  it('restarts the feedback window on a second click rather than stacking it', async () => {
    vi.useFakeTimers()
    const writeText = clipboardOk()
    renderCopy()
    // The element is captured once and reused: after the first click its
    // accessible name is "تم النسخ", so re-querying by the resting name would
    // (correctly) fail. The component is not remounted — only its name changes.
    const button = control()

    fireEvent.click(button)
    await act(async () => undefined)
    expect(writeText).toHaveBeenCalledTimes(1)
    // Most of the first window elapses...
    await act(async () => {
      vi.advanceTimersByTime(1200)
    })
    // ...then a second copy happens, which must restart the countdown, so the
    // check cannot be cleared out from under the user mid-feedback.
    fireEvent.click(button)
    await act(async () => undefined)
    expect(writeText).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(1200)
    })
    expect(screen.getByRole('button', { name: 'تم النسخ' })).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(screen.getByRole('button', { name: 'نسخ التليفون' })).toBeInTheDocument()
  })

  it('never claims success when the clipboard write is refused', async () => {
    clipboardFails()
    renderCopy()

    fireEvent.click(control())

    // The generic translated error, and NO "copied" state anywhere.
    await screen.findByText('حدث خطأ غير متوقع')
    expect(screen.queryByRole('button', { name: 'تم النسخ' })).not.toBeInTheDocument()
    expect(screen.queryByText('تم النسخ')).not.toBeInTheDocument()
  })

  it('renders nothing at all in an origin with no clipboard', () => {
    // A phone that arrived through the QR is on plain `http://`, where the API
    // is undefined. A control that could only ever fail is not rendered, and it
    // is not merely hidden — a `display: none` button stays focusable.
    delete window.__TAURI_INTERNALS__
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })

    renderCopy()

    // Asserted on the control, not on the container: `ToastProvider` always
    // renders its (empty) `aria-live` region, so an emptiness check on the
    // container would be asserting something that is true in every test.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('copy')).not.toBeInTheDocument()
  })

  it('still copies in a browser that genuinely exposes the clipboard', async () => {
    delete window.__TAURI_INTERNALS__
    const writeText = clipboardOk()
    renderCopy()

    fireEvent.click(control())

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('01012345678'))
  })

  it('is keyboard operable and never announces its decorative glyph', async () => {
    const { container } = renderCopy()
    const button = control()

    // A real `<button>`, so Enter and Space work without any extra wiring.
    expect(button.tagName).toBe('BUTTON')
    button.focus()
    expect(button).toHaveFocus()
    fireEvent.click(button)

    await screen.findByRole('button', { name: 'تم النسخ' })
    // The glyph is hidden from assistive tech in BOTH states; the name carries
    // the meaning, so a screen reader never reads a bare "copy" or "check".
    expect(container.querySelectorAll('svg[aria-hidden="true"]').length).toBeGreaterThan(0)
  })

  it('carries a visible label in its labelled form, and swaps it on success', async () => {
    const writeText = clipboardOk()
    renderCopy({ text: 'نسخ الرابط' })

    const button = screen.getByRole('button', { name: 'نسخ التليفون' })
    expect(button).toHaveTextContent('نسخ الرابط')
    // The QR page's own presentation: a labelled `secondary` button, not the
    // compact icon the number screens use.
    expect(button).toHaveClass('bg-secondary')

    fireEvent.click(button)
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: 'تم النسخ' })).toHaveTextContent('تم النسخ')
  })
})
