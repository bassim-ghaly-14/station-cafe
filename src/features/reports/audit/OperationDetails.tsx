import { useTranslation } from 'react-i18next'
import { Dialog, DisplayDateTime, EmployeeAvatar } from '@/components/ui'
import type { AuditEntry } from '@/services/opsApi'
import { OperationTypeBadge } from './OperationTypeBadge'
import { actionLabel, entityLabel } from './useOperationHistory'

/**
 * OperationDetails — the detail view of one recorded operation.
 *
 * Everything rendered here is a field the log actually stores: the action, the
 * operation type derived from it, the actor and their role, the timestamp, the
 * affected entity and its id, the record id, and the recorded payload. There is
 * no amount, no status and no approval trail, because the log does not contain
 * them — an invented field would be worse than an absent one.
 *
 * The payload (`after_json`) is shown as the raw snapshot the backend wrote,
 * pretty-printed and LTR-isolated. It is a stored technical artefact rather than
 * a business label, so it is presented as data in a code block rather than
 * dressed up as interface text or translated into something it is not.
 */
export function OperationDetails({ entry, onClose }: { entry: AuditEntry; onClose: () => void }) {
  const { t } = useTranslation()
  const snapshot = formatSnapshot(entry.after_json)

  return (
    <Dialog open onClose={onClose} title={t('audit.details.title')} className="max-w-lg">
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <OperationTypeBadge action={entry.action} size="md" />
          <p className="text-section min-w-0 text-balance">{actionLabel(t, entry.action)}</p>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3">
          <Field label={t('audit.details.type')}>
            <OperationTypeBadge action={entry.action} />
          </Field>

          <Field label={t('audit.details.actor')}>
            {entry.actor_name ? (
              <span className="flex min-w-0 items-center gap-2">
                <EmployeeAvatar role={entry.actor_role} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate">{entry.actor_name}</span>
                  {entry.actor_role ? (
                    <span className="block text-caption">{t(`roles.${entry.actor_role}`)}</span>
                  ) : null}
                </span>
              </span>
            ) : (
              <Dash />
            )}
          </Field>

          <Field label={t('audit.details.time')}>
            <DisplayDateTime value={entry.created_at} className="text-base" />
          </Field>

          <Field label={t('audit.details.entity')}>
            <span className="block">{entityLabel(t, entry.entity_type)}</span>
            {entry.entity_id ? (
              <span className="block text-caption tabular-nums" dir="ltr">
                {t('audit.details.reference')} #{entry.entity_id}
              </span>
            ) : null}
          </Field>

          <Field label={t('audit.details.record')}>
            <span className="tabular-nums" dir="ltr">
              {entry.id}
            </span>
          </Field>
        </dl>

        <section className="flex flex-col gap-2">
          <h3 className="text-caption font-bold">{t('audit.details.snapshot')}</h3>
          {snapshot ? (
            <pre
              dir="ltr"
              className="max-h-52 overflow-auto rounded-md border border-border-subtle bg-surface-muted p-3 text-start text-xs leading-relaxed text-foreground-muted"
            >
              {snapshot}
            </pre>
          ) : (
            <p className="text-caption">{t('audit.details.snapshotEmpty')}</p>
          )}
        </section>
      </div>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-caption font-bold">{label}</dt>
      <dd className="min-w-0 text-base text-foreground">{children}</dd>
    </>
  )
}

function Dash() {
  return <span className="text-foreground-faint">—</span>
}

/**
 * Pretty-print the stored payload when it parses, and fall back to the raw text
 * when it does not. A payload that cannot be parsed is still shown — hiding a
 * recorded value because of a formatting problem would lose information.
 */
function formatSnapshot(raw: string | null): string {
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
