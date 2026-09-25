/**
 * The shared Dialog owns the focus lifecycle for every modal in the app.
 *
 * The regression these tests lock down: the initial-focus effect used to depend
 * on `onClose`, which every call site supplies as an inline arrow. The effect
 * therefore re-ran on EVERY render and re-focused the first focusable element
 * in DOM order — the header close button — so a text input lost focus after a
 * single keystroke and multi-character entry became impossible.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '@/lib/i18n'
import { Dialog } from './dialog'

function Harness({ onClose }: { onClose?: () => void }) {
  // Deliberately inline arrows, exactly like every production call site.
  return (
    <Dialog open onClose={onClose ?? (() => {})} title="عنوان">
      <input aria-label="amount" />
    </Dialog>
  )
}

/** Same pattern as the closing dialogs: a value that re-renders on each keystroke. */
function TypedHarness() {
  const [value, setValue] = useState('')
  return (
    <Dialog open onClose={() => setValue('')} title="عنوان">
      <input
        aria-label="amount"
        data-dialog-autofocus=""
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <span data-testid="echo">{value}</span>
    </Dialog>
  )
}

describe('Dialog focus lifecycle', () => {
  it('focuses the declared control once and never steals focus while typing', async () => {
    render(<TypedHarness />)
    const input = screen.getByLabelText('amount') as HTMLInputElement
    expect(input).toHaveFocus()

    // Every keystroke re-renders the parent and creates a new `onClose`.
    for (const char of ['1', '2', '3', '.', '5', '0']) {
      fireEvent.change(input, { target: { value: input.value + char } })
      expect(input).toHaveFocus()
    }
    expect(input.value).toBe('123.50')
    expect(screen.getByTestId('echo')).toHaveTextContent('123.50')
  })

  it('keeps focus in the field while the value is edited and deleted', async () => {
    render(<TypedHarness />)
    const input = screen.getByLabelText('amount') as HTMLInputElement

    fireEvent.change(input, { target: { value: '250' } })
    expect(input).toHaveFocus()
    // Deleting back to empty must not move focus either.
    fireEvent.change(input, { target: { value: '' } })
    expect(input).toHaveFocus()
    expect(input.value).toBe('')
    // And typing again after an empty state still works.
    fireEvent.change(input, { target: { value: '7' } })
    expect(input).toHaveFocus()
    expect(input.value).toBe('7')
  })

  it('falls back to the first focusable element when none is marked', () => {
    render(<Harness />)
    // The close button is the first focusable in DOM order.
    expect(screen.getByRole('button', { name: 'إغلاق' })).toHaveFocus()
  })

  it('does not re-focus a control the user moved focus to', async () => {
    render(<Harness />)
    const close = screen.getByRole('button', { name: 'إغلاق' })
    const input = screen.getByLabelText('amount') as HTMLInputElement
    input.focus()
    fireEvent.change(input, { target: { value: '10' } })
    expect(input).toHaveFocus()
    expect(close).not.toHaveFocus()
  })

  it('calls the latest onClose on Escape without re-subscribing per render', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<Harness onClose={first} />)
    rerender(<Harness onClose={second} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('stops listening for Escape once unmounted', async () => {
    const onClose = vi.fn()
    const { unmount } = render(<Harness onClose={onClose} />)
    unmount()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(onClose).not.toHaveBeenCalled())
  })
})
