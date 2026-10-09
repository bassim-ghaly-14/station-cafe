/**
 * POS calculator — arithmetic engine (pure, deterministic, framework-free).
 *
 * This is a STANDALONE arithmetic utility for the cashier. It is deliberately
 * kept entirely separate from orders, invoices, product quantities, customer
 * balances, cash drawers, expenses, shifts and day-close records: nothing here
 * touches money or persists anything financial. It never uses `eval` or
 * `new Function` — every operation is an explicit, audited branch.
 *
 * Model — CONVENTIONAL IMMEDIATE EXECUTION (like a physical pocket calculator):
 *   - one pending operator is carried between entries,
 *   - pressing an operator folds the current entry into the running total,
 *   - pressing `=` completes the pending operation,
 *   - a second `=` re-applies the last operation to the result,
 *   - typing a digit right after `=` starts a fresh calculation.
 * Operator precedence (BODMAS) is therefore intentionally NOT honoured; this is
 * the established physical-calculator contract and it is applied consistently.
 *
 * Determinism vs. binary float
 * ----------------------------
 * JavaScript's `0.1 + 0.2 === 0.30000000000000004`. Every produced result is run
 * through `cleanFloat`, which rounds to at most {@link MAX_DECIMALS} significant
 * decimal places — well beyond any human calculation the till would ever need —
 * so the artefact disappears without materially changing an ordinary result.
 */

/** Decimal places kept after an operation, before trailing-zero trimming. */
export const MAX_DECIMALS = 10

/** Hard cap on how many digits a single displayed number may reach. */
export const MAX_DIGITS = 15

export type Operator = '+' | '-' | '×' | '÷'

/** A finished calculation: the human expression and its exact result. */
export interface CalcResult {
  readonly expression: string
  readonly result: number
}

/**
 * The full calculator state machine.
 *
 * `entry` is the number currently being typed (always shown). `accumulator`
 * plus `pendingOp` is the fold carried across the current chain. `lastOp` /
 * `lastOperand` remember the completed operation so a repeated `=` can repeat
 * it. `justEvaluated` marks that the visible result is final, so the next digit
 * starts over rather than appending to it.
 */
export interface CalcState {
  /** The number currently shown / being typed. */
  entry: string
  /** Running left-hand value across a chain, or `null` when none yet. */
  accumulator: number | null
  /** Operator waiting for its right operand, or `null`. */
  pendingOp: Operator | null
  /** The operation a repeated `=` repeats, or `null`. */
  lastOp: Operator | null
  /** The right operand a repeated `=` repeats, or `null`. */
  lastOperand: number | null
  /** True when the current `entry` is a finished result, not typed input. */
  justEvaluated: boolean
  /**
   * True right after an operator is registered, before any digit of its right
   * operand has been typed. It is the flag that makes a physical calculator
   * behave like one: the next digit STARTS the right operand (it does not append
   * to the echoed left operand), and a further operator merely REPLACES the
   * pending one instead of folding a value the user never entered. Distinct
   * from {@link justEvaluated}, which marks a completed RESULT.
   */
  awaitingOperand: boolean
}

/**
 * A calculation that cannot be represented as a finite number (division by
 * zero, or overflow). It is a value, not an exception: the UI shows a readable
 * error and NEVER renders `Infinity`, `NaN` or `-Infinity`.
 */
export type CalcError = 'divide-by-zero' | 'overflow'

export type CalcOutcome =
  | { readonly ok: true; readonly state: CalcState; readonly completed?: CalcResult }
  | { readonly ok: false; readonly error: CalcError; readonly state: CalcState }

/** The pristine state a Clear (AC) returns to. */
export const INITIAL_STATE: CalcState = {
  entry: '0',
  accumulator: null,
  pendingOp: null,
  lastOp: null,
  lastOperand: null,
  justEvaluated: false,
  awaitingOperand: false,
}

/** Parse the displayed entry into a number (`''`/malformed → 0). */
function toNumber(entry: string): number {
  if (entry === '') return 0
  const n = Number(entry)
  return Number.isFinite(n) ? n : 0
}

/**
 * Strip binary-float noise and trailing zeros from a computed number's string.
 *
 * Rounds to {@link MAX_DECIMALS} significant decimals, then trims a pointless
 * `.0`/trailing zeros, so `0.1 + 0.2` yields `0.3` and `8 / 2` yields `4`.
 */
export function cleanFloat(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  // toFixed can throw on values beyond 1e100; fall back to the raw string.
  let fixed: string
  try {
    fixed = value.toFixed(MAX_DECIMALS)
  } catch {
    return String(value)
  }
  // Only trim trailing zeros when this is a plain (non-exponential) decimal.
  // `toFixed` returns exponential notation for magnitudes >= 1e21; trimming
  // there would corrupt the exponent (`e+80` -> `e+8`). Those magnitudes never
  // reach here as a RESULT (finite() already flags them as overflow), but the
  // guard keeps this function safe for any caller and any future value.
  if (fixed.includes('.') && !fixed.includes('e') && !fixed.includes('E')) {
    fixed = fixed.replace(/\.?0+$/, '')
  }
  // Guard against a `-0` string ever reaching the display.
  return fixed === '-0' ? '0' : fixed
}

/** The numeric value an entry string represents, cleaned of float noise. */
function normalizeEntry(entry: string): number {
  return Number(cleanFloat(toNumber(entry)))
}

/** Apply one operator to two already-parsed numbers, guarding zero/overflow. */
function applyOp(a: number, op: Operator, b: number): number | CalcError {
  switch (op) {
    case '+':
      return finite(a + b)
    case '-':
      return finite(a - b)
    case '×':
      return finite(a * b)
    case '÷':
      if (b === 0) return 'divide-by-zero'
      return finite(a / b)
  }
}

/** Map a non-finite or un-displayable arithmetic product to the `overflow` sentinel. */
function finite(value: number): number | CalcError {
  if (!Number.isFinite(value)) return 'overflow'
  // `Number.prototype.toFixed` switches to EXPONENTIAL notation at 1e21, which
  // both the display and the clipboard contract forbid (no `1e+21`, no exponent).
  // Anything at or beyond that magnitude is therefore treated as overflow and
  // surfaced as graceful feedback rather than rendered as a corrupted or
  // exponential string. 1e21 is far beyond any ordinary till calculation.
  if (Math.abs(value) >= 1e21) return 'overflow'
  return value
}

/** Whether a key is one of the four arithmetic operators. */
export function isOperator(key: string): key is Operator {
  return key === '+' || key === '-' || key === '×' || key === '÷'
}

/** The symbol used to render an operator in an expression string. */
export const OPERATOR_SYMBOL: Record<Operator, string> = {
  '+': '+',
  '-': '−',
  '×': '×',
  '÷': '÷',
}

/**
 * Type a digit (0–9) or a decimal point into the current entry.
 *
 * Enforces a single leading zero, a single decimal point, and {@link MAX_DIGITS}
 * significant digits. Typing after a completed calculation starts a brand-new
 * calculation (the whole chain is discarded); typing the first digit of a right
 * operand after an operator keeps the pending accumulator.
 */
export function inputDigit(state: CalcState, digit: string): CalcState {
  // A digit after a completed RESULT begins a fresh calculation, so the stale
  // accumulator and last-operation are dropped entirely — otherwise a later `=`
  // would wrongly repeat the previous chain.
  const start: CalcState = state.justEvaluated ? { ...INITIAL_STATE } : state
  // The first digit of a right operand (just after an operator) or after a
  // lone `-0` replaces the echoed left value instead of appending to it.
  const base = start.awaitingOperand || start.entry === '-0' ? '' : start.entry

  if (digit === '.') {
    // A leading decimal becomes "0."; an existing point is ignored.
    if (base === '') return { ...start, entry: '0.', justEvaluated: false, awaitingOperand: false }
    if (base.includes('.')) return { ...start, justEvaluated: false, awaitingOperand: false }
    return withLimit(start, base + '.')
  }

  // Collapse a lone leading "0" unless a decimal point is already present.
  const next = base === '0' || base === '' ? digit : base + digit
  return withLimit(start, next)
}

/** Reject input beyond the digit budget, leaving the state otherwise unchanged. */
function withLimit(state: CalcState, next: string): CalcState {
  const digits = next.replace(/[^0-9]/g, '').length
  if (digits > MAX_DIGITS) return { ...state, justEvaluated: false, awaitingOperand: false }
  return { ...state, entry: next, justEvaluated: false, awaitingOperand: false }
}

/** Negate the current entry's sign (works on typed values and results). */
export function toggleSign(state: CalcState): CalcState {
  if (state.entry === '0') return state
  const next = state.entry.startsWith('-') ? state.entry.slice(1) : `-${state.entry}`
  return { ...state, entry: next, justEvaluated: false, awaitingOperand: false }
}

/** Delete the last character of the entry; an emptied entry reads as `0`. */
export function backspace(state: CalcState): CalcState {
  // A finished result is cleared wholesale rather than digit-by-digit.
  if (state.justEvaluated)
    return { ...state, entry: '0', justEvaluated: false, awaitingOperand: false }
  if (state.entry.length <= 1 || (state.entry.length === 2 && state.entry.startsWith('-'))) {
    return { ...state, entry: '0', awaitingOperand: false }
  }
  let next = state.entry.slice(0, -1)
  // A dangling minus (e.g. "-" after slicing) never survives.
  if (next === '-') next = '0'
  return { ...state, entry: next, awaitingOperand: false }
}

/** Full reset to the pristine state. */
export function clearAll(): CalcState {
  return { ...INITIAL_STATE }
}

/**
 * Register an operator.
 *
 * Consecutive operators simply replace the pending one (no premature fold),
 * which is the predictable, conventional behaviour. The first operator on a
 * fresh entry just parks the accumulator.
 */
export function chooseOperator(state: CalcState, op: Operator): CalcState {
  // A second operator pressed with no right operand typed yet simply REPLACES
  // the pending one — the predictable, conventional behaviour. Nothing is
  // folded because no operand was entered.
  if (state.awaitingOperand) {
    return { ...state, pendingOp: op, justEvaluated: false, awaitingOperand: true }
  }

  const current = normalizeEntry(state.entry)

  // Nothing folded yet: park the current value as the left operand.
  if (state.accumulator === null || state.pendingOp === null) {
    return {
      ...state,
      accumulator: current,
      pendingOp: op,
      entry: cleanFloat(current),
      justEvaluated: false,
      awaitingOperand: true,
    }
  }

  // A previous operator is pending: fold it now, then park the next.
  const folded = applyOp(state.accumulator, state.pendingOp, current)
  if (folded === 'divide-by-zero' || folded === 'overflow') {
    return {
      ...state,
      entry: '0',
      accumulator: null,
      pendingOp: op,
      justEvaluated: false,
      awaitingOperand: true,
    }
  }
  return {
    ...state,
    accumulator: folded,
    entry: cleanFloat(folded),
    pendingOp: op,
    justEvaluated: false,
    awaitingOperand: true,
  }
}

/**
 * Percentage — operand-relative, the calculator-correct semantic.
 *
 *   - after `+`/`−`  → percent OF the accumulator (`200 + 10%` → `220`),
 *   - after `×`/`÷`  → the entry as a fraction of 1 (`200 × 50%` → `100`),
 *   - with no pending operator → the value divided by 100 (`50%` → `0.5`).
 * The result replaces the entry as a typed value; it does NOT complete a
 * calculation, so it records no history entry on its own.
 */
export function applyPercent(state: CalcState): CalcState {
  const current = normalizeEntry(state.entry)

  if (state.accumulator !== null && state.pendingOp !== null) {
    if (state.pendingOp === '+' || state.pendingOp === '-') {
      const portion = finite((state.accumulator * current) / 100)
      if (typeof portion !== 'number') return state
      return { ...state, entry: cleanFloat(portion), justEvaluated: false }
    }
    return { ...state, entry: cleanFloat(current / 100), justEvaluated: false }
  }

  return { ...state, entry: cleanFloat(current / 100), justEvaluated: false }
}

/**
 * Equals — complete the calculation.
 *
 * With a pending operator it folds the entry into the accumulator and returns a
 * {@link CalcResult} for history. With none, if a previous operation exists it
 * repeats it (`2 + 3 =` → `5`, `=` → `8`, …); otherwise it is a no-op that only
 * marks the entry final. Division by zero and overflow return `ok: false` and
 * reset the entry, so the caller shows an error and never persists an invalid
 * history entry.
 */
export function equals(state: CalcState): CalcOutcome {
  // No pending operation: either repeat the last one, or do nothing.
  if (state.pendingOp === null || state.accumulator === null) {
    if (state.lastOp !== null && state.lastOperand !== null) {
      const current = normalizeEntry(state.entry)
      const value = applyOp(current, state.lastOp, state.lastOperand)
      if (value === 'divide-by-zero' || value === 'overflow') {
        return { ok: false, error: value, state: resetAfterError(state) }
      }
      const result = cleanFloat(value)
      return {
        ok: true,
        completed: {
          expression: `${cleanFloat(current)} ${OPERATOR_SYMBOL[state.lastOp]} ${cleanFloat(state.lastOperand)}`,
          result: Number(result),
        },
        state: { ...state, entry: result, justEvaluated: true, awaitingOperand: false },
      }
    }
    return {
      ok: true,
      state: { ...state, entry: state.entry, justEvaluated: true, awaitingOperand: false },
    }
  }

  const current = normalizeEntry(state.entry)
  const value = applyOp(state.accumulator, state.pendingOp, current)
  if (value === 'divide-by-zero' || value === 'overflow') {
    return { ok: false, error: value, state: resetAfterError(state) }
  }

  const result = cleanFloat(value)
  const op = state.pendingOp
  return {
    ok: true,
    completed: {
      expression: `${cleanFloat(state.accumulator)} ${OPERATOR_SYMBOL[op]} ${cleanFloat(current)}`,
      result: Number(result),
    },
    state: {
      ...state,
      entry: result,
      accumulator: Number(result),
      pendingOp: null,
      lastOp: op,
      lastOperand: current,
      justEvaluated: true,
      awaitingOperand: false,
    },
  }
}

/** After an error, the entry resets to 0 but the calculator stays usable. */
function resetAfterError(state: CalcState): CalcState {
  return {
    ...INITIAL_STATE,
    lastOp: state.lastOp,
    lastOperand: state.lastOperand,
    entry: '0',
    justEvaluated: false,
    awaitingOperand: false,
  }
}

/** The secondary line above the result: the live chain, or the last result. */
export function expressionLine(state: CalcState): string {
  if (state.pendingOp !== null && state.accumulator !== null) {
    return `${cleanFloat(state.accumulator)} ${OPERATOR_SYMBOL[state.pendingOp]}`
  }
  if (state.justEvaluated) return '='
  return ''
}
