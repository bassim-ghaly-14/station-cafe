/**
 * POS calculator — history (pure, deterministic, framework-free).
 *
 * The history holds the 30 most recent VALID, EXPLICITLY COMPLETED calculations.
 * It is a pure, in-memory value object: this module only adds, dedupes, caps,
 * validates and clears entries — it never talks to storage. Persistence (the
 * `localStorage` mirror, mirroring the Sidebar's own preference persistence) is
 * the React layer's job; this file owns the invariants so they can be unit
 * tested without a DOM.
 */

import type { CalcResult } from './engine'

/** The absolute maximum number of retained history entries. */
export const HISTORY_LIMIT = 30

/** One completed calculation as stored and shown. */
export interface HistoryEntry {
  /** Stable unique identifier for list keys and selection. */
  readonly id: string
  /** The human expression, e.g. `2 + 3`. */
  readonly expression: string
  /** The numeric result, e.g. `5`. */
  readonly result: number
  /** Completion time as epoch milliseconds. */
  readonly at: number
}

let idCounter = 0

/** A stable, unique, monotonic id that never collides within a session. */
function nextId(): string {
  idCounter += 1
  return `calc-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

/**
 * The single fold every recording goes through.
 *
 * `history = [newEntry, ...previousHistory].slice(0, 30)` — newest first, hard
 * capped. A new entry is ALWAYS prepended and any excess (always the oldest,
 * because the list is newest-first) is dropped immediately, so the list can
 * never exceed {@link HISTORY_LIMIT}.
 */
export function appendHistory(
  history: readonly HistoryEntry[],
  result: CalcResult,
): HistoryEntry[] {
  const entry: HistoryEntry = {
    id: nextId(),
    expression: result.expression,
    result: result.result,
    at: Date.now(),
  }
  return [entry, ...history].slice(0, HISTORY_LIMIT)
}

/**
 * Append only when it is a genuinely NEW calculation.
 *
 * Repeated `=` that merely re-applies the same operation to the same operands
 * must not mint duplicate history rows, so an entry whose expression is
 * identical to the newest existing one is dropped. Every other completed
 * calculation is recorded through {@link appendHistory}.
 */
export function recordHistory(
  history: readonly HistoryEntry[],
  result: CalcResult,
): HistoryEntry[] {
  const newest = history[0]
  if (newest && newest.expression === result.expression && newest.result === result.result) {
    return history as HistoryEntry[]
  }
  return appendHistory(history, result)
}

/**
 * Validate a single unknown value as a history entry.
 *
 * Only well-formed entries survive: a non-empty string expression, a finite
 * numeric result and a finite non-negative timestamp. Anything else is rejected
 * so a corrupted store can never inject an unusable row.
 */
export function isValidEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    typeof e.expression === 'string' &&
    e.expression.length > 0 &&
    typeof e.result === 'number' &&
    Number.isFinite(e.result) &&
    typeof e.at === 'number' &&
    Number.isFinite(e.at) &&
    e.at >= 0
  )
}

/**
 * Normalize arbitrary persisted data back into a valid, capped history.
 *
 * Defensive on every axis: a non-array, individual malformed rows, missing ids
 * (re-synthesized) and an over-long list (truncated to {@link HISTORY_LIMIT}).
 * Never throws — corrupted or incompatible stored data degrades to a shorter,
 * still-usable history rather than crashing the app.
 */
export function normalizeHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isValidEntry)
    .slice(0, HISTORY_LIMIT)
    .map((entry) => ({
      id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : nextId(),
      expression: entry.expression,
      result: entry.result,
      at: entry.at,
    }))
}
