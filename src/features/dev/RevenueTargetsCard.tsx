/**
 * The monthly revenue targets — the two independent cafe/wash figures, and the
 * ACTIVE month's own override of either of them.
 *
 * THE SCREEN'S ONE IDEA: a default is a number every month follows, and an
 * override is a number ONE month keeps. So the card never presents two editable
 * boxes that look like peers and leave the reader guessing which one is in
 * force. It presents, in order:
 *
 *  1. the two DEFAULTS, with their own save — these change future months, and
 *     cannot touch a month that already overrides them;
 *  2. the ACTIVE month, named by the month the BACKEND resolved, with one field
 *     per department. A field left EMPTY means "follow the default", and the
 *     badge beside it says which of the two it currently is — never a second box
 *     pre-filled with a copy of the default.
 *
 * The override saves PER DEPARTMENT, because clearing one must not require
 * retyping the other: an empty field clears that department's override and
 * leaves the other department's alone. That is the reason overrides are stored
 * per department, and the UI mirrors the storage instead of flattening it into
 * one form that could overwrite a sibling.
 *
 * Amounts are whole pounds. The field refuses a decimal, a sign and a letter at
 * the keystroke — the same rule the other Dev Settings money lists use — and the
 * backend re-validates independently, because hiding a control is not
 * validation.
 */
import { useCallback, useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Card, CardHeader, Field, Input } from '@/components/ui'
import { Gauge, Save } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { formatMonthKey } from '@/lib/date'
import { useErrText } from '@/lib/err'
import { MINOR_PER_MAJOR } from '@/lib/utils'
import { settingsApi, type RevenueDepartment, type RevenueTargetsView } from '@/services/posApi'
import { acceptAmountDraft, isAllowedAmountKey } from './amountListRules'

/** The two departments, in the order the card presents them. */
const DEPARTMENTS: RevenueDepartment[] = ['CAFE', 'WASH']

/** Whole pounds a field states, as piastres — Station's money unit. */
function toMinor(pounds: string): number | null {
  if (!/^\d+$/.test(pounds)) return null
  const value = Number.parseInt(pounds, 10)
  return Number.isSafeInteger(value) ? value * MINOR_PER_MAJOR : null
}

/** The draft text for a stored amount: whole pounds, never piastres. */
function toDraft(amountMinor: number): string {
  return String(Math.round(amountMinor / MINOR_PER_MAJOR))
}

/** The draft state: what the owner has typed, which may differ from what is saved. */
type Drafts = Record<RevenueDepartment, string>

export function RevenueTargetsCard() {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)

  const [view, setView] = useState<RevenueTargetsView | null>(null)
  const [defaults, setDefaults] = useState<Drafts>(EMPTY_DRAFTS)
  const [overrides, setOverrides] = useState<Drafts>(EMPTY_DRAFTS)
  const [busy, setBusy] = useState<'defaults' | RevenueDepartment | null>(null)

  /**
   * Re-reads the group and re-bases both drafts on it.
   *
   * Re-basing after every save is what keeps the screen honest: the fields show
   * what was STORED, so a value the backend refused cannot sit on screen looking
   * saved, and a cleared override really does read as empty afterwards.
   */
  const load = useCallback(async () => {
    const next = await settingsApi.revenueTargets()
    setView(next)
    setDefaults({
      CAFE: toDraft(next.defaults.cafe_minor),
      WASH: toDraft(next.defaults.wash_minor),
    })
    // An absent override shows as an EMPTY field, which is the honest state:
    // there is no number of its own — it is following the default.
    setOverrides({
      CAFE: next.overrides.cafe_minor === null ? '' : toDraft(next.overrides.cafe_minor),
      WASH: next.overrides.wash_minor === null ? '' : toDraft(next.overrides.wash_minor),
    })
  }, [])

  useEffect(() => {
    // Reading the stored configuration from the backend on mount — an external
    // system, synchronised once. The same pattern `DevSettingsPage` and
    // `useSalesData` use for their initial reads.
    // oxlint-disable-next-line react/set-state-in-effect -- external async read.
    void load().catch((error: unknown) => toast(errText(error), 'error'))
  }, [load, toast, errText])

  if (!view) return null

  const defaultsChanged =
    toMinor(defaults.CAFE) !== view.defaults.cafe_minor ||
    toMinor(defaults.WASH) !== view.defaults.wash_minor

  /** Saves the cafe-wide defaults. It never touches any month's override. */
  async function saveDefaults() {
    const cafe = toMinor(defaults.CAFE)
    const wash = toMinor(defaults.WASH)
    // The field already refuses non-digits, so this only catches an EMPTY draft.
    if (cafe === null || wash === null) {
      toast(t('errors.settings.invalid_revenue_target'), 'error')
      return
    }
    setBusy('defaults')
    try {
      await settingsApi.setRevenueTargets({ cafe_minor: cafe, wash_minor: wash })
      toast(t('dev.revenueTargetsDefaultsSaved'), 'success')
      await load()
    } catch (error) {
      toast(errText(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  /**
   * Clearing one override sends an explicit `null` for that department alone,
   * which is what returns the month to the default without disturbing the other.
   */
  async function saveOverride(department: RevenueDepartment, argument?: number | null) {
    // The draft is read from the argument, not from state: clearing empties the
    // field and calls this in the same event, so state is still the old value
    // here. Passing the intended value keeps "clear" one action instead of two.
    const stored = argument ?? null
    setBusy(department)
    try {
      await settingsApi.setRevenueTargetOverride(department, stored)
      toast(
        stored === null
          ? t('dev.revenueTargetsOverrideCleared')
          : t('dev.revenueTargetsOverrideSaved'),
        'success',
      )
      // Re-read so the fields show what was STORED: a cleared override really
      // does come back empty, and a saved one shows the new number.
      await load()
    } catch (error) {
      toast(errText(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const month = formatMonthKey(view.month, i18n.language)
  return (
    <Card data-testid="dev-revenue-targets">
      <CardHeader
        title={t('dev.revenueTargetsTitle')}
        subtitle={t('dev.revenueTargetsDescription')}
      />

      <div className="flex flex-col gap-6">
        {/* 1. The DEFAULTS — what every month without an override follows. */}
        <section className="flex flex-col gap-3">
          <h3 className="flex items-center gap-2 font-bold text-foreground">
            <Gauge size={16} aria-hidden />
            {t('dev.revenueTargetsDefaultsTitle')}
          </h3>
          <p className="text-sm text-foreground-muted">{t('dev.revenueTargetsDefaultsHelp')}</p>

          <div className="grid gap-4 md:grid-cols-2">
            {DEPARTMENTS.map((department) => (
              <Field
                key={department}
                label={revenueTargetsDefaultLabel(t, department)}
                hint={t('dev.revenueTargetsAmountHint')}
              >
                <Input
                  aria-label={revenueTargetsDefaultLabel(t, department)}
                  value={defaults[department]}
                  inputMode="numeric"
                  step={1}
                  onKeyDown={(event) => {
                    if (!isAllowedAmountKey(event.key)) event.preventDefault()
                  }}
                  onChange={(event) =>
                    setDefaults((current) => ({
                      ...current,
                      [department]: acceptAmountDraft(event.target.value) ?? current[department],
                    }))
                  }
                />
              </Field>
            ))}
          </div>

          <Button
            className="self-start"
            disabled={!defaultsChanged}
            loading={busy === 'defaults'}
            onClick={() => void saveDefaults()}
          >
            <Save size={16} aria-hidden />
            {t('app.save')}
          </Button>
        </section>

        {/* 2. The ACTIVE month's own override, one field per department. */}
        <section className="flex flex-col gap-3 border-t border-border pt-6">
          <h3 className="font-bold text-foreground">
            {t('dev.revenueTargetsOverrideTitle', { month })}
          </h3>
          <p className="text-sm text-foreground-muted">{t('dev.revenueTargetsOverrideHelp')}</p>

          <div className="grid gap-4 md:grid-cols-2">
            {DEPARTMENTS.map((department) => {
              const effective = view.targets.find((target) => target.department === department)
              const defaultMinor =
                department === 'CAFE' ? view.defaults.cafe_minor : view.defaults.wash_minor
              return (
                <OverrideField
                  key={department}
                  department={department}
                  label={t(`catalog.${department}`)}
                  value={overrides[department]}
                  placeholder={toDraft(defaultMinor)}
                  overridden={effective?.overridden ?? false}
                  defaultLabel={revenueTargetsDefaultLabel(t, department)}
                  busy={busy === department}
                  onChange={(next) =>
                    setOverrides((current) => ({ ...current, [department]: next }))
                  }
                  onSave={() => {
                    // An EMPTY field is the instruction to clear: the card holds
                    // no number of its own, so the month goes back to the
                    // default for this department only.
                    const draft = overrides[department].trim()
                    void saveOverride(department, draft === '' ? null : toMinor(draft))
                  }}
                  onClear={() => {
                    setOverrides((current) => ({ ...current, [department]: '' }))
                    void saveOverride(department, null)
                  }}
                />
              )
            })}
          </div>
        </section>
      </div>
    </Card>
  )
}

/** The one label a department's field carries in both sections. */
function revenueTargetsDefaultLabel(t: TFunction, department: RevenueDepartment): string {
  return t(`dev.revenueTargets${department === 'CAFE' ? 'Cafe' : 'Wash'}Default`)
}
/**
 * One department's override field.
 *
 * The badge answers "which number is in force for this month?", and it is derived
 * from the BACKEND's `overridden` flag rather than from whether the field happens
 * to be empty — so a cleared override reads as "following the default" straight
 * away instead of leaving a stale number on screen looking saved.
 *
 * The clear action is offered exactly when there IS an override to remove: an
 * empty field has nothing to clear, and a button that would do nothing sits next
 * to the one that matters.
 */
function OverrideField({
  department,
  label,
  value,
  placeholder,
  overridden,
  defaultLabel,
  busy,
  onChange,
  onSave,
  onClear,
}: {
  readonly department: RevenueDepartment
  readonly label: string
  readonly value: string
  /** The DEFAULT's value in whole pounds, shown as the empty field's hint. */
  readonly placeholder: string
  readonly overridden: boolean
  readonly defaultLabel: string
  readonly busy: boolean
  readonly onChange: (next: string) => void
  readonly onSave: () => void
  readonly onClear: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border-subtle p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-base font-bold text-foreground-muted">{label}</span>
        {overridden ? (
          <Badge variant="info" size="sm" data-testid={`override-badge-${department}`}>
            {t('dev.revenueTargetsOverriddenForMonth')}
          </Badge>
        ) : (
          <Badge variant="neutral" size="sm" data-testid={`override-badge-${department}`}>
            {t('dev.revenueTargetsFollowingDefault')}
          </Badge>
        )}
      </div>

      <Field label={defaultLabel} hint={t('dev.revenueTargetsOverrideFieldHint')}>
        <Input
          aria-label={defaultLabel}
          value={value}
          placeholder={placeholder}
          inputMode="numeric"
          step={1}
          onKeyDown={(event) => {
            if (!isAllowedAmountKey(event.key)) event.preventDefault()
          }}
          onChange={(event) => {
            const next = acceptAmountDraft(event.target.value)
            if (next !== null) onChange(next)
          }}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" loading={busy} onClick={onSave}>
          <Save size={14} aria-hidden />
          {t('app.save')}
        </Button>
        {overridden ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={t('dev.revenueTargetsClearOverride')}
            onClick={onClear}
          >
            {t('dev.revenueTargetsClearOverride')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
const EMPTY_DRAFTS: Drafts = { CAFE: '', WASH: '' }
