/**
 * Customer phone export dialog — scope + format, then download.
 *
 * The control lives in the customers toolbar (MANAGER+ only) and states what
 * it does: "export customer phone numbers". Two choices, both native radios
 * so keyboard and screen-reader semantics come free:
 *  - scope: selected customers (with the live selected count, disabled when
 *    the selection is empty) or all customers;
 *  - format: CSV (`phone` column) or VCF (one vCard 3.0 contact per phone).
 *
 * The dialog owns no data rules: rows come from the MANAGER-gated
 * `export_customer_phones` command (already ordered + deduplicated), this
 * file only builds the Blob and triggers the existing `downloadBlob` helper.
 * Errors surface through the app toast; no alert(), no stack traces.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, DialogActions } from '@/components/ui'
import { Field, Select } from '@/components/ui'
import { FileDown } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useErrText } from '@/lib/err'
import { downloadBlob } from '@/features/reports/charts/exports'
import { customersApi } from '@/services/customersApi'
import { buildCustomerPhonesFile, type CustomerPhoneFormat } from './customerPhoneExport'

export type CustomerPhoneExportScope = 'selected' | 'all'

export function CustomerPhoneExportDialog({
  open,
  onClose,
  scope,
  onScopeChange,
  selectedIds,
  selectedCount,
  canExport,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly scope: CustomerPhoneExportScope
  readonly onScopeChange: (scope: CustomerPhoneExportScope) => void
  /** Exact selected customer ids; sent only when scope is `selected`. */
  readonly selectedIds: readonly number[]
  /** Live selected count shown beside the `selected` option. */
  readonly selectedCount: number
  /** False for a role the backend would refuse (cashier). */
  readonly canExport: boolean
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [format, setFormat] = useState<CustomerPhoneFormat>('csv')
  const [busy, setBusy] = useState(false)

  const selectedEmpty = selectedIds.length === 0
  const confirmDisabled = busy || (scope === 'selected' && selectedEmpty)

  if (!open) return null

  async function runExport() {
    if (scope === 'selected' && selectedEmpty) {
      toast(t('customers.export.emptySelection'), 'error')
      return
    }
    setBusy(true)
    try {
      const rows = await customersApi.exportPhones(
        scope === 'selected' ? [...selectedIds] : undefined,
      )
      if (rows.length === 0) {
        toast(t('customers.export.noPhones'), 'error')
        return
      }
      const { blob, filename } = buildCustomerPhonesFile(rows, format)
      try {
        downloadBlob(blob, filename)
      } catch {
        toast(t('customers.export.downloadFailed'), 'error')
        return
      }
      toast(t('customers.export.done', { count: rows.length }), 'success')
      onClose()
    } catch (cause) {
      toast(errText(cause), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={t('customers.export.title')}>
      <div className="flex flex-col gap-4">
        <p className="text-body text-foreground-muted">{t('customers.export.hint')}</p>

        <fieldset>
          <legend className="text-base font-bold text-foreground-muted">
            {t('customers.export.scopeLabel')}
          </legend>
          <div className="mt-2 flex flex-col gap-2">
            <label className="flex items-center gap-2 text-body">
              <input
                type="radio"
                name="customer-phone-export-scope"
                checked={scope === 'selected'}
                onChange={() => onScopeChange('selected')}
              />
              {t('customers.export.scopeSelected', { count: selectedCount })}
            </label>
            <label className="flex items-center gap-2 text-body">
              <input
                type="radio"
                name="customer-phone-export-scope"
                checked={scope === 'all'}
                onChange={() => onScopeChange('all')}
              />
              {t('customers.export.scopeAll')}
            </label>
          </div>
          {scope === 'selected' && selectedEmpty ? (
            <p role="alert" className="mt-1 text-caption text-destructive">
              {t('customers.export.emptySelection')}
            </p>
          ) : null}
        </fieldset>

        <Field label={t('customers.export.formatLabel')} htmlFor="customer-phone-export-format">
          <Select
            id="customer-phone-export-format"
            value={format}
            onChange={(e) => setFormat(e.target.value as CustomerPhoneFormat)}
          >
            <option value="csv">{t('customers.export.formatCsv')}</option>
            <option value="vcf">{t('customers.export.formatVcf')}</option>
          </Select>
        </Field>

        {!canExport ? (
          <p role="alert" className="text-caption text-destructive">
            {t('errors.auth.forbidden')}
          </p>
        ) : null}

        <DialogActions>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('app.cancel')}
          </Button>
          <Button
            onClick={() => void runExport()}
            disabled={confirmDisabled || !canExport}
            loading={busy}
            data-dialog-autofocus
          >
            {!busy ? <FileDown size={16} aria-hidden /> : null}
            {busy ? t('app.loading') : t('customers.export.action')}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  )
}
