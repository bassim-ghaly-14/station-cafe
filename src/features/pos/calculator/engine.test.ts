/**
 * POS calculator — arithmetic engine (core operations).
 *
 * These tests hold in place the DETERMINISTIC contract of the engine, chosen
 * as CONVENTIONAL IMMEDIATE EXECUTION (a physical pocket calculator): one
 * pending operator, an operator folds the entry into the running total, `=`
 * completes it, and a repeated `=` re-applies the last operation. Operator
 * precedence is intentionally NOT honoured — that is the established contract
 * and it is asserted here so it cannot silently change.
 *
 * The engine is pure and framework-free, so none of these need a DOM. Every
 * assertion is on a VALUE, not on rendered output.
 */
import { describe, expect, it } from 'vitest'
import {
  INITIAL_STATE,
  MAX_DIGITS,
  applyPercent,
  backspace,
  chooseOperator,
  clearAll,
  equals,
  inputDigit,
  toggleSign,
  type CalcOutcome,
  type CalcState,
} from './engine'

/** Type a string of digits/`.` into the entry, one key at a time. */
function type(start: CalcState, keys: string): CalcState {
  return [...keys].reduce((s, k) => inputDigit(s, k), start)
}

/** Drive a full `a OP b =` sequence and return the outcome. */
function compute(a: string, op: '+' | '-' | '×' | '÷', b: string): CalcOutcome {
  let s = type(INITIAL_STATE, a)
  s = chooseOperator(s, op)
  s = type(s, b)
  return equals(s)
}

/** The numeric result of a completed calculation, or `NaN` if it errored. */
function resultOf(outcome: CalcOutcome): number {
  return outcome.ok && outcome.completed ? outcome.completed.result : Number.NaN
}

describe('calculator engine — the four operations', () => {
  it('adds', () => {
    const o = compute('5', '+', '3')
    expect(resultOf(o)).toBe(8)
    expect(o.ok && o.completed?.expression).toBe('5 + 3')
  })

  it('subtracts', () => {
    expect(resultOf(compute('10', '-', '4'))).toBe(6)
  })

  it('multiplies', () => {
    expect(resultOf(compute('6', '×', '7'))).toBe(42)
  })

  it('divides', () => {
    expect(resultOf(compute('20', '÷', '4'))).toBe(5)
  })
})

describe('calculator engine — immediate execution (no precedence)', () => {
  it('folds left-to-right, so 2 + 3 × 4 is 20, not 14', () => {
    // The deliberate contract: this is a physical calculator, not BODMAS.
    let s = type(INITIAL_STATE, '2')
    s = chooseOperator(s, '+')
    s = type(s, '3')
    s = chooseOperator(s, '×') // folds 2 + 3 = 5 here
    s = type(s, '4')
    expect(resultOf(equals(s))).toBe(20)
  })

  it('a chained operator folds the pending operation first', () => {
    let s = type(INITIAL_STATE, '2')
    s = chooseOperator(s, '+')
    s = type(s, '3')
    s = chooseOperator(s, '×') // 5 shown, pending ×
    expect(s.entry).toBe('5')
  })
})

describe('calculator engine — decimals and float artefacts', () => {
  it('0.1 + 0.2 is 0.3, never 0.30000000000000004', () => {
    expect(resultOf(compute('0.1', '+', '0.2'))).toBe(0.3)
  })

  it('8 ÷ 2 shows 4, not 4.0', () => {
    const o = compute('8', '÷', '2')
    expect(resultOf(o)).toBe(4)
    expect(o.ok && o.state.entry).toBe('4')
  })

  it('keeps meaningful precision without trailing zeros', () => {
    const o = compute('1', '÷', '3')
    expect(o.ok && o.state.entry).toBe('0.3333333333')
  })

  it('supports negative decimal results', () => {
    expect(resultOf(compute('0.5', '-', '1.25'))).toBe(-0.75)
  })
})

describe('calculator engine — negative values', () => {
  it('toggles the sign of a typed value', () => {
    let s = toggleSign(type(INITIAL_STATE, '5'))
    expect(s.entry).toBe('-5')
    expect(toggleSign(s).entry).toBe('5')
  })

  it('does not turn a lone 0 into -0', () => {
    expect(toggleSign(INITIAL_STATE).entry).toBe('0')
  })

  it('computes with a negative operand', () => {
    let s = toggleSign(type(INITIAL_STATE, '5')) // -5
    s = chooseOperator(s, '+')
    s = type(s, '3')
    expect(resultOf(equals(s))).toBe(-2)
  })
})

describe('calculator engine — percentage semantics', () => {
  it('after + / −, percent is OF the accumulator (200 + 10% = 220)', () => {
    let s = type(INITIAL_STATE, '200')
    s = chooseOperator(s, '+')
    s = type(s, '10')
    s = applyPercent(s)
    expect(s.entry).toBe('20')
    expect(resultOf(equals(s))).toBe(220)
  })

  it('after × / ÷, percent is a fraction of 1 (200 × 50% = 100)', () => {
    let s = type(INITIAL_STATE, '200')
    s = chooseOperator(s, '×')
    s = type(s, '50')
    s = applyPercent(s)
    expect(s.entry).toBe('0.5')
    expect(resultOf(equals(s))).toBe(100)
  })

  it('with no pending operator, percent divides by 100 (50% = 0.5)', () => {
    let s = applyPercent(type(INITIAL_STATE, '50'))
    expect(s.entry).toBe('0.5')
  })

  it('does not complete a calculation, so it records nothing on its own', () => {
    const s = applyPercent(type(INITIAL_STATE, '50'))
    expect(s.justEvaluated).toBe(false)
  })
})
describe('calculator engine — division by zero and overflow', () => {
  it('reports divide-by-zero instead of Infinity', () => {
    const o = compute('5', '÷', '0')
    expect(o.ok).toBe(false)
    if (!o.ok) expect(o.error).toBe('divide-by-zero')
    // The entry is reset to a safe 0 — never "Infinity" or "NaN".
    expect(o.state.entry).toBe('0')
  })

  it('never yields Infinity from a huge chain (overflow sentinel)', () => {
    // Repeatedly multiply a large number by itself; finite() maps any
    // non-finite product to the overflow sentinel long before it could render.
    let s = type(INITIAL_STATE, '999999999')
    s = chooseOperator(s, '×')
    s = type(s, '999999999')
    let o = equals(s)
    let guard = 0
    while (o.ok && guard < 200) {
      s = chooseOperator(o.state, '×')
      s = type(s, '999999999')
      o = equals(s)
      guard += 1
    }
    expect(o.ok).toBe(false)
    if (!o.ok) expect(o.error).toBe('overflow')
    expect(o.state.entry).toBe('0')
  })
})

describe('calculator engine — incomplete and empty expressions', () => {
  it('equals on a pristine calculator does not throw and records nothing', () => {
    const o = equals(INITIAL_STATE)
    expect(o.ok).toBe(true)
    if (o.ok) expect(o.completed).toBeUndefined()
  })

  it('a lone number then equals is a no-op that only marks it final', () => {
    const o = equals(type(INITIAL_STATE, '42'))
    expect(o.ok).toBe(true)
    if (o.ok) expect(o.completed).toBeUndefined()
    expect(o.state.entry).toBe('42')
    expect(o.state.justEvaluated).toBe(true)
  })

  it('an operator with no right operand does not fold prematurely', () => {
    const s = chooseOperator(type(INITIAL_STATE, '8'), '+')
    expect(s.accumulator).toBe(8)
    expect(s.entry).toBe('8')
  })
})

describe('calculator engine — consecutive operators', () => {
  it('a second operator replaces the first (5 + × 3 = 15)', () => {
    let s = chooseOperator(type(INITIAL_STATE, '5'), '+')
    s = chooseOperator(s, '×') // replaces +, no fold
    s = type(s, '3')
    const o = equals(s)
    expect(resultOf(o)).toBe(15)
    expect(o.ok && o.completed?.expression).toBe('5 × 3')
  })

  it('three operators in a row keep only the last', () => {
    let s = chooseOperator(type(INITIAL_STATE, '9'), '+')
    s = chooseOperator(s, '×')
    s = chooseOperator(s, '-')
    s = type(s, '4')
    expect(resultOf(equals(s))).toBe(5)
  })
})

describe('calculator engine — repeated decimal input', () => {
  it('ignores a second decimal point in one entry', () => {
    let s = type(INITIAL_STATE, '1.2')
    s = inputDigit(s, '.')
    s = inputDigit(s, '3')
    expect(s.entry).toBe('1.23')
  })

  it('a leading decimal becomes 0.', () => {
    let s = inputDigit(INITIAL_STATE, '.')
    s = inputDigit(s, '5')
    expect(s.entry).toBe('0.5')
  })
})

describe('calculator engine — backspace and clear', () => {
  it('deletes the last digit', () => {
    expect(backspace(type(INITIAL_STATE, '123')).entry).toBe('12')
  })

  it('empties to 0 rather than to a dangling minus', () => {
    expect(backspace(type(INITIAL_STATE, '5')).entry).toBe('0')
    expect(backspace(toggleSign(type(INITIAL_STATE, '5'))).entry).toBe('0')
  })

  it('after a result, backspace clears the whole value at once', () => {
    const s = equals(type(INITIAL_STATE, '123')).state
    expect(backspace(s).entry).toBe('0')
  })

  it('clear returns the pristine state', () => {
    const s = clearAll()
    expect(s.entry).toBe('0')
    expect(s.accumulator).toBeNull()
    expect(s.pendingOp).toBeNull()
  })
})

describe('calculator engine — repeated equals', () => {
  it('re-applies the last operation (5 + 3 = = gives 8 then 11)', () => {
    let s = chooseOperator(type(INITIAL_STATE, '5'), '+')
    s = type(s, '3')
    const first = equals(s)
    expect(resultOf(first)).toBe(8)
    const second = equals(first.state)
    expect(resultOf(second)).toBe(11)
    expect(resultOf(equals(second.state))).toBe(14)
  })

  it('a bare equals with no prior operation is idempotent', () => {
    const a = equals(type(INITIAL_STATE, '7'))
    const b = equals(a.state)
    expect(b.ok && b.state.entry).toBe('7')
  })
})

describe('calculator engine — starting fresh after a result', () => {
  it('a digit right after equals starts a new calculation', () => {
    let s = chooseOperator(type(INITIAL_STATE, '5'), '+')
    s = type(s, '3')
    s = equals(s).state // 8, justEvaluated
    s = inputDigit(s, '9')
    expect(s.entry).toBe('9')
    expect(s.accumulator).toBeNull()
    expect(s.pendingOp).toBeNull()
  })

  it('a digit right after an operator starts the right operand', () => {
    let s = chooseOperator(type(INITIAL_STATE, '5'), '+')
    s = inputDigit(s, '3')
    expect(s.entry).toBe('3') // not "53"
  })
})

describe('calculator engine — input length limits', () => {
  it('caps an entry at MAX_DIGITS significant digits with graceful feedback', () => {
    // Gorging digits past the budget must be IGNORED, not overflow the entry
    // or corrupt the state — the retained digits are exactly the budget.
    let s = INITIAL_STATE
    for (let i = 0; i < MAX_DIGITS + 5; i += 1) {
      s = inputDigit(s, '7')
    }
    expect(s.entry.replace(/[^0-9]/g, '')).toHaveLength(MAX_DIGITS)
    // The state is otherwise sane: no evaluation flag, no chain corruption.
    expect(s.justEvaluated).toBe(false)
    expect(s.accumulator).toBeNull()
    expect(s.pendingOp).toBeNull()
  })

  it('decimal points do not count against the digit budget', () => {
    let s = inputDigit(type(INITIAL_STATE, '42'), '.')
    for (let i = 0; i < MAX_DIGITS; i += 1) {
      s = inputDigit(s, '7')
    }
    expect(s.entry.replace(/[^0-9]/g, '').length).toBeLessThanOrEqual(MAX_DIGITS)
  })
})
