/**
 * The exporters are the EXISTING report pipeline, so this proves the monthly
 * series rides it: Arabic titles and month labels reach the PNG, the tokens are
 * resolved from the live theme, and the workbook is the same Station sheet the
 * donut export produces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MonthlyComparisonDatum, MonthlySeriesConfig } from './monthlyComparison'
import { exportBarChartExcel, exportBarChartPng, type BarChartExport } from './barChartExport'

const SERIES: MonthlySeriesConfig[] = [
  { key: 'cafe', label: 'كافيه', color: 'var(--info)' },
  { key: 'wash', label: 'مغسلة', color: 'var(--primary)' },
]

const DATA: MonthlyComparisonDatum[] = [
  { month: '2026-01', label: 'يناير', fullLabel: 'يناير 2026', cafe: 100, wash: 50 },
  { month: '2026-02', label: 'فبراير', fullLabel: 'فبراير 2026', cafe: 200, wash: 50 },
]

const report: BarChartExport = {
  title: 'الإيرادات الشهرية: الكافيه مقابل المغسلة',
  description: 'وصف',
  period: '01/01/2026 — 28/02/2026',
  data: DATA,
  series: SERIES,
  categoryHeader: 'الشهر',
  filename: 'station-cafe-vs-wash-monthly',
}

type TextFill = { text: string; color: string }
type Rect = { color: string; x: number; y: number; width: number; height: number }

function installCanvasProbe(fills: TextFill[], rects: Rect[] = []) {
  let fillStyle = ''
  const context = {
    get fillStyle() {
      return fillStyle
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      fillStyle = String(value)
    },
    direction: '',
    textAlign: '',
    font: '',
    strokeStyle: '',
    lineWidth: 0,
    globalCompositeOperation: '',
    fillRect: vi.fn((x: number, y: number, width: number, height: number) =>
      rects.push({ color: fillStyle, x, y, width, height }),
    ),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn((text: string) => fills.push({ text, color: fillStyle })),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  )
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value: vi.fn((callback: BlobCallback) => callback(new Blob(['png']))),
  })
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:station-report'),
    revokeObjectURL: vi.fn(),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
}

describe('monthly comparison export', () => {
  beforeEach(() => {
    document.documentElement.style.setProperty('--info', '#0369a1')
    document.documentElement.style.setProperty('--primary', '#7a5230')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute('style')
  })

  it('draws the title, the period and both month labels on the PNG', async () => {
    const fills: TextFill[] = []
    installCanvasProbe(fills)

    await exportBarChartPng(report)

    const texts = fills.map((fill) => fill.text)
    expect(texts).toContain(report.title)
    expect(texts).toContain(`الفترة: ${report.period}`)
    // The full month label (with its year) is what the report prints.
    expect(texts).toContain('يناير 2026')
    expect(texts).toContain('فبراير 2026')
    // And the legend names both series with their period totals.
    expect(texts.some((text) => text.startsWith('كافيه —'))).toBe(true)
    expect(texts.some((text) => text.startsWith('مغسلة —'))).toBe(true)
  })

  it('resolves series colors from the live theme rather than inventing them', async () => {
    const fills: TextFill[] = []
    const rects: Rect[] = []
    installCanvasProbe(fills, rects)

    await exportBarChartPng({
      ...report,
      series: [{ key: 'cafe', label: 'كافيه', color: 'var(--info)' }],
    })

    // The bars and the legend swatch are painted with the RESOLVED token, never
    // with the literal `var(--info)` string, which no canvas could render.
    expect(rects.some((rect) => rect.color === '#0369a1')).toBe(true)
    expect(rects.every((rect) => !rect.color.includes('var('))).toBe(true)
  })

  it('builds a Station workbook for the monthly series', () => {
    const writeFile = vi.fn()
    vi.doMock('xlsx-js-style', () => ({
      utils: {
        book_new: () => ({}),
        book_append_sheet: vi.fn(),
        encode_cell: ({ r, c }: { r: number; c: number }) => `${r}:${c}`,
        encode_col: (index: number) => String.fromCharCode(65 + index),
      },
      writeFile,
    }))

    expect(() => exportBarChartExcel(report)).not.toThrow()
    vi.doUnmock('xlsx-js-style')
  })
})

describe('the stacked layout on the PNG', () => {
  beforeEach(() => {
    document.documentElement.style.setProperty('--info', '#0369a1')
    document.documentElement.style.setProperty('--primary', '#7a5230')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute('style')
  })

  const stackedReport: BarChartExport = {
    ...report,
    title: 'المصروفات الشهرية حسب الفئة',
    layout: 'stacked',
    filename: 'station-expenses-monthly',
  }

  /**
   * The painted bars only — the background fill and the legend swatches are also
   * rects, and neither is part of the plot.
   */
  function bars(rects: Rect[]): Rect[] {
    // Inside the plot only: the background fill is far wider than a bar, and the
    // legend swatches sit below the baseline.
    return rects.filter(
      (rect) => rect.width > 0 && rect.height > 0 && rect.y >= 240 && rect.y + rect.height <= 721,
    )
  }

  it('draws ONE column per month, with both series stacked inside it', async () => {
    const rects: Rect[] = []
    installCanvasProbe([], rects)

    await exportBarChartPng(stackedReport)

    const drawn = bars(rects)
    // Two months, two series each — but only TWO columns, because the segments
    // share their month's x and only their heights differ.
    expect(drawn).toHaveLength(4)
    const january = drawn.filter((rect) => rect.x < 600)
    const february = drawn.filter((rect) => rect.x >= 600)
    expect(january).toHaveLength(2)
    expect(february).toHaveLength(2)
    // Same x and same width inside a month: one bar, two segments.
    expect(january[0].x).toBe(january[1].x)
    expect(january[0].width).toBe(january[1].width)
    expect(february[0].x).toBe(february[1].x)
  })

  it('stacks the segments so the column height IS the month total', async () => {
    const rects: Rect[] = []
    installCanvasProbe([], rects)

    await exportBarChartPng(stackedReport)

    const drawn = bars(rects)
    // The tallest month (200 + 50 = 250) fills the whole plot height, which only
    // happens when the scale is the month TOTAL and not a single series.
    const column = (month: Rect[]) => ({
      top: Math.min(...month.map((rect) => rect.y)),
      bottom: Math.max(...month.map((rect) => rect.y + rect.height)),
    })
    const january = column(drawn.filter((rect) => rect.x < 600))
    const february = column(drawn.filter((rect) => rect.x >= 600))
    // Both columns stand on the same baseline…
    expect(january.bottom).toBeCloseTo(720)
    expect(february.bottom).toBeCloseTo(720)
    // …and February's top is the very top of the plot, because 250 is the max.
    expect(february.top).toBeCloseTo(250)
    // January's 150 fills 150/250 of the same 470px, not 150/200.
    expect(january.bottom - january.top).toBeCloseTo((720 - 250) * (150 / 250))
  })

  it('paints each segment in its own resolved theme color', async () => {
    const rects: Rect[] = []
    installCanvasProbe([], rects)

    await exportBarChartPng(stackedReport)

    const drawn = bars(rects)
    expect(new Set(drawn.map((rect) => rect.color))).toEqual(new Set(['#0369a1', '#7a5230']))
  })

  it('skips a category with no spend in that month instead of drawing an empty gap', async () => {
    const rects: Rect[] = []
    installCanvasProbe([], rects)

    await exportBarChartPng({
      ...stackedReport,
      data: [
        { month: '2026-01', label: 'يناير', fullLabel: 'يناير 2026', cafe: 100, wash: 0 },
        { month: '2026-02', label: 'فبراير', fullLabel: 'فبراير 2026', cafe: 200, wash: 50 },
      ],
    })

    // January has a single category, so it is a single segment; February still
    // has both. A zero is not a hole in the bar.
    expect(bars(rects).filter((rect) => rect.x < 600)).toHaveLength(1)
  })

  it('leaves the default layout grouped — a page that never asked for a stack is unchanged', async () => {
    const rects: Rect[] = []
    installCanvasProbe([], rects)

    await exportBarChartPng(report)

    const drawn = bars(rects)
    // Four bars, and the two of a month do NOT share an x — side by side.
    expect(drawn).toHaveLength(4)
    const january = drawn.filter((rect) => rect.x < 600)
    expect(january[0].x).not.toBe(january[1].x)
  })
})
