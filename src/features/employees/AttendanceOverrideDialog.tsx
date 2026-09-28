/**
 * تعديل حضور الموظف — the MANAGER/ADMIN administrative correction.
 *
 * It reuses the primitives the employees surface already has: the shared
 * `Dialog`, the `Field` / `Input` / `Textarea` form controls, the shared
 * `Button`, a Lucide glyph from the project's icon barrel, and the toast. There
 * is no `alert()`, no `confirm()`, no bespoke modal and no new page.
 *
 * What it deliberately does NOT do
 * --------------------------------
 * It does not round. A normal punch is rounded by the Rust service; this dialog
 * sends the wall clock the manager typed and the backend stores it verbatim, so
 * a form that "helpfully" snapped 08:07 to 08:10 would be re-introducing the
 * rule the manager is explicitly correcting. The only rule the form enforces
 * itself is the ordering one the service also enforces (a check-out may not
 * precede its check-in), and it states the current value of both sides before
 * anything is edited.
 *
 * Mounting this dialog IS the role gate, and the button that mounts it is only
 * rendered for a MANAGER/ADMIN session. That is an affordance, not a boundary:
 * `employees::override_attendance` refuses a STAFF session server-side whatever
 * this component shows.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, Field, Input, Textarea, useToast } from '@/components/ui'
import { DisplayDate, DisplayTime } from '@/components/ui/display-datetime'
import { CalendarClock } from '@/components/ui/icon'
import { useErrText } from '@/lib/err'
import { employeesApi } from '@/services/employeesApi'
import type { AttendanceDay } from '@/services/employeesApi'
import { overrideDraftError, overrideDraftOf, overrideTimesOf } from './attendance'
import type { OverrideDraft, OverrideDraftError } from './attendance'

/** One side of the pair: the value on record, and the one being stated. */
function OverrideField({
  id,
  label,
  current,
  value,
  onChange,
  required,
  autoFocus,
}: {
  readonly id: string
  readonly label: string
  /** The stored EFFECTIVE instant, shown verbatim before anything is edited. */
  readonly current: string | null
  readonly value: string
  readonly onChange: (value: string) => void
  readonly required?: boolean
  readonly autoFocus?: boolean
}) {
  const { t } = useTranslation()
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex min-w-20 flex-col text-caption text-foreground-subtle">
          <span>{t('employees.override.current')}</span>
          <span className="font-bold tabular-nums text-foreground">
            {current ? <DisplayTime value={current} /> : '—'}
          </span>
        </span>
        <span aria-hidden="true" className="select-none text-foreground-faint">
          ←
        </span>
        <Input
          id={id}
          type="time"
          dir="ltr"
          className="w-32"
          value={value}
          required={required}
          data-dialog-autofocus={autoFocus || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </Field>
  )
}

export function AttendanceOverrideDialog({
  day,
  onClose,
  onSaved,
}: {
  /**
   * The day being corrected.
   *
   * Required rather than nullable: the parent mounts this dialog only while a
   * day is selected, so the draft is seeded once, from that day, and can never
   * drift when a different one is opened.
   */
  readonly day: AttendanceDay
  readonly onClose: () => void
  /** Called after the service accepted the correction, so the caller refreshes. */
  readonly onSaved: () => void
}) {
  const { t } = useTranslation()
  const errText = useErrText(t)
  const toast = useToast()
  // The draft the dialog opened with. It is the "unchanged" reference AND the
  // source of the CURRENT values shown beside each field, so the two can never
  // be read from different places.
  const [original] = useState<OverrideDraft>(() => overrideDraftOf(day))
  const [draft, setDraft] = useState<OverrideDraft>(original)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const error = useMemo(() => overrideDraftError(draft, original), [draft, original])

  async function submit() {
    if (error) return
    setBusy(true)
    try {
      await employeesApi.overrideAttendance(day.employee_id, day.business_date, {
        ...overrideTimesOf(draft, original),
        reason,
      })
      toast(t('employees.override.saved'), 'success')
      onSaved()
      onClose()
    } catch (cause) {
      toast(errText(cause), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={t('employees.override.title')}>
      <div className="flex flex-col gap-4">
        <p className="flex items-center gap-2 text-caption text-foreground-subtle">
          <CalendarClock size={16} aria-hidden />
          <DisplayDate value={day.business_date} />
        </p>

        {/* The administrative nature is stated ABOVE the fields, not in a buried
            warning: this writes to a record other people are paid from, and the
            fact that it skips the automatic rounding is the part a manager needs
            to know before typing. */}
        <p className="text-caption text-foreground-muted">{t('employees.override.adminNote')}</p>

        <OverrideField
          id="attendance-override-check-in"
          label={t('employees.override.checkIn')}
          current={day.check_in_effective_at}
          value={draft.checkIn}
          required
          autoFocus
          onChange={(checkIn) => setDraft({ ...draft, checkIn })}
        />
        <OverrideField
          id="attendance-override-check-out"
          label={t('employees.override.checkOut')}
          current={day.check_out_effective_at}
          value={draft.checkOut}
          onChange={(checkOut) => setDraft({ ...draft, checkOut })}
        />

        <Field
          label={t('employees.override.reason')}
          hint={t('employees.override.reasonHint')}
          htmlFor="attendance-override-reason"
        >
          <Textarea
            id="attendance-override-reason"
            value={reason}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>

        <OverrideError error={error} />

        <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('app.cancel')}
          </Button>
          <Button
            onClick={submit}
            loading={busy}
            // The dialog's own guard: an invalid or unchanged pair is not
            // offered, so the service is never asked to refuse one. The service
            // still re-checks it all — this only avoids a pointless refusal.
            disabled={error !== null}
          >
            {t('employees.override.confirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/**
 * The draft's complaint, in the two registers the form distinguishes.
 *
 * `unchanged` is not an error at all: nothing was wrong, the manager simply
 * has not changed anything yet, so it is stated quietly and is NOT announced as
 * an alert. The two genuine problems are announced, because they need acting on.
 */
function OverrideError({ error }: Readonly<{ readonly error: OverrideDraftError | null }>) {
  const { t } = useTranslation()
  if (error === null) return null
  if (error === 'unchanged') {
    return (
      <p className="text-caption text-foreground-subtle">{t('employees.override.unchanged')}</p>
    )
  }
  return (
    <p role="alert" className="text-caption text-destructive">
      {t(`employees.override.${error}`)}
    </p>
  )
}
