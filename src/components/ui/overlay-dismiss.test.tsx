/**
 * Scrim dismiss semantics for the three overlay primitives.
 *
 * The scrim is a backdrop, not a control: it deliberately carries no role and
 * no tab stop, because a full-screen dismiss affordance a keyboard user could
 * land on would be worse than none — the Escape key and the panel's own close
 * button already dismiss. Its dismiss behaviour is therefore bound as a native
 * `mousedown` listener on the element rather than a React handler
 * (typescript:S6848).
 *
 * These tests pin the behaviour that binding has to keep: the empty scrim
 * dismisses exactly once, a press inside the panel never does, and Escape,
 * focus and the markup stay exactly as they were.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '@/lib/i18n'
import { Dialog } from './dialog'
import { Drawer } from './drawer'
import { Sheet } from './sheet'

/** The shape all three primitives share, so one suite can cover all of them. */
type Primitive = (props: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactElement
}) => ReactElement

const PRIMITIVES: [name: string, Component: Primitive][] = [
  ['Dialog', Dialog as Primitive],
  ['Drawer', Drawer as Primitive],
  ['Sheet', Sheet as Primitive],
]

/** The scrim is the panel's only parent in all three primitives. */
function scrimOf(panel: HTMLElement): HTMLElement {
  return panel.parentElement as HTMLElement
}

function renderPrimitive(Component: Primitive, onClose: () => void) {
  return render(
    <Component open onClose={onClose} title="عنوان">
      <div>
        <input aria-label="amount" />
        <button type="button">إجراء</button>
        <div data-testid="scroll" />
      </div>
    </Component>,
  )
}

describe.each(PRIMITIVES)('%s scrim', (_name, Component) => {
  it('is a plain backdrop: no interactive role and no tab stop', () => {
    renderPrimitive(Component, vi.fn())
    const scrim = scrimOf(screen.getByRole('dialog'))
    expect(scrim.tagName).toBe('DIV')
    // The point of the fix for typescript:S6848: the scrim is still not a
    // control — no role="button", no tabIndex, nothing for AT to announce.
    expect(scrim).not.toHaveAttribute('role')
    expect(scrim).not.toHaveAttribute('tabindex')
    expect(scrim).not.toHaveAttribute('aria-label')
    // The panel keeps its own semantics, and the layout classes are untouched.
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
    expect(scrim.className).toContain('bg-overlay')
  })

  it('dismisses once when the empty scrim is pressed', () => {
    const onClose = vi.fn()
    const { container } = renderPrimitive(Component, onClose)
    const scrim = scrimOf(screen.getByRole('dialog'))

    fireEvent.mouseDown(scrim)
    expect(onClose).toHaveBeenCalledTimes(1)
    // The scrim is still the top-level layer, with the panel as its only child.
    expect(container.firstElementChild).toBe(scrim)
    expect(scrim.children).toHaveLength(1)
  })

  it('does not dismiss for a press inside the panel, whatever it landed on', () => {
    const onClose = vi.fn()
    renderPrimitive(Component, onClose)
    const panel = screen.getByRole('dialog')

    fireEvent.mouseDown(panel)
    fireEvent.mouseDown(screen.getByTestId('scroll'))
    fireEvent.mouseDown(screen.getByLabelText('amount'))
    fireEvent.mouseDown(screen.getByRole('button', { name: 'إجراء' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not dismiss for a gesture that starts inside and ends on the scrim', () => {
    // A drag, a text selection, or a scroll released past the panel edge: the
    // press target is still inside, so the layer must stay open.
    const onClose = vi.fn()
    renderPrimitive(Component, onClose)
    const scrim = scrimOf(screen.getByRole('dialog'))

    fireEvent.mouseDown(screen.getByLabelText('amount'))
    fireEvent.mouseMove(scrim)
    fireEvent.mouseUp(scrim)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps Escape, the close button, inputs and initial focus working', () => {
    const onClose = vi.fn()
    renderPrimitive(Component, onClose)

    // Initial focus still lands, exactly once, on the dismiss control.
    expect(screen.getByRole('button', { name: 'إغلاق' })).toHaveFocus()

    // A control inside the panel still receives its typing and keeps focus.
    const input = screen.getByLabelText('amount') as HTMLInputElement
    input.focus()
    fireEvent.change(input, { target: { value: '42' } })
    expect(input.value).toBe('42')
    expect(input).toHaveFocus()
    expect(onClose).not.toHaveBeenCalled()

    // Escape still closes.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stops dismissing once unmounted', () => {
    const onClose = vi.fn()
    const { unmount } = renderPrimitive(Component, onClose)
    const scrim = scrimOf(screen.getByRole('dialog'))
    unmount()
    fireEvent.mouseDown(scrim)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('invokes the latest onClose on a scrim press, never a stale one', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(
      <Component open onClose={first} title="عنوان">
        <div>content</div>
      </Component>,
    )
    rerender(
      <Component open onClose={second} title="عنوان">
        <div>content</div>
      </Component>,
    )
    fireEvent.mouseDown(scrimOf(screen.getByRole('dialog')))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
