/**
 * The printed sheet itself: what an owner actually reads, and the one rule the
 * document owns — it is a SINGLE A4 page.
 *
 * The figures are not re-asserted here; they are the backend's, and
 * `monthly_executive_test` (Rust) plus `monthlyExecutive.test.ts` (the movement
 * and note rules) already cover them. What is left to prove on this side is that
 * the sheet PRINTS both departments separately, prints Arabic RTL, prints at
 * most three notes, and never prints a second page or a clipped figure.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { MonthlyExecutiveReport } from '@/services/opsApi'
import { MonthlyReportDocument } from './MonthlyReportDocument'

const REPORT: MonthlyExecutiveReport = {
  month: '2026-09',
  from: '2026-09-01',
  to: '2026-09-30',
  previous_month: '2026-08',
  cafe: {
    actual_minor: 8_240_000,
    target_minor: 8_000_000,
    overridden: true,
    achievement_percent: '103.00',
  },
  wash: {
    actual_minor: 4_300_000,
    target_minor: 4_500_000,
    overridden: false,
    achievement_percent: '95.56',
  },
  money: { revenue_minor: 12_540_000, expenses_minor: 3_240_000, net_minor: 9_300_000 },
  previous: { revenue_minor: 11_820_000, expenses_minor: 2_980_000, net_minor: 8_840_000 },
}

const renderSheet = (report: MonthlyExecutiveReport = REPORT) =>
  render(<MonthlyReportDocument report={report} />)

describe('MonthlyReportDocument', () => {
  it('is an RTL Arabic document carrying the four sections and nothing else', () => {
    renderSheet()
    const sheet = screen.getByTestId('monthly-report-document')

    // The whole page is right-to-left, which is what makes the Arabic read as
    // Arabic on paper rather than as mirrored text.
    expect(sheet).toHaveAttribute('dir', 'rtl')
    expect(screen.getByText('الأداء مقابل الهدف')).toBeInTheDocument()
    expect(screen.getByText('المال')).toBeInTheDocument()
    expect(screen.getByText('الحركة')).toBeInTheDocument()
    expect(screen.getByText('أهم الملاحظات')).toBeInTheDocument()
    // No operational detail leaks into an executive page.
    expect(screen.queryByText('المبيعات')).not.toBeInTheDocument()
  })

  /**
   * The rule that has no global answer to: Cafe and Wash are two INDEPENDENT
   * targets. A combined, averaged or weighted percentage would be an invention,
   * so the document must contain exactly the two figures and nothing between.
   */
  it('prints the two departments separately, with no combined achievement', () => {
    renderSheet()
    const cafe = screen.getByTestId('monthly-report-cafe')
    const wash = screen.getByTestId('monthly-report-wash')

    expect(within(cafe).getByText('103.00%')).toBeInTheDocument()
    expect(within(wash).getByText('95.56%')).toBeInTheDocument()
    // Cafe's surplus does not raise wash's figure, and neither is re-scaled.
    expect(screen.queryByText('99%')).not.toBeInTheDocument()
  })

  it('prints a dash, never a fabricated zero, for a month with no target', () => {
    renderSheet({
      ...REPORT,
      wash: { actual_minor: 0, target_minor: 0, overridden: false, achievement_percent: null },
    })
    const wash = screen.getByTestId('monthly-report-wash')
    expect(within(wash).queryByText('0.00%')).not.toBeInTheDocument()
    expect(within(wash).getByText('—')).toBeInTheDocument()
  })

  it('prints the money figures and a movement percentage against the previous month', () => {
    renderSheet()
    // Revenue 125,400 EGP, expenses 32,400 EGP, net 93,000 EGP — read through the
    // shared money formatter, exactly as every other money figure in Station.
    expect(screen.getByText('125,400.00 ج.م')).toBeInTheDocument()
    expect(screen.getByText('32,400.00 ج.م')).toBeInTheDocument()
    expect(screen.getByText('93,000.00 ج.م')).toBeInTheDocument()
    // Revenue rose from 118,200 to 125,400: +6.1%, stated once.
    expect(screen.getByText(/6\.1/)).toBeInTheDocument()
    // The previous month's AMOUNTS are never printed as a second table.
    expect(screen.queryByText('118,200.00 ج.م')).not.toBeInTheDocument()
  })

  it('states no movement at all when the month before had nothing in it', () => {
    renderSheet({
      ...REPORT,
      previous: { revenue_minor: 0, expenses_minor: 0, net_minor: 0 },
    })
    expect(screen.queryByText(/Infinity|NaN/)).not.toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  /**
   * The movement tone contract: the sign comes from the NUMERIC percent and the
   * number and its arrow share one semantic token — green for up, red for down,
   * neutral for flat — so the meaning survives the theme but never hard-codes a
   * colour. No new colour, no new helper: the same `text-success` /
   * `text-destructive` the monthly comparison chart and the inventory movement
   * log already use.
   */
  it('colours a rise green and a fall red, number and arrow together', () => {
    renderSheet()
    // Revenue rose 118,200 → 125,400 (+6.1%): number and arrow share the tone.
    // The arrow is part of the query so the movement line — not a note — matches.
    const rise = screen.getByText(/↑.*6\.1/)
    expect(rise.className).toContain('text-success')
    expect(rise.textContent).toContain('↑')
  })

  it('colours a fall red, number and arrow together', () => {
    renderSheet({
      ...REPORT,
      money: { ...REPORT.money, revenue_minor: 10_000_000 },
    })
    // Revenue fell 118,200 → 100,000 (≈ −15.4%): same span, destructive tone.
    const fall = screen.getByText(/↓.*15\.4/)
    expect(fall.className).toContain('text-destructive')
    expect(fall.textContent).toContain('↓')
  })

  it('keeps an unchanged figure neutral rather than green or red', () => {
    renderSheet({
      ...REPORT,
      money: { ...REPORT.money, revenue_minor: REPORT.previous.revenue_minor },
    })
    // 0% — flat is neither success nor destructive, and keeps its own arrow.
    const flat = screen.getByText(/→.*0%/)
    expect(flat.className).toContain('text-foreground-muted')
    expect(flat.className).not.toContain('text-success')
    expect(flat.className).not.toContain('text-destructive')
    expect(flat.textContent).toContain('→')
  })

  it('prints at most three notes', () => {
    renderSheet()
    expect(screen.getAllByRole('listitem').length).toBeLessThanOrEqual(3)
  })

  /**
   * The A4 clipping regression, asserted rather than eyeballed.
   *
   * The printable content box of an A4 page with the `@page` margin is 182mm
   * (~688px). The sheet's on-screen width cap was 48rem (768px) — WIDER than the
   * page — so while printing the sheet overflowed and the excess was cut off on
   * the left. `print:max-w-none` is what removes that overflow, and this test
   * fails if it is ever dropped.
   */
  it('never carries a screen width cap wider than the A4 printable box', () => {
    renderSheet()
    const classes = screen.getByTestId('monthly-report-document').className
    expect(classes).toContain('print:max-w-none')
  })

  /**
   * Money and Movement must break at the same two points, so the report reads as
   * one aligned table. Both use the same `grid-cols-3` template; this asserts the
   * Money row in particular, since it is the row that carries the three cards.
   */
  it('lays the three money figures out as one row of three equal columns', () => {
    renderSheet()
    const money = screen.getByRole('heading', { name: 'المال' }).parentElement
    const row = money?.querySelector('dl')
    expect(row?.className).toContain('grid-cols-3')
    expect(row?.children).toHaveLength(3)
  })
})
