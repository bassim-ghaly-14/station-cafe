/**
 * The shared responsive primitives, and the contracts they exist to keep.
 *
 * These are the abstractions every screen's mobile behaviour now flows through,
 * so the tests here are deliberately about the SHARED RULE rather than about any
 * one screen: a screen that renders correctly because of a one-off class is a
 * screen that regresses silently the next time someone tidies it.
 *
 * Each assertion below pins a decision that was a real defect:
 *
 *  - `DialogActions` stacks on a phone and does NOT on a desktop;
 *  - `ActionMenu` opens the shared `Sheet` (a fixed overlay) rather than a
 *    popover a table's scroller would clip, and renders nothing at all when
 *    there is nothing behind it;
 *  - `FilterBar` gives the search its own full-width line on a phone, so the
 *    primary action stops competing with it for 296px;
 *  - `RecordList` is a real list with real list items, so a record is announced
 *    as a record rather than as a stray group of divs.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ActionMenu } from './action-menu'
import { Dialog } from './dialog'
import { DialogActions } from './dialog-actions'
import { Button } from './button'
import { FilterBar, ToolbarSearch } from './toolbar'
import { RecordList, RecordListItem, RecordListActions } from './data-table'
import { Trash2 } from './icon'

describe('DialogActions', () => {
  it('stacks full width on a phone and stays a trailing row on a desktop', () => {
    render(
      <Dialog open onClose={() => undefined} title="حذف">
        <DialogActions>
          <Button variant="outline">إلغاء</Button>
          <Button>تأكيد</Button>
        </DialogActions>
      </Dialog>,
    )
    const row = screen.getByRole('button', { name: 'إلغاء' }).parentElement
    expect(row).not.toBeNull()

    // Below `sm` the row is a COLUMN. A column flex container stretches its
    // items to its own width, which is what makes each action a full-width
    // target with no per-button class at all.
    expect(row?.className).toContain('flex-col')
    // And the desktop row is preserved exactly, trailing-aligned.
    expect(row?.className).toContain('sm:flex-row')
    expect(row?.className).toContain('sm:justify-end')
  })

  it("preserves the caller's own order and spacing", () => {
    render(
      <DialogActions className="mt-4 border-t border-border-subtle pt-4">
        <Button>أ</Button>
        <Button>ب</Button>
      </DialogActions>,
    )
    const row = screen.getByRole('button', { name: 'أ' }).parentElement
    expect(row?.className).toContain('mt-4')
    expect(row?.className).toContain('border-t')
    // Order is the caller's, untouched: أ then ب in document order.
    const buttons = within(row as HTMLElement).getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['أ', 'ب'])
  })
})

describe('ActionMenu', () => {
  it('renders no trigger at all when it has nothing behind it', () => {
    // A "more" control that opens an empty sheet is a control that lies about
    // what is behind it, and a role with no secondary actions is a real case.
    render(<ActionMenu items={[]} label="المزيد" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('opens the shared Sheet, not a popover a table scroller would clip', () => {
    const onClick = vi.fn()
    render(
      <ActionMenu
        label="المزيد من الإجراءات: أحمد"
        items={[
          { key: 'delete', label: 'حذف أحمد نهائيًا', icon: <Trash2 />, tone: 'danger', onClick },
        ]}
      />,
    )
    const trigger = screen.getByRole('button', { name: 'المزيد من الإجراءات: أحمد' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)

    // The panel is a `role="dialog"` overlay from the app's own `Sheet`
    // primitive — the same one the mobile navigation's "More" uses. A popover
    // positioned inside the table would be clipped by the table's horizontal
    // scroller, so its entries would be cut off halfway.
    const sheet = screen.getByRole('dialog')
    const row = within(sheet).getByRole('button', { name: 'حذف أحمد نهائيًا' })

    // Every entry keeps a 48px full-width target: never smaller on a phone.
    expect(row.className).toContain('min-h-12')
    expect(row.className).toContain('w-full')
    // And the destructive tone still reads as destructive from the row itself.
    expect(row.className).toContain('text-destructive-soft-foreground')

    fireEvent.click(row)
    expect(onClick).toHaveBeenCalledTimes(1)
    // The sheet closes first, so the page's own confirmation owns the screen.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps a disabled entry disabled and unclickable', () => {
    const onClick = vi.fn()
    render(
      <ActionMenu
        label="المزيد"
        items={[{ key: 'x', label: 'غير متاح', icon: <Trash2 />, disabled: true, onClick }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'المزيد' }))
    const row = screen.getByRole('button', { name: 'غير متاح' })
    expect(row).toBeDisabled()
    fireEvent.click(row)
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('FilterBar and ToolbarSearch', () => {
  it('gives the search its own full-width line on a phone', () => {
    render(
      <FilterBar
        search={
          <ToolbarSearch value="" onValueChange={() => undefined} label="بحث" placeholder="ابحث" />
        }
      >
        <Button>إضافة</Button>
      </FilterBar>,
    )
    const field = screen.getByRole('searchbox', { name: 'بحث' })
    // The field is `w-full` below `sm` and only joins the control row from `sm`
    // up, so it is never the item that gets whatever width is left over.
    expect(field.parentElement?.className).toContain('w-full')
    expect(field.parentElement?.className).toContain('sm:flex-1')
  })

  it('offers a labelled clear control only while there is something to clear', () => {
    const onValueChange = vi.fn()
    const { rerender } = render(
      <ToolbarSearch
        value=""
        onValueChange={onValueChange}
        label="بحث"
        placeholder="ابحث عن موظف"
        clearLabel="مسح البحث"
      />,
    )
    expect(screen.queryByRole('button', { name: 'مسح البحث' })).not.toBeInTheDocument()

    rerender(
      <ToolbarSearch
        value="سيد"
        onValueChange={onValueChange}
        label="بحث"
        placeholder="ابحث عن موظف"
        clearLabel="مسح البحث"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'مسح البحث' }))
    expect(onValueChange).toHaveBeenCalledWith('')
  })
})

describe('RecordList', () => {
  it('is a real list of real list items, not a div soup', () => {
    render(
      <RecordList aria-label="السجل">
        <RecordListItem>
          <p>أحمد</p>
          <RecordListActions>
            <Button aria-label="حضور" />
          </RecordListActions>
        </RecordListItem>
      </RecordList>,
    )
    // A record is announced as a list, which is what a screen reader and a
    // keyboard user both navigate by — a bare stack of divs is neither.
    const list = screen.getByRole('list', { name: 'السجل' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'حضور' })).toBeInTheDocument()
  })
})
