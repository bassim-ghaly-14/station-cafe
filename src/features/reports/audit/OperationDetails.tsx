import { useTranslation } from 'react-i18next'
import { Dialog, DisplayDateTime, EmployeeAvatar } from '@/components/ui'
import type { AuditEntry } from '@/services/opsApi'
import { OperationTypeBadge } from './OperationTypeBadge'
import {
  actionLabel,
  entityLabel,
  operationGroupLabelKey,
  operationGroupOf,
} from './operationTypes'
import {
  businessDetails,
  operationSummary,
  technicalSnapshot,
  type AuditTranslate,
} from './operationPresentation'

/**
 * OperationDetails — the detail view of ONE recorded operation, for two
 * audiences from the same record.
 *
 * Structure, top to bottom:
 *   1. ملخص العملية — the operation's name and one plain sentence saying what
 *      was done, so the first thing anyone reads is already understandable;
 *   2. التفاصيل — who, when, which area, which element, plus the business
 *      values derived from the stored payload (invoice number, total, payment
 *      method, salary, …) or a safe sentence when the record carries none;
 *   3. المعلومات التقنية — ADMIN ONLY: the stored action/entity codes, the
 *      internal references and the raw payload, visually separated from the
 *      business information above.
 *
 * The split is a real gate, not a styling trick: MANAGER never receives the
 * technical section, so no raw JSON, no stored code and no internal id can be
 * read out of this component at all. Nothing shown above it is invented — every
 * value comes from a field the log actually stores, and a delete (whose business
 * values live in `before_json`, which the log read does not expose) degrades to
 * the safe sentence instead of a fake summary.
 */
export function OperationDetails({
  entry,
  onClose,
  canViewTechnical = false,
}: {
  entry: AuditEntry
  onClose: () => void
  /** ADMIN only: adds the technical section with the raw payload. */
  canViewTechnical?: boolean
}) {
  const { t } = useTranslation()
  const tr: AuditTranslate = (key, options) => (options ? t(key, options) : t(key))
  const details = businessDetails(tr, entry)
  const summary = operationSummary(tr, entry)
  const group = operationGroupOf(entry.action)
  const snapshot = technicalSnapshot(entry.after_json)

  return (
    <Dialog open onClose={onClose} title={t('audit.details.title')} className="max-w-lg">
      <div className="flex flex-col gap-5">
        {/* 1 — the summary. The badge carries the area, the heading carries the
            operation, and the sentence says it in full. */}
        <section className="flex flex-col gap-1.5">
          <h3 className="text-caption font-bold">{t('audit.details.summary')}</h3>
          <div className="flex items-center gap-3">
            <OperationTypeBadge action={entry.action} size="md" />
            <p className="text-section min-w-0 text-balance">{actionLabel(t, entry.action)}</p>
          </div>
          <p className="text-pretty text-sm leading-relaxed text-foreground-muted">{summary}</p>
        </section>

        {/* 2 — the business facts. Identical for both audiences, because none of
            it is technical. */}
        <section className="flex flex-col gap-2">
          <h3 className="text-caption font-bold">{t('audit.details.info')}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3">
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

            <Field label={t('audit.details.area')}>{t(operationGroupLabelKey(group))}</Field>

            <Field label={t('audit.details.item')}>{entityLabel(t, entry.entity_type)}</Field>

            {details.map((detail) => (
              <Field key={detail.label} label={detail.label}>
                {detail.value}
              </Field>
            ))}
          </dl>

          {details.length === 0 ? (
            <p className="text-caption leading-relaxed">{t('audit.details.noBusinessData')}</p>
          ) : null}
        </section>

        {/* 3 — ADMIN only. A dashed, tinted block so the stored payload can never
            be mistaken for business information, with a line saying what it is. */}
        {canViewTechnical ? (
          <section className="flex flex-col gap-2 rounded-md border border-dashed border-border-strong bg-surface-muted p-3">
            <h3 className="text-caption font-bold">{t('audit.details.technical')}</h3>
            <p className="text-caption leading-relaxed text-foreground-subtle">
              {t('audit.details.technicalHint')}
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3">
              <Field label={t('audit.details.code')}>
                <span className="text-sm" dir="ltr">
                  {entry.action}
                </span>
              </Field>
              <Field label={t('audit.details.recordType')}>
                <span className="text-sm" dir="ltr">
                  {entry.entity_type}
                </span>
              </Field>
              {entry.entity_id ? (
                <Field label={t('audit.details.reference')}>
                  <span className="text-sm tabular-nums" dir="ltr">
                    #{entry.entity_id}
                  </span>
                </Field>
              ) : null}
              <Field label={t('audit.details.record')}>
                <span className="text-sm tabular-nums" dir="ltr">
                  {entry.id}
                </span>
              </Field>
            </dl>
            <div className="flex flex-col gap-1.5">
              <h4 className="text-caption font-bold">{t('audit.details.snapshot')}</h4>
              {snapshot ? (
                <pre className="max-h-52 overflow-auto rounded-md border border-border-subtle bg-surface p-3 text-start text-xs leading-relaxed text-foreground-muted">
                  {snapshot}
                </pre>
              ) : (
                <p className="text-caption">{t('audit.details.snapshotEmpty')}</p>
              )}
            </div>
          </section>
        ) : null}
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
