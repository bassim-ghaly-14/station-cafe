import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  applyPercent,
  backspace,
  chooseOperator,
  clearAll,
  equals,
  expressionLine,
  INITIAL_STATE,
  inputDigit,
  toggleSign,
  cleanFloat,
  type CalcError,
  type CalcState,
  type Operator,
} from './calculator/engine'
import { normalizeHistory, recordHistory, type HistoryEntry } from './calculator/history'
import {
  Calculator,
  Delete,
  Divide,
  Equal,
  History as HistoryIcon,
  Minus,
  Percent,
  Pin,
  PinOff,
  Plus,
  X,
} from '@/components/ui/icon'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { cn } from '@/lib/utils'
import { formatTime } from '@/lib/date'
import { usePinned } from './calculator/usePinned'

/**
 * POS floating calculator — a standalone arithmetic utility for the cashier.
 *
 * # Why it is a NON-MODAL floating panel
 * Every other overlay in this app (`Dialog`, `Drawer`, `Sheet`) is a full-screen
 * `aria-modal` scrim that traps focus and blocks the page behind it. That is the
 * wrong primitive for a calculator a cashier keeps open WHILE taking an order,
 * so this panel mirrors the non-modal popover pattern already used by the date
 * pickers: `role="dialog" aria-modal="false"`, an elevated surface, dismissal by
 * an outside click / Escape, and focus handed back to the panel. It never
 * renders a scrim, so it cannot block POS clicks, scrolling or checkout.
 *
 * # Visibility vs pinning — two independent axes, as the Sidebar models them
 *   - `open` (visibility) is transient, owned by the page, NOT persisted.
 *   - `pinned` is a durable USER PREFERENCE; a pinned panel ignores outside-click
 *     and Escape dismissal and is never hidden by the POS toggle (the toggle can
 *     only OPEN, never unexpectedly hide, a pinned panel). The pin is persisted
 *     through the shared `usePinned` primitive, exactly as the Sidebar persists
 *     its own, so the two never diverge.
 *
 * # Keyboard scoping
 * Shortcuts fire ONLY when the panel container itself is the event target — the
 * calculator "has focus". Keypad buttons keep that focus (their `mousedown` is
 * neutralised) so bare typing keeps working, while a POS input, button or search
 * field is never hijacked. `isTypingTarget` is a second line of defence.
 *
 * # Financial isolation
 * Nothing here touches orders, invoices, quantities, balances, drawers, expenses,
 * shifts or day-close records. Results are arithmetic only — never EGP, never a
 * transaction — and no result is written back into any POS flow.
 */

/** The localStorage key under which the (capped) history is persisted. */
const HISTORY_KEY = 'station.calculator.history'

/**
 * The typed target the global keyboard handler skips before it acts. Anything
 * the user can type into — a text field, the barcode search, a quantity box, a
 * textarea, a contenteditable, a select — is skipped so the calculator never
 * steals a keystroke from an unrelated POS input.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** Map a raw keyboard key to the operator the engine understands. */
function operatorFromKey(key: string): Operator | null {
  if (key === '*') return '×'
  if (key === '/') return '÷'
  if (key === '+') return '+'
  if (key === '-') return '-'
  return null
}

/**
 * A plain, locale-independent decimal string for display and for the clipboard:
 * fixed precision, trailing zeros trimmed, no separators, no currency, no
 * exponent, and never `Infinity`/`NaN`. This is exactly what pastes cleanly into
 * a spreadsheet. `cleanFloat` from the engine supplies the arithmetic-clean
 * form; the finite guard here makes the clipboard path defensive on its own.
 * Returns `''` for any non-finite value so the caller can disable copying.
 */
function plainNumber(value: number): string {
  if (!Number.isFinite(value)) return ''
  return cleanFloat(value)
}

/** Restore the persisted history once, capped and safe against corrupt data. */
function loadHistory(): HistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY)
    if (raw === null) return []
    return normalizeHistory(JSON.parse(raw))
  } catch {
    return []
  }
}

export interface PosCalculatorProps {
  readonly open: boolean
  readonly onRequestClose: () => void
}
export function PosCalculator({ open, onRequestClose }: PosCalculatorProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)

  const [state, setState] = useState<CalcState>(INITIAL_STATE)
  const [error, setError] = useState<CalcError | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory)
  const [historyVisible, setHistoryVisible] = useState(false)
  const [pinned, setPinned] = usePinned('pos-calculator')

  // A ref to the latest close callback keeps the dismissal effect stable while
  // still calling the freshest handler — exactly the Dialog's `onCloseRef` pattern.
  const closeRef = useRef(onRequestClose)
  useEffect(() => {
    closeRef.current = onRequestClose
  }, [onRequestClose])

  const errorKey =
    error === 'divide-by-zero'
      ? 'pos.calculator.errorDivideByZero'
      : error === 'overflow'
        ? 'pos.calculator.errorOverflow'
        : null
  const displayEntry = errorKey === null ? state.entry : t(errorKey)
  const copyValue = error === null ? plainNumber(Number(state.entry)) : ''

  const clear = useCallback(() => {
    setState(clearAll())
    setError(null)
  }, [])

  const digit = useCallback((d: string) => {
    setState((s) => inputDigit(s, d))
    setError(null)
  }, [])

  const decimal = useCallback(() => {
    setState((s) => inputDigit(s, '.'))
    setError(null)
  }, [])

  const op = useCallback((operator: Operator) => {
    setState((s) => chooseOperator(s, operator))
    setError(null)
  }, [])

  const del = useCallback(() => {
    setState((s) => backspace(s))
    setError(null)
  }, [])

  const negate = useCallback(() => {
    setState((s) => toggleSign(s))
    setError(null)
  }, [])

  const percent = useCallback(() => {
    setState((s) => applyPercent(s))
    setError(null)
  }, [])

  const runEquals = useCallback(() => {
    const outcome = equals(state)
    setState(outcome.state)
    if (!outcome.ok) {
      setError(outcome.error)
      return
    }
    setError(null)
    const completed = outcome.completed
    if (completed !== undefined) {
      setHistory((h) => recordHistory(h, completed))
    }
  }, [state])

  /** Restore a history result into the display WITHOUT recording a new entry. */
  const restore = useCallback((entry: HistoryEntry) => {
    setState({ ...INITIAL_STATE, entry: plainNumber(entry.result) })
    setError(null)
  }, [])

  // Dismiss by an outside click or Escape — ONLY while open AND unpinned. A
  // pinned panel stays put. The capture-phase Escape mirrors the date pickers
  // and stops a parent POS dialog from closing at the same time.
  useEffect(() => {
    if (!open || pinned) return
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) closeRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closeRef.current()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, pinned])

  // Land focus on the panel once per opening so bare-key typing works at once.
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  // Global calculator shortcuts — scoped to the panel having focus (the event
  // target IS the panel), so they never interfere with POS inputs, buttons,
  // search fields, dialogs or checkout. Listener is removed when closed.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.target !== panelRef.current) return

      const operator = operatorFromKey(e.key)
      if (operator !== null) {
        e.preventDefault()
        setState((s) => chooseOperator(s, operator))
        setError(null)
        return
      }
      switch (e.key) {
        case 'Enter':
        case '=':
          e.preventDefault()
          runEquals()
          break
        case '.':
          e.preventDefault()
          setState((s) => inputDigit(s, '.'))
          setError(null)
          break
        case 'Backspace':
          e.preventDefault()
          setState((s) => backspace(s))
          setError(null)
          break
        case '%':
          e.preventDefault()
          setState((s) => applyPercent(s))
          setError(null)
          break
        default:
          if (e.key >= '0' && e.key <= '9') {
            e.preventDefault()
            setState((s) => inputDigit(s, e.key))
            setError(null)
          }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, runEquals])

  // Persist a capped copy of the history so it survives closing / navigating.
  useEffect(() => {
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(normalizeHistory(history)))
    } catch {
      /* storage unavailable — history still works for the session */
    }
  }, [history])

  if (!open) return null

  const expr = expressionLine(state)

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-label={t('pos.calculator.title')}
      data-testid="pos-calculator"
      data-pinned={pinned ? 'true' : 'false'}
      className="fixed bottom-4 inset-e-4 z-50 flex w-76 flex-col gap-3 rounded-xl border border-border-strong bg-surface-elevated p-3 shadow-2xl outline-none sm:w-[20rem]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-bold text-foreground-strong">
          <Calculator size={16} aria-hidden />
          {t('pos.calculator.title')}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setHistoryVisible((v) => !v)}
            aria-label={t('pos.calculator.history')}
            aria-expanded={historyVisible}
            data-testid="calc-history-toggle"
          >
            <HistoryIcon size={16} aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setPinned(!pinned)}
            aria-label={pinned ? t('pos.calculator.unpin') : t('pos.calculator.pin')}
            aria-pressed={pinned}
            data-testid="calc-pin"
          >
            {pinned ? <Pin size={16} aria-hidden /> : <PinOff size={16} aria-hidden />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => closeRef.current()}
            aria-label={t('app.close')}
            data-testid="calc-close"
          >
            <X size={16} aria-hidden />
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface-input px-3 py-2">
        <p
          dir="ltr"
          aria-hidden={expr === ''}
          className="h-5 truncate text-end text-caption text-foreground-subtle tabular-nums"
        >
          {expr === '' ? '\u00a0' : expr}
        </p>
        <div className="flex items-center justify-between gap-2">
          <output
            aria-live="polite"
            data-testid="calc-display"
            dir="ltr"
            className={cn(
              'min-w-0 flex-1 truncate text-end text-3xl font-bold tabular-nums',
              error === null ? 'text-foreground-strong' : 'text-destructive',
            )}
          >
            {displayEntry}
          </output>
          <CopyButton
            value={copyValue}
            label={t('pos.calculator.copyResult')}
            copiedLabel={t('app.copied')}
            size="icon-sm"
            variant="ghost"
            disabled={copyValue === ''}
            data-testid="calc-copy"
          />
        </div>
      </div>

      {historyVisible ? (
        <div
          data-testid="calc-history"
          className="max-h-40 overflow-y-auto rounded-lg border border-border-subtle bg-surface-muted p-2"
        >
          {history.length === 0 ? (
            <p className="py-2 text-center text-caption text-foreground-subtle">
              {t('pos.calculator.historyEmpty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {history.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => restore(h)}
                    className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-start text-caption hover:bg-surface-hover"
                  >
                    <span dir="ltr" className="truncate text-foreground-muted tabular-nums">
                      {h.expression}
                    </span>
                    <span
                      dir="ltr"
                      className="shrink-0 font-bold text-foreground-strong tabular-nums"
                    >
                      {plainNumber(h.result)}
                    </span>
                    <span className="shrink-0 text-foreground-faint">{formatTime(h.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="grid grid-cols-4 gap-1.5">
        <KeypadKey
          onClick={clear}
          label={t('pos.calculator.clear')}
          variant="function"
          data-testid="calc-clear"
        >
          AC
        </KeypadKey>
        <KeypadKey
          onClick={negate}
          label={t('pos.calculator.sign')}
          variant="function"
          data-testid="calc-sign"
        >
          ±
        </KeypadKey>
        <KeypadKey
          onClick={percent}
          label={t('pos.calculator.percent')}
          variant="function"
          data-testid="calc-percent"
        >
          <Percent size={18} aria-hidden />
        </KeypadKey>
        <KeypadKey
          onClick={() => op('÷')}
          label={t('pos.calculator.divide')}
          variant="operator"
          data-testid="calc-divide"
        >
          <Divide size={18} aria-hidden />
        </KeypadKey>

        {['7', '8', '9'].map((d) => (
          <KeypadKey key={d} onClick={() => digit(d)} label={d} data-testid={`calc-${d}`}>
            {d}
          </KeypadKey>
        ))}
        <KeypadKey
          onClick={() => op('×')}
          label={t('pos.calculator.multiply')}
          variant="operator"
          data-testid="calc-multiply"
        >
          ×
        </KeypadKey>

        {['4', '5', '6'].map((d) => (
          <KeypadKey key={d} onClick={() => digit(d)} label={d} data-testid={`calc-${d}`}>
            {d}
          </KeypadKey>
        ))}
        <KeypadKey
          onClick={() => op('-')}
          label={t('pos.calculator.subtract')}
          variant="operator"
          data-testid="calc-subtract"
        >
          <Minus size={18} aria-hidden />
        </KeypadKey>

        {['1', '2', '3'].map((d) => (
          <KeypadKey key={d} onClick={() => digit(d)} label={d} data-testid={`calc-${d}`}>
            {d}
          </KeypadKey>
        ))}
        <KeypadKey
          onClick={() => op('+')}
          label={t('pos.calculator.add')}
          variant="operator"
          data-testid="calc-add"
        >
          <Plus size={18} aria-hidden />
        </KeypadKey>

        <KeypadKey onClick={decimal} label={t('pos.calculator.decimal')} data-testid="calc-decimal">
          .
        </KeypadKey>
        <KeypadKey onClick={() => digit('0')} label="0" data-testid="calc-0">
          0
        </KeypadKey>
        <KeypadKey onClick={del} label={t('pos.calculator.backspace')} data-testid="calc-backspace">
          <Delete size={18} aria-hidden />
        </KeypadKey>
        <KeypadKey
          onClick={runEquals}
          label={t('pos.calculator.equals')}
          variant="equals"
          data-testid="calc-equals"
        >
          <Equal size={18} aria-hidden />
        </KeypadKey>
      </div>
    </div>
  )
}

type KeypadVariant = 'digit' | 'function' | 'operator' | 'equals'

const KEYPAD_VARIANTS: Record<KeypadVariant, string> = {
  digit: 'bg-surface text-foreground-strong hover:bg-surface-hover active:bg-surface-active',
  function:
    'bg-surface-muted text-foreground-muted hover:bg-surface-hover active:bg-surface-active',
  operator:
    'bg-secondary text-secondary-foreground hover:bg-secondary-hover active:bg-secondary-active',
  equals: 'bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active',
}

function KeypadKey({
  children,
  onClick,
  label,
  variant = 'digit',
  'data-testid': testid,
}: {
  readonly children: React.ReactNode
  readonly onClick: () => void
  readonly label: string
  readonly variant?: KeypadVariant
  readonly 'data-testid'?: string
}) {
  return (
    <button
      type="button"
      // Keep focus on the panel so bare-key typing keeps working after a click;
      // the click itself still fires, so the key still acts.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      aria-label={label}
      data-testid={testid}
      className={cn(
        'flex h-12 items-center justify-center rounded-lg text-lg font-bold',
        'transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        KEYPAD_VARIANTS[variant],
      )}
    >
      {children}
    </button>
  )
}
