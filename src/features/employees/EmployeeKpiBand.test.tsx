/**
 * The headcount KPI tile.
 *
 * The tile answers two questions at different weights — how many people, and how
 * that splits by type — so these tests assert the breakdown is a REAL section with
 * its own labelled figures rather than a caption string, and that it stays
 * contained inside its tile.
 *
 * Containment is asserted as the LAYOUT RULES that produce it (`grid-cols-2`,
 * `min-w-0`, `truncate`, `tabular-nums`) rather than as pixels: jsdom has no layout
 * engine, so a width assertion would be a fiction. What matters is that nothing in
 * the subtree declares a fixed width and that every leaf can shrink inside its
 * half — that is what keeps `9999` inside the card at 1280×800 and on a phone.
 */
import { render, screen, within } from '@testing-library/react'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import i18n, { DEFAULT_LOCALE } from '@/lib/i18n'
import { EmployeeKpiBand } from './EmployeeKpiBand'
import type { EmployeeOverview } from '@/services/employeesApi'

await act(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

function overview(over: Partial<EmployeeOverview> = {}): EmployeeOverview {
  return {
    total_employees: 12,
    total_cashiers: 7,
    total_wash_workers: 5,
    top_attendance: null,
    top_hours: null,
    top_shifts: null,
    top_cafe_revenue: null,
    ...over,
  }
}

/**
 * The headcount tile: the card holding the total plus its two-figure breakdown.
 *
 * `.group` is this band's own tile-root marker class, so this resolves to the CARD
 * and not one of the wrappers between it and the figure.
 */
function headcountTile(): HTMLElement {
  const list = document.querySelector('dl')
  expect(list).not.toBeNull()
  const tile = (list as HTMLElement).closest('.group')
  expect(tile).not.toBeNull()
  return tile as HTMLElement
}

/**
 * A leader tile: the card holding the metric label, the employee's name and the
 * figure beneath it. Resolved from the metric LABEL so the test names the tile it
 * means rather than whichever one happens to be first in the band.
 */
function leaderTile(label: string): HTMLElement {
  const heading = screen.getByText(label)
  const tile = heading.closest('.group')
  expect(tile, label).not.toBeNull()
  return tile as HTMLElement
}

/** The four leader metrics, in the order the band renders them. */
const LEADER_LABELS = ['الأكثر حضورًا', 'أعلى ساعات حضور', 'أكثر ورديات', 'أعلى إيراد كافيه']

describe('EmployeeKpiBand — the leader tiles', () => {
  const leaders = {
    top_attendance: { employee_id: 1, name: 'أحمد سيد', value: 23 },
    top_hours: { employee_id: 2, name: 'محمد علي', value: 184 },
    top_shifts: { employee_id: 3, name: 'عمر حسن', value: 21 },
    top_cafe_revenue: { employee_id: 4, name: 'سيد إبراهيم', value: 12_540_000 },
  }

  it('names the person as the tile content, with the figure beneath the name', () => {
    render(<EmployeeKpiBand overview={overview(leaders)} loading={false} />)

    // Every leader tile states all three things, and states the NAME first.
    // jsdom has no layout engine, so DOM order is what can honestly be asserted
    // here; the type scale is verified in the hierarchy test below.
    for (const [label, name] of [
      ['الأكثر حضورًا', 'أحمد سيد'],
      ['أعلى ساعات حضور', 'محمد علي'],
      ['أكثر ورديات', 'عمر حسن'],
      ['أعلى إيراد كافيه', 'سيد إبراهيم'],
    ] as const) {
      const tile = leaderTile(label)
      const nodes = Array.from(tile.querySelectorAll('p'))
      const nameIndex = nodes.findIndex((node) => node.textContent === name)
      const figureIndex = nodes.findIndex((node) => /\d/.test(node.textContent ?? ''))
      expect(nameIndex, `${label}: name present`).toBeGreaterThanOrEqual(0)
      expect(figureIndex, `${label}: figure present`).toBeGreaterThanOrEqual(0)
      // The label is the node before both; the NAME precedes the FIGURE.
      expect(nameIndex, `${label}: name before figure`).toBeLessThan(figureIndex)
    }
  })

  it('gives the name the tile STRONGEST type and the figure the caption scale', () => {
    render(<EmployeeKpiBand overview={overview(leaders)} loading={false} />)
    const tile = leaderTile('الأكثر حضورًا')

    const name = within(tile).getByText('أحمد سيد')
    // The figure line is the `p`, not the span nested inside it.
    const figure = within(tile)
      .getByText(/23\s*يوم حضور/)
      .closest('p')
    expect(figure).not.toBeNull()

    // The hierarchy is a TYPE hierarchy, not a colour or an icon: the name is
    // the larger bold line, the figure the smaller muted one beneath it.
    expect(name.className).toMatch(/text-\[1\.25rem\]/)
    expect(name.className).toMatch(/font-bold/)
    expect(figure?.className).toContain('text-caption')
  })

  it('states attendance in DAYS, so the figure cannot be read as some other unit', () => {
    render(<EmployeeKpiBand overview={overview(leaders)} loading={false} />)
    const tile = leaderTile('الأكثر حضورًا')
    // The unit is part of the figure: a bare `23` would be ambiguous.
    expect(within(tile).getByText(/23\s*يوم حضور/)).toBeInTheDocument()
    expect(within(tile).queryByText('23')).not.toBeInTheDocument()
  })

  it('keeps each metric value and its unit, unchanged from the backend', () => {
    render(<EmployeeKpiBand overview={overview(leaders)} loading={false} />)
    expect(within(leaderTile('الأكثر حضورًا')).getByText(/23/)).toBeInTheDocument()
    expect(within(leaderTile('أكثر ورديات')).getByText(/21/)).toBeInTheDocument()
    // Hours still read through the shared duration formatter, so a display-mode
    // change in Dev Settings reaches this tile exactly as it reaches the column.
    expect(within(leaderTile('أعلى ساعات حضور')).getByText(/س$/)).toBeInTheDocument()
    // Revenue still reads through the shared money formatter, which renders the
    // compact Arabic form — this tile changed no part of how money is shown.
    expect(within(leaderTile('أعلى إيراد كافيه')).getByText(/ج\.م/)).toBeInTheDocument()
  })

  it('names no employee and states no figure when nobody leads the period', () => {
    render(<EmployeeKpiBand overview={overview()} loading={false} />)
    for (const label of LEADER_LABELS) {
      const tile = leaderTile(label)
      expect(within(tile).getByText('لا يوجد')).toBeInTheDocument()
    }
    // No fabricated figure anywhere in the band: a zero is not a leader.
    expect(screen.queryByText(/0/)).not.toBeInTheDocument()
  })
})
describe('EmployeeKpiBand — the headcount breakdown', () => {
  it('states the total and both type figures as separate, labelled numbers', () => {
    render(<EmployeeKpiBand overview={overview()} loading={false} />)

    expect(screen.getByText('عدد الموظفين')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()

    const list = document.querySelector('dl') as HTMLElement
    expect(within(list).getByText('الكاشير')).toBeInTheDocument()
    expect(within(list).getByText('عمال المغسلة')).toBeInTheDocument()
    // Each label is paired with its own figure: the two counts are immediately
    // distinguishable, which a single caption string was not.
    expect(within(list).getAllByRole('term')).toHaveLength(2)
    expect(within(list).getAllByRole('definition')).toHaveLength(2)
  })

  it('renders zero for both halves without collapsing the layout', () => {
    render(
      <EmployeeKpiBand
        overview={overview({ total_employees: 0, total_cashiers: 0, total_wash_workers: 0 })}
        loading={false}
      />,
    )
    // A zero is a real figure — an empty cafe has no employees — so the breakdown
    // must still be laid out, not hidden behind a falsy check.
    const list = document.querySelector('dl') as HTMLElement
    expect(within(list).getAllByRole('definition')).toHaveLength(2)
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(3)
  })

  it('lays the breakdown out intrinsically so a four-digit count cannot overflow', () => {
    render(
      <EmployeeKpiBand
        overview={overview({
          total_employees: 19998,
          total_cashiers: 9999,
          total_wash_workers: 9999,
        })}
        loading={false}
      />,
    )

    const list = document.querySelector('dl') as HTMLElement
    expect(within(list).getAllByText('9999')).toHaveLength(2)

    // Each half is exactly half the tile, whatever the tile's own width is.
    expect(list.className).toContain('grid-cols-2')
    // No fixed width anywhere in the subtree: a px width is exactly what breaks
    // at one end of the responsive range.
    for (const el of [list, ...Array.from(list.querySelectorAll('div, dd, dt'))]) {
      const className = (el as HTMLElement).className
      expect(className).not.toMatch(/(?:^|\s)(?:w|min-w)-\[/)
      expect(className).not.toMatch(/(?:^|\s)w-\d/)
    }

    for (const entry of Array.from(list.querySelectorAll('div'))) {
      // `min-w-0` is what lets a figure SHRINK inside its half — without it the
      // grid cell is floored at its content's width and the card overflows.
      expect(entry.className).toContain('min-w-0')
    }
    for (const leaf of Array.from(list.querySelectorAll('dd, dt'))) {
      // The containment net: clipped inside the tile rather than pushing it.
      expect(leaf.className).toContain('truncate')
    }
    for (const figure of Array.from(list.querySelectorAll('dd'))) {
      // Tabular digits: `9999` occupies the same width as `9`, so a large headcount
      // cannot reflow the card or wrap onto a second line.
      expect(figure.className).toContain('tabular-nums')
    }
  })

  it('renders the breakdown inside the headcount tile, not across the band', () => {
    render(<EmployeeKpiBand overview={overview()} loading={false} />)
    const tile = headcountTile()
    expect(tile.querySelector('dl')).not.toBeNull()
    // The tile is a flex cell that stretches to its grid row, so the breakdown
    // filling it is containment by construction: the tile has no intrinsic width.
    expect(tile.className).toContain('flex')
  })
})
