import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/lib/i18n'
import { exportAnalyticsPng } from './exports'
import type { AnalyticsChart } from './analyticsCharts'

/**
 * The fixture is a real chart id, so `titleKey` / `descriptionKey` / `labelKey`
 * resolve through the production catalogue exactly as they do on screen. The
 * exporter must not need any display string of its own.
 */
const chart: AnalyticsChart = {
  id: 'cash-visa',
  titleKey: 'cashVisaTitle',
  descriptionKey: 'cashVisaDescription',
  total: 100,
  hasData: true,
  icon: (() => null) as unknown as AnalyticsChart['icon'],
  exportFilename: 'test',
  categories: [{ id: 'cash', labelKey: 'cash', value: 100, color: 'var(--primary)' }],
}

type TextFill = { text: string; color: string }

function installCanvasProbe(fills: TextFill[]) {
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
    globalCompositeOperation: '',
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
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

describe('AnalyticsDonutChart PNG total colors', () => {
  beforeEach(() => {
    document.documentElement.dataset.theme = 'light'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute('style')
  })

  it.each(['light', 'dark'] as const)(
    'always exports white center-total text in $theme mode',
    async (theme) => {
      document.documentElement.dataset.theme = theme
      document.documentElement.style.setProperty('--foreground-strong', '#432d1c')
      document.documentElement.style.setProperty('--foreground-subtle', '#96673a')
      const fills: TextFill[] = []
      installCanvasProbe(fills)

      await exportAnalyticsPng(chart, '01/09/2026 — 25/09/2026')

      expect(fills.find(({ text }) => text === 'إجمالي')?.color).toBe('#FFFFFF')
      const totalIndex = fills.findIndex(
        ({ text }) =>
          text !== 'إجمالي' &&
          text !== i18n.t('reports.charts.cashVisaTitle') &&
          text !== i18n.t('reports.charts.cashVisaDescription') &&
          !text.startsWith('الفترة:') &&
          !text.includes(' — '),
      )
      expect(fills[totalIndex]?.color).toBe('#FFFFFF')
      // The exported legend is labelled from the catalogue, not from a literal
      // in the exporter, so the PNG matches the screen.
      expect(
        fills.some(({ text }) => text.startsWith(i18n.t('reports.charts.categories.cash'))),
      ).toBe(true)
    },
  )
})
