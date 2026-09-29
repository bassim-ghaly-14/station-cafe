/**
 * Printer configuration — the MANAGER+ form over the existing
 * `set_print_config` command.
 *
 * It exists for one operational reason: the printing service reads its target
 * from the `printer` setting, and until that setting is written it refuses every
 * print with `printer.not_configured`. Nothing in the application could write
 * it, so a printer could not be set up from the UI at all.
 *
 * It is deliberately a thin form over the existing command:
 *
 * - No new business rule and no new field. Every value it sends is already part
 *   of `PrintConfig`; the backend validates and audits the write, and the same
 *   MANAGER+ role check applies on both transports.
 * - The target is sent EXACTLY as typed. Interpreting a queue name is the
 *   printing service's job, not the form's, so the form can never disagree with
 *   what the desktop does with the same value.
 * - It renders nothing for a caller below MANAGER, so a cashier never sees a
 *   control the backend would refuse. Authorization is still enforced in Rust:
 *   this is presentation, not a gate.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useOptionalSession } from '@/features/auth/useSession'
import { Card, CardHeader, Field, Input, Select, Switch } from '@/components/ui'
import { useToast } from '@/components/ui/toast'
import { useErrText } from '@/lib/err'
import { roleRank } from '@/lib/roles'
import { opsApi, type PrintConfig } from '@/services/opsApi'

/** Codepage index range the ESC/POS encoder accepts. */
const CODEPAGE_MIN = 0
const CODEPAGE_MAX = 255

export function PrinterSettings({
  config,
  onChanged,
}: Readonly<{
  readonly config: PrintConfig
  /** The value the form now holds, so the panel's own state never disagrees. */
  readonly onChanged: (next: PrintConfig) => void
}>) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const session = useOptionalSession()
  const [saving, setSaving] = useState(false)
  // The edit in progress, kept here until it is FINISHED. A printer name is
  // typed character by character, and writing each keystroke to the database
  // would make a half-typed name the live setting — and would make "only save
  // what changed" impossible, because the parent already holds the keystrokes.
  const [draft, setDraft] = useState<PrintConfig>(config)
  // The stored configuration is the truth: whenever it changes underneath this
  // form (a successful save, a reload), the draft follows it.
  useEffect(() => setDraft(config), [config])

  // Hooks run before this guard on every render, so returning early is safe.
  // A missing session is the safe default: nothing is claimed about a screen
  // whose role cannot be resolved.
  if (!session || roleRank(session.user?.role) < roleRank('MANAGER')) return null

  /** Persist one finished change through the existing command. */
  async function save(overrides: Partial<PrintConfig>) {
    const next = { ...draft, ...overrides }
    setSaving(true)
    try {
      await opsApi.setPrintConfig(next)
      onChanged(next)
      toast(t('print.settings.saved'), 'success')
    } catch (e) {
      // The draft is rolled back to what is actually stored, so a refused write
      // can never sit on screen looking like the printer's real setting.
      setDraft(config)
      toast(errText(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  /** Commit a finished edit — and do nothing at all if it changed nothing. */
  function commit<K extends keyof PrintConfig>(key: K, value: PrintConfig[K]) {
    // Compared against what is STORED, not against the draft: the draft already
    // holds these keystrokes, so comparing with it would make every edit a
    // no-op and nothing would ever be saved.
    if (config[key] === value) return
    void save({ [key]: value } as Partial<PrintConfig>)
  }

  return (
    <Card>
      <CardHeader title={t('print.settings.title')} subtitle={t('print.settings.subtitle')} />
      <div className="flex flex-col gap-4">
        <Field label={t('print.settings.target')} hint={t('print.settings.targetHint')}>
          <Input
            value={draft.target}
            dir="ltr"
            spellCheck={false}
            placeholder={t('print.settings.targetPlaceholder')}
            onChange={(e) => setDraft({ ...draft, target: e.target.value })}
            onBlur={(e) => commit('target', e.target.value)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('print.settings.arabicMode')}>
            {/* A select has no half-typed state: a choice IS a finished edit. */}
            <Select
              value={draft.arabic_mode}
              onChange={(e) => setDraft({ ...draft, arabic_mode: e.target.value })}
              onBlur={(e) => commit('arabic_mode', e.target.value)}
            >
              <option value="CP1256">{t('print.settings.arabicCp1256')}</option>
              <option value="LATIN">{t('print.settings.arabicLatin')}</option>
            </Select>
          </Field>

          <Field label={t('print.settings.codepage')}>
            <Input
              type="number"
              inputMode="numeric"
              min={CODEPAGE_MIN}
              max={CODEPAGE_MAX}
              value={draft.codepage}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  codepage: clamp(Number(e.target.value), CODEPAGE_MIN, CODEPAGE_MAX),
                })
              }
              onBlur={(e) =>
                commit('codepage', clamp(Number(e.target.value), CODEPAGE_MIN, CODEPAGE_MAX))
              }
            />
          </Field>
        </div>

        <Field label={t('print.settings.duplicateWindow')} hint={t('print.settings.duplicateHint')}>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            value={draft.duplicate_window_secs}
            onChange={(e) =>
              setDraft({ ...draft, duplicate_window_secs: seconds(Number(e.target.value)) })
            }
            onBlur={(e) => commit('duplicate_window_secs', seconds(Number(e.target.value)))}
          />
        </Field>

        <Switch
          checked={draft.logo}
          label={t('print.settings.logo')}
          tone="state"
          // A toggle has no half-typed state: flipping it IS the decision, so
          // it is written straight away. Any target edit in progress is finished
          // by the blur that the click itself causes, before this runs.
          onCheckedChange={(logo) => void save({ logo })}
        />

        {saving ? (
          <p className="text-caption" role="status">
            {t('print.settings.saving')}
          </p>
        ) : null}
      </div>
    </Card>
  )
}

/** Keep a typed number inside the range the encoder accepts. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** A duplicate window in whole seconds; 0 disables the guard entirely. */
function seconds(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}
