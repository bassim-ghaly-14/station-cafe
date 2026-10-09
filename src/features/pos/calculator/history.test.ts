/**
 * POS calculator — history invariants.
 *
 * The history is the 30 most recent VALID, EXPLICITLY COMPLETED calculations,
 * newest first, hard capped. This module owns those invariants as pure values,
 * so they are asserted here without a DOM: recording, ordering, the exact
 * rolling cap, eviction of the oldest, dedupe of a bare repeated `=`, and the
 * defensive normalisation of arbitrary persisted data.
 */
import { describe, expect, it } from 'vitest'
import {
  HISTORY_LIMIT,
  appendHistory,
  isValidEntry,
  normalizeHistory,
  recordHistory,
  type HistoryEntry,
} from './history'
import type { CalcResult } from './engine'

/** A completed calculation fixture. */
function calc(expression: string, result: number): CalcResult {
  return { expression, result }
}

describe('history — recording rules', () => {
  it('records a successfully completed calculation', () => {
    const h = recordHistory([], calc('2 + 3', 5))
    expect(h).toHaveLength(1)
    expect(h[0].expression).toBe('2 + 3')
    expect(h[0].result).toBe(5)
    expect(h[0].id).toBeTruthy()
    expect(h[0].at).toBeGreaterThan(0)
  })

  it('only records when the caller passes a completed result', () => {
    // This module never decides what is "completed"; the engine does. A caller
    // that never passes an intermediate value simply never records one.
    const h = appendHistory([], calc('2 +', 2))
    expect(h).toHaveLength(1)
  })

  it('does not record a duplicate of the newest identical calculation', () => {
    const first = recordHistory([], calc('2 + 3', 5))
    // A bare repeated "=" that re-applies to the SAME operands yields the same
    // expression+result; it must not mint a second row.
    const second = recordHistory(first, calc('2 + 3', 5))
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe(first[0].id)
  })

  it('records a genuinely new calculation that shares nothing with the newest', () => {
    const first = recordHistory([], calc('2 + 3', 5))
    const second = recordHistory(first, calc('10 × 4', 40))
    expect(second).toHaveLength(2)
    expect(second[0].expression).toBe('10 × 4')
    expect(second[1].expression).toBe('2 + 3')
  })

  it('records the same expression again once its result differs', () => {
    let h = recordHistory([], calc('2 + 3', 5))
    h = recordHistory(h, calc('2 + 3', 6))
    expect(h).toHaveLength(2)
  })
})

describe('history — ordering and ids', () => {
  it('is newest-first', () => {
    let h = appendHistory([], calc('1', 1))
    h = appendHistory(h, calc('2', 2))
    h = appendHistory(h, calc('3', 3))
    expect(h.map((e) => e.expression)).toEqual(['3', '2', '1'])
  })

  it('gives every entry a unique id', () => {
    let h = appendHistory([], calc('1', 1))
    h = appendHistory(h, calc('2', 2))
    h = appendHistory(h, calc('3', 3))
    expect(new Set(h.map((e) => e.id)).size).toBe(3)
  })
})

describe('history — the strict 30-entry rolling cap', () => {
  it('never exceeds 30 entries', () => {
    let h: HistoryEntry[] = []
    for (let i = 0; i < 100; i += 1) {
      h = appendHistory(h, calc(`${i}`, i))
    }
    expect(h).toHaveLength(HISTORY_LIMIT)
    expect(HISTORY_LIMIT).toBe(30)
  })

  it('retains exactly the latest 30, discarding the oldest', () => {
    let h: HistoryEntry[] = []
    for (let i = 0; i < 100; i += 1) {
      h = appendHistory(h, calc(`${i}`, i))
    }
    // Newest first, so the newest is 99 and the oldest retained is 70.
    expect(h[0].expression).toBe('99')
    expect(h[HISTORY_LIMIT - 1].expression).toBe('70')
    expect(h.some((e) => e.expression === '69')).toBe(false)
  })

  it('the 31st entry evicts the oldest', () => {
    let h: HistoryEntry[] = []
    for (let i = 1; i <= 30; i += 1) h = appendHistory(h, calc(`${i}`, i))
    expect(h).toHaveLength(30)
    expect(h[h.length - 1].expression).toBe('1')
    h = appendHistory(h, calc('31', 31))
    expect(h).toHaveLength(30)
    expect(h[0].expression).toBe('31')
    expect(h[h.length - 1].expression).toBe('2') // '1' evicted
    expect(h.some((e) => e.expression === '1')).toBe(false)
  })
})

describe('history — validation of a single entry', () => {
  it('accepts a well-formed entry', () => {
    expect(isValidEntry({ id: 'a', expression: '1 + 1', result: 2, at: 123 })).toBe(true)
  })

  it('rejects a non-object or null', () => {
    expect(isValidEntry(null)).toBe(false)
    expect(isValidEntry(42)).toBe(false)
    expect(isValidEntry('x')).toBe(false)
  })

  it('rejects an empty expression', () => {
    expect(isValidEntry({ expression: '', result: 2, at: 1 })).toBe(false)
  })

  it('rejects a non-finite or non-numeric result', () => {
    expect(isValidEntry({ expression: 'x', result: Number.NaN, at: 1 })).toBe(false)
    expect(isValidEntry({ expression: 'x', result: Number.POSITIVE_INFINITY, at: 1 })).toBe(false)
    expect(isValidEntry({ expression: 'x', result: '5', at: 1 })).toBe(false)
  })

  it('rejects a non-finite or negative timestamp', () => {
    expect(isValidEntry({ expression: 'x', result: 1, at: -5 })).toBe(false)
    expect(isValidEntry({ expression: 'x', result: 1, at: Number.NaN })).toBe(false)
  })
})
describe('history — normalisation of restored data', () => {
  it('returns an empty history for a non-array', () => {
    expect(normalizeHistory(null)).toEqual([])
    expect(normalizeHistory(undefined)).toEqual([])
    expect(normalizeHistory('nope')).toEqual([])
    expect(normalizeHistory(42)).toEqual([])
    expect(normalizeHistory({})).toEqual([])
  })

  it('drops malformed rows and keeps the valid ones', () => {
    const raw = [
      { id: 'a', expression: '1 + 1', result: 2, at: 10 },
      { expression: '', result: 2, at: 10 }, // empty expression
      { expression: 'bad', result: Number.NaN, at: 10 }, // non-finite result
      null,
      'garbage',
      { id: 'b', expression: '2 × 2', result: 4, at: 20 },
    ]
    const h = normalizeHistory(raw)
    expect(h).toHaveLength(2)
    expect(h.map((e) => e.expression)).toEqual(['1 + 1', '2 × 2'])
  })

  it('caps a restored over-long history at 30', () => {
    const raw = Array.from({ length: 50 }, (_, i) => ({
      id: `id-${i}`,
      expression: `${i}`,
      result: i,
      at: i,
    }))
    const h = normalizeHistory(raw)
    expect(h).toHaveLength(30)
    expect(h[0].expression).toBe('0')
  })

  it('re-synthesises a missing id so list keys stay stable', () => {
    const h = normalizeHistory([{ expression: '1 + 1', result: 2, at: 5 }])
    expect(h).toHaveLength(1)
    expect(typeof h[0].id).toBe('string')
    expect(h[0].id.length).toBeGreaterThan(0)
  })

  it('never throws on deeply corrupted input', () => {
    expect(() => normalizeHistory([{ a: { b: {} } }, [1, 2, 3]])).not.toThrow()
    expect(normalizeHistory([{ a: {} }])).toEqual([])
  })
})
