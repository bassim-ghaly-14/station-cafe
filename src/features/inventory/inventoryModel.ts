/**
 * المخزون — the inventory feature's PURE presentation logic.
 *
 * # What belongs here and what does not
 *
 * Everything in this file is a DISPLAY decision taken over the rows the backend
 * already returned by `list_stock`. None of it is a stock rule:
 *
 *  - the stock rule itself is `quantity <= min_quantity`, and it was ALREADY the
 *    comparison the old inline row badge used. It is restated here exactly, so
 *    the two can be diffed against each other;
 *  - `list_stock` already returns every tracked item with no limit and no
 *    paging, so the counts, the summary and the filters are arithmetic over the
 *    complete set the backend sent. No figure here is a partial total;
 *  - nothing here invents a field, a threshold, a movement type or a status the
 *    schema does not have. There is deliberately no "out of stock" state: the
 *    model reports LOW or OK, which is the whole vocabulary Station stores.
 *
 * # Why it is a separate module
 *
 * The logic is small but it is the part a reader must be able to verify against
 * the old behaviour without opening JSX, so it is pure, typed and unit-tested on
 * its own. Every component in this feature reads these functions and computes
 * nothing of its own.
 *
 * # Catalog is not involved
 *
 * `StockRow` carries `department`, `category_name` and `item_type` because the
 * backend join produces them, not because this page needs them. They are
 * Catalog's authoritative fields and are deliberately not rendered, searched or
 * filtered here: this page answers "what is in stock and what needs attention",
 * not "what does the business sell".
 */
import type { MovementRow, StockRow } from '@/services/opsApi'

/**
 * The complete vocabulary of stock states on this page.
 *
 * `LOW` is the backend's own rule (`quantity <= min_quantity`), which includes
 * an item that has run out. A separate out-of-stock state would be a NEW
 * business distinction the schema does not make, so it is a future enhancement
 * rather than something this page invents.
 */
export type StockStatus = 'LOW' | 'OK'

/**
 * Whether a stock row needs the manager's attention.
 *
 * The comparison is `<=`, not `<`: an item sitting exactly ON its minimum has
 * already reached it. This is byte-for-byte the rule the previous inline row
 * badge used, and the repository's `ORDER BY (i.quantity <= i.min_quantity) DESC`
 * uses the same expression, so the badge, the ordering and this function can
 * never disagree.
 */
export function isLowStock(row: StockRow): boolean {
  return row.quantity <= row.min_quantity
}

/** The status badge a row shows, and the only status any row can show. */
export function stockStatusOf(row: StockRow): StockStatus {
  return isLowStock(row) ? 'LOW' : 'OK'
}

export interface StockSummary {
  /** Every tracked item the backend returned. */
  readonly total: number
  /** Items at or below their minimum. */
  readonly low: number
  /** Items above their minimum. */
  readonly ok: number
}

/**
 * The three operational counts, all of them over the COMPLETE loaded set.
 *
 * `total` is therefore always `low + ok`, and there is no third state to place.
 * Each count answers a question a manager actually asks — how much am I
 * tracking, how much is running down, how much is fine — and nothing here is a
 * money figure, because Station stores no cost of goods and any inventory value
 * would be invented.
 */
export function summarizeStock(rows: readonly StockRow[]): StockSummary {
  let low = 0
  for (const row of rows) {
    if (isLowStock(row)) low += 1
  }
  return { total: rows.length, low, ok: rows.length - low }
}

/** Which stock states the list is showing. `ALL` is the unfiltered set. */
export type StockStatusFilter = 'ALL' | StockStatus

export interface StockQuery {
  /** Free text matched against the product name. */
  readonly query: string
  readonly status: StockStatusFilter
}

export const NO_STOCK_QUERY: StockQuery = { query: '', status: 'ALL' }

/** Whether a query narrows anything at all, so the reset control is honest. */
export function hasStockQuery(query: StockQuery): boolean {
  return query.query.trim() !== '' || query.status !== 'ALL'
}

/**
 * The presentational filter over the rows already in memory.
 *
 * The search is LIVE and runs entirely here, in the browser, over the rows the
 * backend has already sent — `list_stock` returns the complete tracked set with
 * no paging, so there is nothing further to ask for and no request is made.
 *
 * Only the NAME is matched. Department, category and item type are deliberately
 * not searchable: they belong to Catalog, and making them filter this page
 * would turn Inventory into a second product browser.
 */
export function filterStock(rows: readonly StockRow[], query: StockQuery): StockRow[] {
  const needle = query.query.trim().toLowerCase()
  const status = query.status
  return rows.filter((row) => {
    if (status !== 'ALL' && stockStatusOf(row) !== status) return false
    if (needle === '') return true
    return row.product_name.toLowerCase().includes(needle)
  })
}

/**
 * The rows the attention area lists: the low rows, in the order the backend
 * already returned them.
 *
 * The order is not re-sorted here on purpose — `list_stock` orders low-first and
 * then by name, so the page inherits the backend's ordering instead of
 * maintaining a second one that could disagree.
 */
export function attentionRows(rows: readonly StockRow[]): StockRow[] {
  return rows.filter(isLowStock)
}

/**
 * The tone of a movement line.
 *
 * `IN` is a receipt of stock and `OUT` is any reduction, which is exactly the
 * distinction the old movement row drew with `change > 0`. The sign is also
 * printed next to the figure, so the tone is a reading aid and never the signal.
 */
export type MovementTone = 'IN' | 'OUT'

export function movementTone(row: MovementRow): MovementTone {
  return row.change > 0 ? 'IN' : 'OUT'
}

/**
 * The movement figure as displayed: an explicit sign for a receipt, and the
 * backend's own value (which already carries its minus) for a reduction.
 *
 * Keeping the sign in the text is what lets the movement log be read without
 * relying on colour at all.
 */
export function formatMovementChange(row: MovementRow): string {
  return row.change > 0 ? `+${row.change}` : String(row.change)
}
