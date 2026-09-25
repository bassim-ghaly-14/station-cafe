import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { opsApi, type AuditEntry } from '@/services/opsApi'
import { useErrText } from '@/lib/err'
import {
  entityLabelKey,
  isKnownEntity,
  operationGroupOf,
  type OperationGroupId,
} from './operationTypes'

/**
 * How many records the log query asks for. The backend clamps `limit` to
 * 1..500; 200 keeps the window useful for a manager scanning a shift's
 * activity without turning the list into an unbounded fetch.
 */
export const AUDIT_WINDOW = 200

export type OperationHistoryState = {
  rows: AuditEntry[]
  /** True while the first page is in flight — nothing is on screen yet. */
  initialLoading: boolean
  /** True while a reload runs over rows that are already on screen. */
  refreshing: boolean
  error: string | null
  reload: () => void
}

/**
 * Loads the operations log.
 *
 * The backend's only server-side filter is `action_like`, which matches the raw
 * action CODE (`invoice.created`). An Arabic-first UI cannot search on that, so
 * the search box filters the returned window on the client against the same
 * translated labels the table renders — the user searches for what they can
 * actually see, and the log is fetched once instead of on every keystroke.
 */
export function useOperationHistory(): OperationHistoryState {
  const { t } = useTranslation()
  const errText = useErrText(t)
  const [rows, setRows] = useState<AuditEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [requestVersion, setRequestVersion] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    opsApi
      .audit(AUDIT_WINDOW)
      .then((entries) => {
        if (!active) return
        setRows(entries)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(errText(cause))
        setRows(null)
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [requestVersion, errText])

  const reload = useCallback(() => setRequestVersion((version) => version + 1), [])
  // A reload keeps the rows already on screen and marks the list busy, so the
  // log never blanks out just to prove it is reloading.
  const hasRows = rows !== null
  return {
    rows: rows ?? [],
    initialLoading: loading && !hasRows,
    refreshing: loading && hasRows,
    error,
    reload,
  }
}

export type OperationFilters = {
  /** Free text matched against the translated operation, actor and entity. */
  search: string
  /** `null` means "all types". */
  group: OperationGroupId | null
  /** `null` means "all operators". */
  actor: string | null
}

export const NO_FILTERS: OperationFilters = { search: '', group: null, actor: null }

/** True when anything at all is narrowing the list. */
export function hasActiveFilters(filters: OperationFilters): boolean {
  return filters.search.trim() !== '' || filters.group !== null || filters.actor !== null
}

/**
 * The searchable text of one row: the translated operation name, the operation
 * type, the actor and the entity. Built from the SAME catalogue the table
 * renders, so search can never match something the user cannot see.
 */
function searchIndex(entry: AuditEntry, t: (key: string) => string): string {
  return [
    t(`audit.actions.${entry.action}`),
    t(`audit.groups.${operationGroupOf(entry.action)}`),
    t(`audit.entities.${entry.entity_type}`),
    entry.actor_name ?? '',
    entry.entity_id ?? '',
  ]
    .join(' ')
    .toLowerCase()
}

/** Apply the active filters to the loaded window. Pure, so it is trivially testable. */
export function filterOperations(
  rows: readonly AuditEntry[],
  filters: OperationFilters,
  t: (key: string) => string,
): AuditEntry[] {
  const needle = filters.search.trim().toLowerCase()
  return rows.filter((entry) => {
    if (filters.group !== null && operationGroupOf(entry.action) !== filters.group) return false
    if (filters.actor !== null && String(entry.actor_id ?? '') !== filters.actor) return false
    if (needle === '') return true
    return searchIndex(entry, t).includes(needle)
  })
}

/** The distinct operators present in the window, for the operator filter. */
export function presentActors(rows: readonly AuditEntry[]): { id: string; name: string }[] {
  const seen = new Map<string, string>()
  for (const entry of rows) {
    if (entry.actor_id === null) continue
    const id = String(entry.actor_id)
    if (!seen.has(id)) seen.set(id, entry.actor_name ?? '')
  }
  return [...seen]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'))
}

/** Localised label for a recorded entity type, degrading to a neutral noun. */
export function entityLabel(t: (key: string) => string, entityType: string): string {
  if (!entityType) return t('audit.entityFallback')
  return isKnownEntity(entityType) ? t(entityLabelKey(entityType)) : t('audit.entityFallback')
}

/** Localised label for a recorded action, degrading to a generic noun. */
export function actionLabel(t: (key: string) => string, action: string): string {
  const key = `audit.actions.${action}`
  const label = t(key)
  // i18next echoes the key back when a translation is missing, so that echo is
  // exactly the signal that the catalogue has no Arabic name for this action.
  return label === key ? t('audit.actionFallback') : label
}
