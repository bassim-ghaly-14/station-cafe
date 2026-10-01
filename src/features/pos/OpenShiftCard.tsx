/**
 * The POS card for an already-open shift.
 *
 * Station allows exactly ONE open shift at a time, so "a shift is open and the
 * person in front of the POS does not own it" is a normal operational state, not
 * a failure. It is presented as such: the same card family as the shift and day
 * closing cards (shared `ClosingCardShell` chrome, the `shift` accent family),
 * stating three facts in a fixed hierarchy —
 *
 *   1. a shift is open right now;
 *   2. WHO opened it, read dynamically from the backend's open-shift row;
 *   3. the rule that follows: no second shift can be opened until this one is
 *      closed.
 *
 * Every value is read from the shift the backend reports. There is no local
 * "is a shift open" state here, so this card cannot disagree with the rule the
 * service enforces, and the cashier name is never hardcoded or taken from the
 * logged-in session.
 */
import { useTranslation } from 'react-i18next'
import { Badge, EmployeeAvatar } from '@/components/ui'
import { DisplayDateTime } from '@/components/ui/display-datetime'
import { Clock, Lock } from '@/components/ui/icon'
import type { ShiftRow } from '@/services/shiftApi'
import { ClosingCardShell } from './ClosingCard'

export function OpenShiftCard({ shift }: Readonly<{ readonly shift: ShiftRow }>) {
  const { t } = useTranslation()
  const cashier = shift.user_name ?? t('pos.unknownCashier')
  return (
    <ClosingCardShell
      accent="shift"
      title={t('shift.alreadyOpenTitle')}
      icon={<Clock size={18} aria-hidden />}
      status={
        <Badge variant="success" size="sm" dot>
          {t('shift.open')}
        </Badge>
      }
      meta={
        <>
          <span className="flex min-w-0 items-center gap-1.5">
            <EmployeeAvatar role={shift.user_role} size="sm" />
            {/* The employee who opened THIS shift, exactly as the backend
                recorded it — never the person currently logged in. */}
            <span className="truncate">{cashier}</span>
          </span>
          <span className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <Clock size={14} aria-hidden className="shrink-0" />
            <DisplayDateTime value={shift.opened_at} />
          </span>
        </>
      }
      headerAction={
        <span className="hidden text-xs font-medium text-foreground-subtle sm:block">
          #{shift.id}
        </span>
      }
      footerNote={<p className="max-w-sm text-caption">{t('shift.alreadyOpenHint')}</p>}
      action={
        <span className="flex items-center gap-1.5 text-sm font-medium text-closing-shift-foreground">
          <Lock size={16} aria-hidden />
          {t('shift.alreadyOpenBlocked')}
        </span>
      }
    >
      {/* The cashier is the one fact that matters here, so it is stated as the
          card's focal line rather than as quiet header metadata. */}
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-foreground-muted">{t('shift.cashier')}</span>
        <span className="text-2xl font-bold tracking-tight text-foreground-strong">{cashier}</span>
      </p>
    </ClosingCardShell>
  )
}
