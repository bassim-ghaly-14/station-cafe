import { utils, writeFile, type WorkBook, type WorkSheet } from 'xlsx-js-style'
import { getDateSettings, getMoneySettings } from '@/lib/formatting'
import { nowBusinessWallClock } from '@/lib/date'

export type ReportColumn = {
  header: string
  align?: 'right' | 'center' | 'left'
  format?: 'text' | 'currency' | 'percent' | 'integer' | 'date' | 'datetime'
}

export type ReportMetric = {
  label: string
  value: string | number
  format?: ReportColumn['format']
}

export type ReportLabels = {
  period: string
  generated: string
  summary: string
  details: string
  total: string
}

type StationReportPalette = {
  brand: string
  title: string
  header: string
  headerText: string
  body: string
  alternate: string
  border: string
  text: string
  muted: string
}

type ReportCell = string | number | Date
type ReportRow = ReportCell[]

const STATION_REPORT_FONT = 'Arial'
const MIN_COLUMN_WIDTH = 12
const MAX_COLUMN_WIDTH = 34
const MAX_SAMPLED_ROWS = 100

function excelDateFormat(format: string): string {
  const parts = format.split(/[/-]/)
  if (parts[0] === 'YYYY') return 'yyyy-mm-dd'
  if (parts[0] === 'MM') return 'mm-dd-yyyy'
  return 'dd-mm-yyyy'
}

/** Map Station's stable print/brand tokens to a light Excel document palette. */
export function stationReportPalette(): StationReportPalette {
  const css = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || css.getPropertyValue(fallback).trim()
  return {
    brand: token('--palette-brand-900', '--primary'),
    title: token('--palette-brand-800', '--primary'),
    header: token('--palette-brand-600', '--primary'),
    headerText: token('--print-paper', '--foreground-inverse'),
    body: token('--print-paper', '--surface-card'),
    alternate: token('--print-total-bg', '--surface-muted'),
    border: token('--print-border', '--border'),
    text: token('--print-ink', '--foreground'),
    muted: token('--print-ink-muted', '--foreground-muted'),
  }
}

function font(color: string, size = 11, bold = false) {
  return { name: STATION_REPORT_FONT, sz: size, bold, color: { rgb: color.replace(/^#/, '') } }
}

function border(color: string, heavy = false) {
  const side = { style: heavy ? 'medium' : 'thin', color: { rgb: color.replace(/^#/, '') } }
  return heavy ? { top: side, bottom: side, left: side, right: side } : { bottom: side }
}

function cellStyle(
  palette: StationReportPalette,
  role:
    | 'brand'
    | 'title'
    | 'meta'
    | 'summaryLabel'
    | 'summaryValue'
    | 'header'
    | 'body'
    | 'alternate'
    | 'total',
  align: 'right' | 'center' | 'left',
  format?: string,
) {
  const darkFill = role === 'brand' || role === 'header'
  const fill =
    role === 'brand'
      ? palette.brand
      : role === 'title'
        ? palette.title
        : role === 'header'
          ? palette.header
          : role === 'alternate' ||
              role === 'total' ||
              role === 'summaryLabel' ||
              role === 'summaryValue'
            ? palette.alternate
            : palette.body
  const color = darkFill
    ? palette.headerText
    : role === 'title'
      ? palette.headerText
      : role === 'meta'
        ? palette.muted
        : palette.text
  const size =
    role === 'brand'
      ? 20
      : role === 'title'
        ? 15
        : role === 'header' || role === 'summaryLabel' || role === 'summaryValue'
          ? 11
          : 10
  const bold = role !== 'body' && role !== 'alternate' && role !== 'meta'
  const separator =
    role === 'title' || role === 'summaryLabel' || role === 'summaryValue' || role === 'total'

  return {
    font: font(color, size, bold),
    fill: { patternType: 'solid', fgColor: { rgb: fill.replace(/^#/, '') } },
    alignment: {
      horizontal: align,
      vertical: 'center',
      wrapText: true,
      readingOrder: align === 'right' ? 2 : 1,
    },
    border: separator
      ? { bottom: { style: 'medium', color: { rgb: palette.border.replace(/^#/, '') } } }
      : role === 'header'
        ? border(palette.headerText, false)
        : {},
    ...(format ? { numFmt: format } : {}),
  }
}

function formatFor(format: ReportColumn['format']): string | undefined {
  const money = getMoneySettings()
  const date = getDateSettings()
  if (format === 'currency')
    return `${money.useThousandsSeparator ? '#,##0' : '0'}.${'0'.repeat(money.decimalPlaces)}`
  if (format === 'percent') return '0.0%'
  if (format === 'integer') return money.useThousandsSeparator ? '#,##0' : '0'
  if (format === 'date') return excelDateFormat(date.dateFormat)
  if (format === 'datetime')
    return `${excelDateFormat(date.dateFormat)} ${date.timeFormat === '12h' ? 'h:mm AM/PM' : 'hh:mm'}`
  return undefined
}

function displayLength(value: ReportCell): number {
  if (typeof value !== 'string') return 12
  return [...value.trim()].reduce(
    (length, character) => length + (/[\u0600-\u06ff]/.test(character) ? 1.15 : 1),
    0,
  )
}

export function calculateColumnWidths(columns: ReportColumn[], rows: ReportRow[]): number[] {
  return columns.map((column, columnIndex) => {
    const sample = [
      column.header,
      ...rows.slice(0, MAX_SAMPLED_ROWS).map((row) => row[columnIndex]),
    ]
    const contentWidth = Math.max(...sample.map(displayLength), MIN_COLUMN_WIDTH) + 2
    return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, contentWidth)))
  })
}

function defaultAlignment(): 'right' {
  return 'right'
}

function put(
  sheet: WorkSheet,
  row: number,
  column: number,
  value: string | number | Date,
  style: unknown,
  z?: string,
) {
  const address = utils.encode_cell({ r: row, c: column })
  sheet[address] = {
    v: value,
    t: value instanceof Date ? 'd' : typeof value === 'number' ? 'n' : 's',
    ...(z ? { z } : {}),
    s: style,
  }
}

export function createStationReportSheet({
  title,
  description,
  period,
  columns,
  rows,
  summary,
  total,
  sheetName,
  labels,
}: {
  title: string
  description: string
  period: string
  columns: ReportColumn[]
  rows: ReportRow[]
  summary?: ReportMetric[]
  total?: ReportRow
  sheetName: string
  labels: ReportLabels
}): { book: WorkBook; sheet: WorkSheet } {
  const palette = stationReportPalette()
  const sheet = utils.aoa_to_sheet([[]])
  const lastColumn = utils.encode_col(columns.length - 1)
  const summaryStart = 5
  const tableSectionRow = summaryStart + (summary?.length ?? 0)
  const tableHeaderRow = tableSectionRow + 1
  const firstDataRow = tableHeaderRow + 1
  const lastDataRow = firstDataRow + rows.length - 1
  const totalRow = total ? lastDataRow + 1 : null
  const finalExcelRow = lastDataRow + 1 + (total ? 1 : 0)
  const widths = calculateColumnWidths(columns, rows)

  put(sheet, 0, 0, 'STATION CAFE', cellStyle(palette, 'brand', 'left'))
  put(sheet, 1, 0, title, cellStyle(palette, 'title', 'right'))
  put(sheet, 2, 0, description, cellStyle(palette, 'meta', 'right'))
  put(sheet, 3, 0, `${labels.period} ${period}`, cellStyle(palette, 'meta', 'right'))
  put(sheet, 3, 1, labels.generated, cellStyle(palette, 'meta', 'left'))
  // "Generated at" is the Station business wall clock, not the browser's
  // timezone, so the exported report reads the same on any machine.
  put(
    sheet,
    3,
    2,
    nowBusinessWallClock(),
    cellStyle(palette, 'meta', 'left'),
    formatFor('datetime'),
  )

  put(sheet, 4, 0, labels.summary, cellStyle(palette, 'summaryLabel', 'right'))
  summary?.forEach((metric, index) => {
    const row = summaryStart + index
    put(sheet, row, 0, metric.label, cellStyle(palette, 'summaryLabel', 'right'))
    put(
      sheet,
      row,
      columns.length - 1,
      metric.value,
      cellStyle(palette, 'summaryValue', 'right', formatFor(metric.format)),
    )
  })

  put(sheet, tableSectionRow, 0, labels.details, cellStyle(palette, 'summaryLabel', 'right'))
  columns.forEach((column, index) =>
    put(sheet, tableHeaderRow, index, column.header, cellStyle(palette, 'header', 'center')),
  )
  rows.forEach((row, rowIndex) =>
    row.forEach((value, columnIndex) => {
      const column = columns[columnIndex]
      put(
        sheet,
        firstDataRow + rowIndex,
        columnIndex,
        value,
        cellStyle(palette, rowIndex % 2 ? 'alternate' : 'body', column.align ?? defaultAlignment()),
        formatFor(column.format),
      )
    }),
  )

  if (total && totalRow !== null) {
    total.forEach((value, columnIndex) => {
      const column = columns[columnIndex]
      const z = formatFor(column.format)
      const address = utils.encode_cell({ r: totalRow, c: columnIndex })
      const cell: Record<string, unknown> = {
        v: value,
        t: value instanceof Date ? 'd' : typeof value === 'number' ? 'n' : 's',
        ...(z ? { z } : {}),
        s: cellStyle(palette, 'total', column.align ?? defaultAlignment()),
      }
      if (columnIndex > 0 && typeof value === 'number' && column.format)
        cell.f = `SUM(${utils.encode_col(columnIndex)}${firstDataRow + 1}:${utils.encode_col(columnIndex)}${lastDataRow + 1})`
      sheet[address] = cell
    })
  }

  sheet['!ref'] = `A1:${lastColumn}${finalExcelRow}`
  sheet['!merges'] = [
    ...[0, 1, 2, 4, tableSectionRow].map((row) => ({
      s: { r: row, c: 0 },
      e: { r: row, c: columns.length - 1 },
    })),
    ...(summary?.map((_, index) => ({
      s: { r: summaryStart + index, c: 0 },
      e: { r: summaryStart + index, c: Math.max(0, columns.length - 2) },
    })) ?? []),
  ]
  sheet['!cols'] = widths.map((wch) => ({ wch }))
  sheet['!rows'] = Array.from({ length: finalExcelRow }, (_, index) => ({
    hpt:
      index === 0
        ? 32
        : index === 1
          ? 26
          : index === tableHeaderRow
            ? 25
            : index === tableSectionRow || index === 4
              ? 22
              : 20,
  }))
  if (rows.length)
    sheet['!autofilter'] = { ref: `A${tableHeaderRow + 1}:${lastColumn}${lastDataRow + 1}` }
  sheet['!margins'] = { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }

  const book = utils.book_new()
  book.Props = {
    Title: `Station Cafe | ${title}`,
    Subject: description,
    Author: 'Station Cafe',
    Company: 'Station Cafe',
    Category: 'Business report',
    Keywords: `Station Cafe, ${title}, business report`,
    CreatedDate: nowBusinessWallClock(),
  }
  utils.book_append_sheet(book, sheet, sheetName)
  const appendedSheet = book.Sheets[sheetName]
  if (appendedSheet) appendedSheet['!ref'] = `A1:${lastColumn}${finalExcelRow}`
  return { book, sheet: appendedSheet ?? sheet }
}

export function downloadStationWorkbook(book: WorkBook, filename: string) {
  writeFile(book, filename, { cellStyles: true, bookSST: true })
}
