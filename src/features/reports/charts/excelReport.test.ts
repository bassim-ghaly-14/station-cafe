import * as XLSX from 'xlsx-js-style'
import { describe, expect, it } from 'vitest'
import { createStationReportSheet } from './excelReport'

const columns = [
  { header: 'الفئة', align: 'right' as const, format: 'text' as const },
  { header: 'القيمة', align: 'right' as const, format: 'currency' as const },
  { header: 'النسبة', align: 'right' as const, format: 'percent' as const },
]

describe('Station Excel reports', () => {
  it('generates a styled, filterable workbook for every analytics report', () => {
    document.documentElement.style.setProperty('--print-paper', '#fffdf9')
    document.documentElement.style.setProperty('--print-ink', '#211c17')
    document.documentElement.style.setProperty('--print-ink-muted', '#5c5146')
    document.documentElement.style.setProperty('--print-border', '#d8cbb8')
    document.documentElement.style.setProperty('--print-total-bg', '#f4eee4')
    document.documentElement.style.setProperty('--palette-brand-600', '#96673a')
    document.documentElement.style.setProperty('--palette-brand-800', '#5e3f25')

    const charts = [
      {
        id: 'laundry-cafe',
        title: 'المغسلة مقابل الكافيه',
        description: 'توزيع الإيرادات حسب النشاط',
        total: 3000,
        categories: [
          { label: 'المغسلة', value: 2000 },
          { label: 'كافيه', value: 1000 },
        ],
      },
    ]
    for (const chart of charts) {
      const { book } = createStationReportSheet({
        title: chart.title,
        description: chart.description,
        period: '01/09/2026 — 25/09/2026',
        columns,
        rows: chart.categories.map((category) => [
          category.label,
          category.value / 100,
          category.value / chart.total,
        ]),
        summary: [
          { label: 'إجمالي القيمة', value: chart.total / 100, format: 'currency' },
          { label: 'عدد الفئات', value: chart.categories.length, format: 'integer' },
        ],
        total: ['الإجمالي', chart.total / 100, 1],
        sheetName: 'التقرير',
        labels: {
          period: 'الفترة:',
          generated: 'تاريخ التصدير:',
          summary: 'ملخص التقرير',
          details: 'تفاصيل التقرير',
          total: 'الإجمالي',
        },
      })
      const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx', cellStyles: true })
      if (import.meta.env.VITE_GENERATE_STATION_REPORTS) {
        XLSX.writeFile(book, `/tmp/station-${chart.id}.xlsx`, { cellStyles: true })
      }
      const workbook = XLSX.read(buffer, { type: 'buffer', cellStyles: true, cellNF: true })
      const sheet = workbook.Sheets['التقرير']

      expect(sheet['!ref']).toBe('A1:C12')
      expect(sheet['!autofilter']?.ref).toBe('A9:C11')
      expect(sheet['!merges']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }),
          expect.objectContaining({ s: { r: 5, c: 0 }, e: { r: 5, c: 1 } }),
        ]),
      )
      expect(sheet['!cols']?.map((column) => column.wch)).toEqual([14, 14, 14])
      expect(sheet['!rows']).toHaveLength(12)
      expect(sheet.A2?.v).toBe(chart.title)
      expect(sheet.A4?.v).toBe('الفترة: 01/09/2026 — 25/09/2026')
      expect(sheet.C4?.t).toBe('n')
      expect(sheet.C4?.z).toBe('dd-mm-yyyy hh:mm')
      expect(sheet.A5?.v).toBe('ملخص التقرير')
      expect(sheet.C6?.v).toBe(chart.total / 100)
      expect(sheet.A9?.v).toBe('الفئة')
      expect(sheet.A10?.v).toBe(chart.categories[0].label)
      expect(sheet.B10?.t).toBe('n')
      expect(sheet.B12?.f).toBe('SUM(B10:B11)')
      expect(sheet.C10?.z).toBe('0.0%')
      expect(workbook.Props?.Title).toBe(`Station Cafe | ${chart.title}`)
    }
  })
})
