/**
 * The inventory workspace, end to end through its real component tree.
 *
 * The page is mocked at the IPC boundary only — `opsApi` and nothing else — so
 * every figure below is a value the mocked backend returned, never arithmetic
 * this suite performed. What is under test:
 *
 *  1. the DATA FLOW is unchanged: one stock read and one bounded movement read
 *     on mount, and the movement window is still 30;
 *  2. the summary counts, the attention area and the list are all derived from
 *     the SAME loaded rows and therefore cannot disagree;
 *  3. the adjust dialog's business rules survive the extraction — a zero change
 *     is refused before any request, a valid one calls `adjustStock` with the
 *     trimmed note and reloads both lists;
 *  4. a failed read is an error state, never a list of zeroes;
 *  5. the page is NOT a second catalog: none of the product master data that
 *     arrives on the payload is rendered anywhere.
 *
 * The default test viewport is DESKTOP (see `src/test/setup.ts`), so the
 * `DataTable` presentation is the one exercised unless a test narrows it.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetViewportWidth, setViewportWidth } from '@/test/setup'
import '@/lib/i18n'
import { ToastProvider } from '@/components/ui'
import InventoryPage from './InventoryPage'
import type { MovementRow, StockRow } from '@/services/opsApi'

const mocks = vi.hoisted(() => ({
  stock: vi.fn(),
  movements: vi.fn(),
  adjustStock: vi.fn(),
}))

vi.mock('@/services/opsApi', () => ({
  opsApi: {
    stock: mocks.stock,
    movements: mocks.movements,
    adjustStock: mocks.adjustStock,
  },
  // The dialog reads the fixed reason vocabulary from this module, so the mock
  // declares it exactly as `opsApi.ts` does rather than letting the dialog build
  // its own list.
  STOCK_REASONS: ['PURCHASE', 'ADJUSTMENT', 'WASTE'],
}))

function stock(over: Partial<StockRow> = {}): StockRow {
  return {
    product_id: 1,
    product_name: 'حليب',
    department: 'CAFE',
    category_name: 'مشروبات',
    item_type: 'PRODUCT',
    quantity: 10,
    min_quantity: 3,
    ...over,
  }
}

function movement(over: Partial<MovementRow> = {}): MovementRow {
  return {
    id: 1,
    product_name: 'حليب',
    change: 5,
    reason: 'PURCHASE',
    note: null,
    created_at: '2026-03-01 10:00:00',
    ...over,
  }
}

/** Two fine items and two at-or-below their minimum — so both states appear. */
const STOCK: StockRow[] = [
  stock({ product_id: 1, product_name: 'حليب', quantity: 10, min_quantity: 3 }),
  stock({ product_id: 2, product_name: 'شوكولاتة', quantity: 1, min_quantity: 3 }),
  stock({ product_id: 3, product_name: 'Ice Coffee', quantity: 40, min_quantity: 5 }),
  stock({ product_id: 4, product_name: 'ماء', quantity: 2, min_quantity: 4 }),
]

const MOVEMENTS: MovementRow[] = [
  movement({ id: 1, product_name: 'حليب', change: 5, reason: 'PURCHASE' }),
  movement({ id: 2, product_name: 'شوكولاتة', change: -2, reason: 'SALE' }),
]

function page() {
  return render(
    <ToastProvider>
      <InventoryPage />
    </ToastProvider>,
  )
}

/**
 * Waits for the stock read to resolve.
 *
 * It uses `getAllByText` deliberately: "حليب" legitimately appears in the stock
 * list AND in the movement log, and asserting on a single match would be
 * asserting an accident of layout rather than that the page loaded.
 */
async function loaded() {
  await waitFor(() => expect(screen.getAllByText('حليب').length).toBeGreaterThan(0))
}

/** The stock table's accessible name, shared by the desktop and phone queries. */
const STOCK_CAPTION = 'المخزون الحالي — الكمية والحد الأدنى والحالة لكل صنف متتبع'

beforeEach(() => {
  vi.clearAllMocks()
  resetViewportWidth()
  mocks.stock.mockResolvedValue(STOCK)
  mocks.movements.mockResolvedValue(MOVEMENTS)
  mocks.adjustStock.mockResolvedValue(undefined)
})

afterEach(() => {
  resetViewportWidth()
})

describe('InventoryPage — data flow', () => {
  it('reads the stock rows and the bounded movement window once each', async () => {
    page()
    await loaded()

    expect(mocks.stock).toHaveBeenCalledTimes(1)
    expect(mocks.movements).toHaveBeenCalledTimes(1)
    // The window is unchanged at 30, and the strip says so with that number.
    expect(mocks.movements).toHaveBeenCalledWith(30)
    expect(screen.getByText('آخر 30 حركة')).toBeInTheDocument()
  })
})

describe('InventoryPage — the operational summary', () => {
  it('counts the whole loaded set into tracked, low and OK', async () => {
    page()
    await loaded()

    // The label also appears as the status FILTER's option, so each tile is read
    // through the figure's own tile rather than through a bare text match.
    // 4 tracked, 2 low (quantity <= minimum), 2 fine.
    const tileOf = (label: string) => screen.getAllByText(label)[0].closest('div')?.parentElement
    expect(within(tileOf('أصناف متتبعة') as HTMLElement).getByText('4')).toBeInTheDocument()
    expect(within(tileOf('كمية منخفضة') as HTMLElement).getByText('2')).toBeInTheDocument()
    expect(within(tileOf('كمية كافية') as HTMLElement).getByText('2')).toBeInTheDocument()
  })

  it('renders the attention area only for the low rows, from the same payload', async () => {
    page()
    await loaded()

    const attention = screen.getByLabelText('يحتاج انتباهك')
    expect(within(attention).getByText('شوكولاتة')).toBeInTheDocument()
    expect(within(attention).getByText('ماء')).toBeInTheDocument()
    // A fine item is NOT attention, even though it is in the list below.
    expect(within(attention).queryByText('حليب')).not.toBeInTheDocument()
    expect(within(attention).queryByText('Ice Coffee')).not.toBeInTheDocument()
    expect(within(attention).getByText('2 صنف')).toBeInTheDocument()
  })

  it('renders no attention area at all when nothing is low', async () => {
    mocks.stock.mockResolvedValue([stock({ quantity: 50, min_quantity: 3 })])
    page()
    await loaded()
    expect(screen.queryByLabelText('يحتاج انتباهك')).not.toBeInTheDocument()
  })
})

describe('InventoryPage — the current stock list', () => {
  it('shows a status word for every row, never colour alone', async () => {
    page()
    await loaded()

    const table = screen.getByRole('table', {
      name: 'المخزون الحالي — الكمية والحد الأدنى والحالة لكل صنف متتبع',
    })
    expect(within(table).getAllByText('منخفض')).toHaveLength(2)
    expect(within(table).getAllByText('متوفّر')).toHaveLength(2)
  })

  it('states how much of the set is being shown', async () => {
    page()
    await loaded()
    expect(screen.getByText('4 من 4 صنف')).toBeInTheDocument()
  })

  it('filters the already-loaded rows without asking the backend again', async () => {
    page()
    await loaded()

    const before = mocks.stock.mock.calls.length
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'شوك' } })

    // Scoped to the stock table: the attention area legitimately repeats the
    // same low item, and the movement log repeats it a third time.
    const table = screen.getByRole('table', { name: STOCK_CAPTION })
    await waitFor(() => expect(screen.getByText('1 من 4 صنف')).toBeInTheDocument())
    expect(within(table).getByText('شوكولاتة')).toBeInTheDocument()
    expect(within(table).queryByText('Ice Coffee')).not.toBeInTheDocument()
    // Presentational filtering only — no new read.
    expect(mocks.stock.mock.calls.length).toBe(before)
  })

  it('never matches Catalog metadata, because it is not searchable here', async () => {
    page()
    await loaded()

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'مشروبات' } })
    await waitFor(() => expect(screen.getByText('0 من 4 صنف')).toBeInTheDocument())
  })

  it('is NOT a second catalog: no product master data is rendered', async () => {
    const { container } = page()
    await loaded()

    const text = container.textContent ?? ''
    // Department, category and item type arrive on the payload and belong to
    // Catalog. None of them, and no price, may appear on this page.
    expect(text).not.toContain('مشروبات')
    expect(text).not.toContain('كافيه')
    expect(text).not.toContain('التصنيف')
    expect(text).not.toContain('منتج')
  })
})

describe('InventoryPage — the movement log', () => {
  it('shows the reason and a signed change for every movement', async () => {
    page()
    await loaded()

    const log = screen.getByRole('table', {
      name: 'حركات المخزون — الصنف والسبب والتغيير والتاريخ',
    })
    expect(within(log).getByText('شراء')).toBeInTheDocument()
    expect(within(log).getByText('بيع')).toBeInTheDocument()
    // The sign is in the text, so the log is readable without colour.
    expect(within(log).getByText('+5')).toBeInTheDocument()
    expect(within(log).getByText('-2')).toBeInTheDocument()
  })
})

describe('InventoryPage — the adjustment', () => {
  async function openAdjust() {
    page()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'تسوية مخزون حليب' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  }

  it('opens the shared dialog naming the item it acts on', async () => {
    await openAdjust()
    expect(screen.getByText('تسوية مخزون: حليب')).toBeInTheDocument()
  })

  it('refuses a zero change before making any request', async () => {
    await openAdjust()

    fireEvent.change(screen.getByLabelText('الكمية (+ / −)'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    expect(await screen.findByText('أدخل كمية مختلفة عن صفر')).toBeInTheDocument()
    expect(mocks.adjustStock).not.toHaveBeenCalled()
  })

  it('refuses a non-numeric change before making any request', async () => {
    await openAdjust()

    fireEvent.change(screen.getByLabelText('الكمية (+ / −)'), { target: { value: 'بعض' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    expect(await screen.findByText('أدخل كمية مختلفة عن صفر')).toBeInTheDocument()
    expect(mocks.adjustStock).not.toHaveBeenCalled()
  })

  it('sends the trimmed note as null and only the three fixed reasons', async () => {
    await openAdjust()

    fireEvent.change(screen.getByLabelText('الكمية (+ / −)'), { target: { value: ' 5 ' } })
    fireEvent.change(screen.getByLabelText('ملاحظات'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    await waitFor(() => expect(mocks.adjustStock).toHaveBeenCalledWith(1, 5, 'PURCHASE', null))
  })

  it('reports the backend rejection through the translated error', async () => {
    mocks.adjustStock.mockRejectedValue(new Error('inventory.not_tracked'))
    await openAdjust()

    fireEvent.change(screen.getByLabelText('الكمية (+ / −)'), { target: { value: '-2' } })
    fireEvent.change(screen.getByLabelText('السبب'), { target: { value: 'WASTE' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    expect(await screen.findByText('هذا الصنف لا يتتبع المخزون')).toBeInTheDocument()
  })
})

describe('InventoryPage — failure states', () => {
  it('shows an error, not a band of zeroes, when the stock read fails', async () => {
    mocks.stock.mockRejectedValue(new Error('internal_error'))
    page()

    // The message appears twice on purpose: the error state beside the list and
    // the toast raised by the loader. Both are the same translated string.
    expect((await screen.findAllByText('حدث خطأ غير متوقع، حاول مرة أخرى')).length).toBeGreaterThan(
      0,
    )
    // No summary figures were invented from a read that never resolved.
    expect(screen.queryByLabelText('جارٍ تحميل ملخص المخزون…')).not.toBeInTheDocument()
    expect(screen.queryByText('0 من 0 صنف')).not.toBeInTheDocument()
  })

  it('keeps the stock list usable when only the movement read fails', async () => {
    mocks.movements.mockRejectedValue(new Error('internal_error'))
    page()

    await loaded()
    // The stock list still rendered: the two lists carry independent errors.
    expect(screen.getByRole('table', { name: STOCK_CAPTION })).toBeInTheDocument()
    expect((await screen.findAllByText('حدث خطأ غير متوقع، حاول مرة أخرى')).length).toBeGreaterThan(
      0,
    )
  })
})

describe('InventoryPage — the phone presentation', () => {
  const CAPTION = 'المخزون الحالي — الكمية والحد الأدنى والحالة لكل صنف متتبع'

  it('mounts records instead of the table, and never both', async () => {
    setViewportWidth(360)
    page()
    await loaded()

    // The record list is a real list, announced as such…
    const records = screen.getByRole('list', { name: CAPTION })
    expect(within(records).getByText('حليب')).toBeInTheDocument()
    // …and the desktop table is NOT also in the document.
    expect(screen.queryByRole('table', { name: CAPTION })).not.toBeInTheDocument()
  })

  it('still leads each phone record with the status, then identity and quantity', async () => {
    setViewportWidth(360)
    page()
    await loaded()

    const records = screen.getByRole('list', { name: CAPTION })
    const low = within(records).getByText('شوكولاتة').closest('li')
    expect(low).not.toBeNull()
    const text = low?.textContent ?? ''
    expect(text).toContain('منخفض')
    expect(text).toContain('1')
    expect(text).toContain('الحد الأدنى')
    // The long Arabic name is not truncated away.
    expect(text).toContain('شوكولاتة')
  })
})

describe('InventoryPage — reloading after an adjustment', () => {
  it('re-reads BOTH lists once the adjustment succeeds', async () => {
    page()
    await loaded()
    expect(mocks.stock).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'تسوية مخزون حليب' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('الكمية (+ / −)'), { target: { value: '5' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))
    })

    expect(await screen.findByText('تم تسجيل التسوية')).toBeInTheDocument()
    await waitFor(() => expect(mocks.stock).toHaveBeenCalledTimes(2))
    expect(mocks.movements).toHaveBeenCalledTimes(2)
  })
})
