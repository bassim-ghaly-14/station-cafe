/**
 * The POS starting state: no shift is open, so this is the FIRST thing a
 * cashier sees on a cold till. It is a starting state, not a form that happens
 * to be on the page — so it is presented like one.
 *
 * Hierarchy, top to bottom, and why it is this order:
 *
 *  1. the POS context and the shift status — the page header's own words;
 *  2. the empty-shift state, as the card's heading and identity mark, so the
 *     state is announced by the card rather than only by a caption above it;
 *  3. the instruction — what to do about it, in the card's own header;
 *  4. the opening balance — the one value the cashier must supply;
 *  5. the single primary action.
 *
 * Layout
 * ------
 * The block is `mx-auto w-full max-w-md` and is vertically settled by its PARENT
 * (`PosShiftGateView`). Previously the form was `max-w-sm` with no `mx-auto`, so
 * at 1280px it hugged the inline-start edge of the workspace and read as a form
 * floating in a corner rather than as a deliberate starting state. Centring it
 * with the same `max-w-*` idiom the login screen already uses keeps the two
 * entry screens of the application consistent.
 *
 * Every card in this family — shift closing, day closing, the already-open-shift
 * card — is built on `ClosingCardShell`'s rhythm: a coloured identity rail, a
 * header row, a body and a footer. This card borrows that rail so that opening a
 * shift looks like the same object as closing one, without becoming a closing
 * card or introducing a nested card.
 *
 * Nothing here changes what the gate DOES. `parseMajor`, `shift.invalidCash`,
 * `shiftApi.openShift`, the one-open-shift branch to `OpenShiftCard`, and
 * `onReady` are all exactly as they were; this file's only edit is presentation.
 */
/** Shift/day gate: guide staff to open them instead of blocking silently. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, useToast } from '@/components/ui'
import { Power } from '@/components/ui/icon'
import { Field, Input } from '@/components/ui/input'
import { atLeast, useSession } from '@/features/auth/useSession'
import { shiftApi, type DayShiftState } from '@/services/shiftApi'
import { parseMajor } from '@/lib/utils'
import { ManagedCloseShiftDialog } from './ManagedCloseShiftDialog'
import { OpenShiftCard } from './OpenShiftCard'

export function ShiftGate({
  state,
  onReady,
  onShiftClosed,
}: Readonly<{
  readonly state: DayShiftState
  onReady: () => void
  /**
   * Called after a MANAGER's on-behalf close commits, so the page re-reads the
   * shift/day state. Optional because the gate is also rendered standalone.
   */
  onShiftClosed?: () => void | Promise<void>
}>) {
  const { t } = useTranslation()
  const { user } = useSession()
  const toast = useToast()
  const [opening, setOpening] = useState(false)
  const [cash, setCash] = useState('')
  const [cashError, setCashError] = useState<string | null>(null)
  const [managing, setManaging] = useState(false)

  /**
   * Whether the managerial close action is OFFERED. Presentation only — every
   * command behind the dialog re-checks the role in the backend, so a STAFF
   * session that forced this flag would still be refused server-side.
   */
  const canManageClose = atLeast(user?.role, 'MANAGER')

  // A shift is open and it is not the caller's: the one-open-shift rule blocks
  // opening another, so the gate explains the state instead of offering an
  // action the backend would refuse. `open_shift` is the same read the service
  // enforces the rule from, so the card cannot disagree with the database.
  if (state.open_shift && !state.my_shift) {
    return (
      <>
        <OpenShiftCard
          shift={state.open_shift}
          onManageClose={canManageClose ? () => setManaging(true) : undefined}
        />
        {managing ? (
          <ManagedCloseShiftDialog
            shift={state.open_shift}
            onClose={() => setManaging(false)}
            onClosed={async () => {
              setManaging(false)
              await onShiftClosed?.()
            }}
          />
        ) : null}
      </>
    )
  }

  async function start() {
    setOpening(true)
    setCashError(null)
    try {
      const cashMinor =
        cash.trim() === ''
          ? 0
          : (parseMajor(cash) ??
            (() => {
              setCashError(t('shift.invalidCash'))
              throw new Error('bad-input')
            })())
      await shiftApi.openShift(cashMinor)
      onReady()
    } catch (e) {
      if ((e as Error).message !== 'bad-input') {
        toast(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']), 'error')
      }
    } finally {
      setOpening(false)
    }
  }

  return (
    // Centred in the POS workspace, with the same comfortable measure the login
    // screen uses for its own single-purpose card. `w-full` + the shell's own
    // `p-3` on a phone means the card uses the full width with sensible side
    // padding and never overflows horizontally; `mx-auto` is what actually
    // centres it, which `max-w-sm` alone did not do before.
    <div className="mx-auto w-full max-w-md">
      <Card className="w-full overflow-hidden p-0">
        {/* Identity rail: the one place the card kind is announced visually, and
          the same `shift` accent the closing and already-open cards use.
          `p-0` + `overflow-hidden` on the card is what lets it sit flush at the
          top edge, exactly as `ClosingCardShell` does it. */}
        <span aria-hidden className="block h-1 w-full shrink-0 bg-closing-shift-soft" />

        {/* The header row. `text-section` is the heading step this app already uses
          for a card title (the closing cards), so the empty state reads as the
          card's SUBJECT rather than as one more caption — while keeping the page
          `h1` → card `h2` order that `CardHeader` already produced. */}
        <div className="flex items-center gap-2.5 border-b border-border-subtle px-5 py-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-closing-shift-soft text-closing-shift">
            <Power size={18} aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-section">{t('pos.shiftRequired')}</h2>
            <p className="mt-0.5 text-caption text-foreground-subtle">
              {t('pos.shiftRequiredHint')}
            </p>
          </div>
        </div>

        {/* The body. Centred because every line in it is short and the reader's eye
          should land on the one action, not scan a column. */}
        <div className="flex flex-col items-center gap-5 px-5 py-6 text-center sm:px-6">
          {/* The opening balance is the ONLY thing a cashier has to supply, so it is
            the one control on the card. `Field` keeps its generated
            `id`/`<label for>` association, so the accessible name is unchanged;
            `h-12` raises the target from 40px to 48px for a phone in one hand. */}
          <div className="w-full">
            <Field label={t('shift.openingCash')} error={cashError}>
              <Input
                dir="ltr"
                inputMode="decimal"
                value={cash}
                onChange={(e) => setCash(e.target.value)}
                placeholder="0.00"
                disabled={opening}
                className="h-12 text-center text-lg"
              />
            </Field>
          </div>

          {/* The single primary action. Full width at every size, because there is
            exactly one of them and nothing competes for the row — the same
            "below `sm` a column flex container stretches to full width"
            behaviour `DialogActions` relies on, with no per-breakpoint class.
            `disabled`/`loading` are the existing states, untouched. */}
          <Button
            size="lg"
            disabled={opening}
            loading={opening}
            onClick={() => void start()}
            className="w-full bg-success-solid text-success-solid-foreground hover:bg-success-solid-hover active:bg-success-solid-active"
          >
            {!opening ? <Power size={20} aria-hidden /> : null}
            {t('shift.openShift')}
          </Button>
        </div>
      </Card>
    </div>
  )
}
