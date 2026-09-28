/**
 * ActionMenu — the "more" menu a dense row's SECONDARY actions live in.
 *
 * Why it exists
 * -------------
 * The Employees roster row is the densest action set in the application: four
 * attendance punches, details, edit, activate/deactivate and (for an ADMIN)
 * a permanent delete. At the shared 48px hit target that is 336px of control in
 * one cell, and a phone is 320–430px wide. There is no arrangement that keeps
 * eight labelled, tappable controls on one line of a 320px screen, so something
 * has to give — and the two things that must NOT give are the primary punches
 * and the destructive semantics of the delete.
 *
 * So the punches stay directly visible and everything else moves behind ONE
 * control. That is the trade this component makes explicit:
 *
 *  - the primary actions stay OUTSIDE the menu, one tap, always;
 *  - the secondary ones are one extra tap, never a nested submenu;
 *  - every entry keeps its own Arabic label, its own icon, its own enabled or
 *    disabled state and its own semantic tone, so a destructive action is still
 *    visibly destructive from the menu row itself.
 *
 * Why a SHEET and not a popover
 * -----------------------------
 * The menu is opened from inside a table, and a table on a phone lives in a
 * horizontally scrolling container (`DataTable`). An absolutely positioned
 * popover would be clipped by that scroller — the entries would be cut off
 * halfway, which is worse than no menu. The shared `Sheet` is a fixed overlay
 * outside the scroll context entirely, rises from the bottom edge where the
 * thumb already is, and is already the app's phone-layer vocabulary (the same
 * primitive the mobile navigation's "More" panel uses). So this is the app's
 * own solution, reused, not a second one.
 *
 * Accessibility
 * -------------
 * The trigger is a real `<button>` with `aria-expanded` and an accessible name,
 * and the panel is the shared `Sheet`'s `role="dialog"` with its own close
 * control and Escape handling. Nothing here depends on hover, on a pointer, or
 * on the icon alone.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from './button'
import { Sheet } from './sheet'
import { MoreHorizontal } from './icon'
import { cn } from '@/lib/utils'
import type { TableActionTone } from './table-action-button'

/** One entry in the menu. */
export interface ActionMenuItem {
  readonly key: string
  /** Visible Arabic label; also the row's accessible name. */
  readonly label: string
  readonly icon: ReactNode
  readonly onClick: () => void
  readonly tone?: TableActionTone
  readonly disabled?: boolean
  /** Fires the intent only. Confirmation, request and toast stay with the page. */
  readonly testId?: string
}

const MENU_TONE: Record<TableActionTone, string> = {
  info: 'text-info-foreground hover:bg-info-soft active:bg-info-soft-hover',
  success: 'text-success-foreground hover:bg-success-soft active:bg-success-soft-hover',
  warning: 'text-warning-foreground hover:bg-warning-soft active:bg-warning-soft-hover',
  danger:
    'text-destructive-soft-foreground hover:bg-destructive-soft active:bg-destructive-soft-hover',
}

export function ActionMenu({
  items,
  /** Accessible name of the trigger, e.g. "المزيد من إجراءات أحمد سيد". */
  label,
  className,
}: {
  readonly items: readonly ActionMenuItem[]
  readonly label: string
  readonly className?: string
}) {
  const [open, setOpen] = useState(false)

  // Nothing to offer is nothing to render: a trigger that opens an empty sheet
  // is a control that lies about what is behind it.
  if (items.length === 0) return null

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        // `icon` (40px) rather than the table's `icon-lg` (48px): in the record
        // layout this sits beside other controls on a phone, where 40px is still
        // comfortably above the 24px minimum target and 48px would push the
        // primary punches onto a second line.
        className={cn('shrink-0', className)}
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <MoreHorizontal size={20} aria-hidden />
      </Button>

      <Sheet open={open} onClose={() => setOpen(false)} title={label}>
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                disabled={item.disabled}
                data-testid={item.testId}
                onClick={() => {
                  // Close FIRST, then record the intent: the confirmation the
                  // page raises must own the screen, not compete with a sheet
                  // that is still on its way out.
                  setOpen(false)
                  item.onClick()
                }}
                className={cn(
                  // `min-h-12` is the same 48px floor the desktop table action
                  // uses, so a control is never easier to hit on a phone than
                  // it is on a desktop — the opposite of the usual mobile trap.
                  'flex min-h-12 w-full items-center gap-3 rounded-md px-3 py-2.5 text-start text-base font-medium transition-colors',
                  'disabled:pointer-events-none disabled:text-foreground-disabled disabled:opacity-70',
                  MENU_TONE[item.tone ?? 'info'],
                )}
              >
                <span className="shrink-0 [&_svg]:size-5">{item.icon}</span>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </Sheet>
    </>
  )
}
