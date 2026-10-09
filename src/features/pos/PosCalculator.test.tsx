/**
 * POS floating calculator — UI integration.
 *
 * These tests drive the REAL component (not the engine) to hold in place the
 * behaviour a cashier depends on: opening/closing through the toggle and the
 * panel's own controls, the pinned-vs-unpinned lifecycle, that a pinned panel
 * never blocks POS interaction, that the Copy Button receives the NORMALISED
 * result and is disabled without one, the history surface + empty state, and
 * that keyboard shortcuts work in context but never hijack a POS input.
 *
 * The component is rendered standalone — it owns its own open/pinned/close
 * contract through props and the shared `usePinned` store, so a full PosPage
 * render would only add POS-service noise without exercising anything new.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { ToastProvider } from '@/components/ui'
import { PosCalculator } from './PosCalculator'
import { resetPinned } from './calculator/usePinned'

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

/** Reset the persisted pin + history so suites never leak into one another. */
beforeEach(() => {
  window.localStorage.clear()
  // The pin store caches its value in a module-level Map; clear it too so a
  // prior suite's pin cannot leak into this one.
  resetPinned()
  window.__TAURI_INTERNALS__ = {} // desktop shell: the copy feature is available
  // A clipboard whose writeText resolves, so a copy can be observed.
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Render the panel with a controllable close spy. */
function renderCalc(over: { open?: boolean; onRequestClose?: () => void } = {}) {
  const onRequestClose = over.onRequestClose ?? vi.fn()
  const open = over.open ?? true
  const utils = render(
    <ToastProvider>
      <PosCalculator open={open} onRequestClose={onRequestClose} />
    </ToastProvider>,
  )
  return { onRequestClose, ...utils }
}

/** Type a string of digits/`.` through the on-screen keypad. */
function press(keys: string) {
  for (const k of keys) {
    if (k === '.') fireEvent.click(screen.getByTestId('calc-decimal'))
    else fireEvent.click(screen.getByTestId(`calc-${k}`))
  }
}

/** The clipboard spy installed in beforeEach. */
function clipboard(): ReturnType<typeof vi.fn> {
  return navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>
}

describe('PosCalculator — open and close', () => {
  it('renders nothing when closed', () => {
    renderCalc({ open: false })
    expect(screen.queryByTestId('pos-calculator')).toBeNull()
  })

  it('renders the panel when open', () => {
    renderCalc({ open: true })
    expect(screen.getByTestId('pos-calculator')).toBeInTheDocument()
  })

  it('closes through its own close control', () => {
    const { onRequestClose } = renderCalc({ open: true })
    fireEvent.click(screen.getByTestId('calc-close'))
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('closes on an outside mousedown while unpinned', () => {
    const { onRequestClose } = renderCalc({ open: true })
    fireEvent.mouseDown(document.body)
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('does NOT close on a mousedown inside the panel', () => {
    const { onRequestClose } = renderCalc({ open: true })
    fireEvent.mouseDown(screen.getByTestId('pos-calculator'))
    expect(onRequestClose).not.toHaveBeenCalled()
  })

  it('closes on Escape while unpinned', () => {
    const { onRequestClose } = renderCalc({ open: true })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })
})

describe('PosCalculator — pinned vs unpinned', () => {
  it('a pinned panel ignores outside-click dismissal', () => {
    const { onRequestClose } = renderCalc({ open: true })
    fireEvent.click(screen.getByTestId('calc-pin'))
    expect(screen.getByTestId('pos-calculator')).toHaveAttribute('data-pinned', 'true')
    fireEvent.mouseDown(document.body)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onRequestClose).not.toHaveBeenCalled()
  })

  it('unpinning restores dismissible behaviour without closing', () => {
    const { onRequestClose } = renderCalc({ open: true })
    fireEvent.click(screen.getByTestId('calc-pin')) // pin
    fireEvent.click(screen.getByTestId('calc-pin')) // unpin
    expect(screen.getByTestId('pos-calculator')).toHaveAttribute('data-pinned', 'false')
    // Still open — unpinning must not close it.
    expect(screen.getByTestId('pos-calculator')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('the pin control exposes an accessible pressed state', () => {
    renderCalc({ open: true })
    const pin = screen.getByTestId('calc-pin')
    expect(pin).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(pin)
    expect(screen.getByTestId('calc-pin')).toHaveAttribute('aria-pressed', 'true')
  })
})
describe('PosCalculator — arithmetic through the UI', () => {
  it('computes 5 + 3 = 8 and shows the result', () => {
    renderCalc({ open: true })
    press('5')
    fireEvent.click(screen.getByTestId('calc-add'))
    press('3')
    fireEvent.click(screen.getByTestId('calc-equals'))
    expect(screen.getByTestId('calc-display')).toHaveTextContent('8')
  })

  it('shows 0.1 + 0.2 as 0.3', () => {
    renderCalc({ open: true })
    press('0.1')
    fireEvent.click(screen.getByTestId('calc-add'))
    press('0.2')
    fireEvent.click(screen.getByTestId('calc-equals'))
    expect(screen.getByTestId('calc-display')).toHaveTextContent('0.3')
  })

  it('shows a readable divide-by-zero message, never Infinity', () => {
    renderCalc({ open: true })
    press('5')
    fireEvent.click(screen.getByTestId('calc-divide'))
    press('0')
    fireEvent.click(screen.getByTestId('calc-equals'))
    expect(screen.getByTestId('calc-display')).not.toHaveTextContent('Infinity')
    expect(screen.getByTestId('calc-display')).not.toHaveTextContent('NaN')
    // The copy control is disabled while there is no valid result.
    expect(screen.getByTestId('calc-copy')).toBeDisabled()
  })

  it('clear (AC) resets the display to 0', () => {
    renderCalc({ open: true })
    press('123')
    fireEvent.click(screen.getByTestId('calc-clear'))
    expect(screen.getByTestId('calc-display')).toHaveTextContent('0')
  })
})

describe('PosCalculator — Copy Button integration', () => {
  it('copies the normalised result (a plain number, no currency)', async () => {
    renderCalc({ open: true })
    press('5')
    fireEvent.click(screen.getByTestId('calc-add'))
    press('3')
    fireEvent.click(screen.getByTestId('calc-equals'))
    fireEvent.click(screen.getByTestId('calc-copy'))
    await waitFor(() => expect(clipboard()).toHaveBeenCalledWith('8'))
  })

  it('copies a clean decimal, not a float artefact', async () => {
    renderCalc({ open: true })
    press('0.1')
    fireEvent.click(screen.getByTestId('calc-add'))
    press('0.2')
    fireEvent.click(screen.getByTestId('calc-equals'))
    fireEvent.click(screen.getByTestId('calc-copy'))
    await waitFor(() => expect(clipboard()).toHaveBeenCalledWith('0.3'))
  })

  it('is disabled when there is no valid result (divide by zero)', () => {
    renderCalc({ open: true })
    press('5')
    fireEvent.click(screen.getByTestId('calc-divide'))
    press('0')
    fireEvent.click(screen.getByTestId('calc-equals'))
    expect(screen.getByTestId('calc-copy')).toBeDisabled()
  })

  it('is enabled once a valid result exists', () => {
    renderCalc({ open: true })
    press('9')
    fireEvent.click(screen.getByTestId('calc-equals'))
    expect(screen.getByTestId('calc-copy')).not.toBeDisabled()
  })
})

describe('PosCalculator — history surface', () => {
  it('shows the empty state before any calculation', () => {
    renderCalc({ open: true })
    fireEvent.click(screen.getByTestId('calc-history-toggle'))
    const panel = screen.getByTestId('calc-history')
    expect(within(panel).getByText(i18n.t('pos.calculator.historyEmpty'))).toBeInTheDocument()
  })

  it('records a completed calculation and lists it newest-first', () => {
    renderCalc({ open: true })
    fireEvent.click(screen.getByTestId('calc-history-toggle'))
    // 2 + 3
    press('2')
    fireEvent.click(screen.getByTestId('calc-add'))
    press('3')
    fireEvent.click(screen.getByTestId('calc-equals'))
    // 10 × 4
    press('1')
    press('0')
    fireEvent.click(screen.getByTestId('calc-multiply'))
    press('4')
    fireEvent.click(screen.getByTestId('calc-equals'))

    const items = within(screen.getByTestId('calc-history')).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('10 × 4')
    expect(items[1]).toHaveTextContent('2 + 3')
  })

  it('selecting a history entry restores its result without adding a row', () => {
    renderCalc({ open: true })
    press('2')
    fireEvent.click(screen.getByTestId('calc-add'))
    press('3')
    fireEvent.click(screen.getByTestId('calc-equals'))
    fireEvent.click(screen.getByTestId('calc-history-toggle'))

    const first = within(screen.getByTestId('calc-history')).getAllByRole('button')[0]
    fireEvent.click(first)
    expect(screen.getByTestId('calc-display')).toHaveTextContent('5')
    // Still exactly one history row — selection must not record a duplicate.
    expect(within(screen.getByTestId('calc-history')).getAllByRole('listitem')).toHaveLength(1)
  })

  it('does not record an invalid calculation', () => {
    renderCalc({ open: true })
    press('5')
    fireEvent.click(screen.getByTestId('calc-divide'))
    press('0')
    fireEvent.click(screen.getByTestId('calc-equals'))
    fireEvent.click(screen.getByTestId('calc-history-toggle'))
    // An invalid calculation records nothing, so the empty state shows and no
    // list items exist at all.
    expect(within(screen.getByTestId('calc-history')).queryAllByRole('listitem')).toHaveLength(0)
    expect(
      within(screen.getByTestId('calc-history')).getByText(i18n.t('pos.calculator.historyEmpty')),
    ).toBeInTheDocument()
  })
})

describe('PosCalculator — keyboard shortcuts', () => {
  /** Dispatch a key on the panel, which is where focus lands when it opens. */
  function keyOnPanel(key: string, init: KeyboardEventInit = {}) {
    const panel = screen.getByTestId('pos-calculator')
    fireEvent.keyDown(panel, { key, ...init })
  }

  it('digits, operators and Enter compute through the keyboard', () => {
    renderCalc({ open: true })
    keyOnPanel('5')
    keyOnPanel('+')
    keyOnPanel('3')
    keyOnPanel('Enter')
    expect(screen.getByTestId('calc-display')).toHaveTextContent('8')
  })

  it('the = key computes as well as Enter', () => {
    renderCalc({ open: true })
    keyOnPanel('6')
    keyOnPanel('*')
    keyOnPanel('7')
    keyOnPanel('=')
    expect(screen.getByTestId('calc-display')).toHaveTextContent('42')
  })

  it('Backspace deletes the last digit', () => {
    renderCalc({ open: true })
    keyOnPanel('1')
    keyOnPanel('2')
    keyOnPanel('3')
    keyOnPanel('Backspace')
    expect(screen.getByTestId('calc-display')).toHaveTextContent('12')
  })

  it('does NOT hijack keys typed into an unrelated POS input', () => {
    renderCalc({ open: true })
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    fireEvent.keyDown(input, { key: '5' })
    // The calculator display is untouched — the keystroke stayed with the input.
    expect(screen.getByTestId('calc-display')).toHaveTextContent('0')
    document.body.removeChild(input)
  })

  it('does NOT act on keys when the target is outside the panel', () => {
    renderCalc({ open: true })
    const other = document.createElement('button')
    document.body.appendChild(other)
    fireEvent.keyDown(other, { key: '5' })
    expect(screen.getByTestId('calc-display')).toHaveTextContent('0')
    document.body.removeChild(other)
  })
})

describe('PosCalculator — persistence of history', () => {
  it('restores a capped, valid history on remount', () => {
    // Seed a persisted history (one valid, one corrupt) the way the app writes it.
    window.localStorage.setItem(
      'station.calculator.history',
      JSON.stringify([
        { id: 'x', expression: '9 × 9', result: 81, at: 111 },
        { expression: '', result: 2, at: 5 }, // corrupt — must be dropped
      ]),
    )
    renderCalc({ open: true })
    fireEvent.click(screen.getByTestId('calc-history-toggle'))
    const items = within(screen.getByTestId('calc-history')).getAllByRole('listitem')
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveTextContent('9 × 9')
  })

  it('survives corrupt stored data without crashing', () => {
    window.localStorage.setItem('station.calculator.history', '{not valid json')
    expect(() => renderCalc({ open: true })).not.toThrow()
    fireEvent.click(screen.getByTestId('calc-history-toggle'))
    expect(within(screen.getByTestId('calc-history')).queryAllByRole('listitem')).toHaveLength(0)
  })
})
