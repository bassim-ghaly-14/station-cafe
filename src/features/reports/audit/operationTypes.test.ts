import { describe, expect, it } from 'vitest'
import i18n from '@/lib/i18n'
import {
  entityLabelKey,
  isKnownEntity,
  operationGroupLabelKey,
  operationGroupOf,
  OPERATION_GROUPS,
  presentGroups,
  type OperationGroupId,
} from './operationTypes'
import { actionLabel, entityLabel, filterOperations, presentActors } from './useOperationHistory'
import type { AuditEntry } from '@/services/opsApi'

const t = (key: string) => i18n.t(key)

function entry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    id: 1,
    actor_id: 1,
    actor_name: 'سارة',
    actor_role: 'STAFF',
    action: 'invoice.created',
    entity_type: 'invoice',
    entity_id: '1',
    after_json: null,
    created_at: '2026-09-25 10:00:00Z',
    ...overrides,
  }
}

describe('operation type registry', () => {
  it('maps every action namespace the backend records to a known group', () => {
    // The namespaces below are the ones passed to `services::audit::record`.
    const namespaces = [
      'auth',
      'user',
      'catalog',
      'customer',
      'car',
      'table',
      'order',
      'invoice',
      'credit',
      'inventory',
      'expense',
      'shift',
      'day',
      'settings',
    ]
    for (const namespace of namespaces) {
      const group = operationGroupOf(`${namespace}.anything`)
      expect(group, namespace).not.toBe('other')
      expect(OPERATION_GROUPS[group]).toBeDefined()
    }
  })

  it('groups related namespaces together and falls back safely', () => {
    expect(operationGroupOf('invoice.created')).toBe('invoices')
    expect(operationGroupOf('credit.settled')).toBe('credit')
    expect(operationGroupOf('day.closed')).toBe('operations')
    expect(operationGroupOf('shift.opened')).toBe('operations')
    expect(operationGroupOf('car.created')).toBe('customer')
    // An unknown code must still resolve, never throw.
    expect(operationGroupOf('loyalty.points_redeemed')).toBe('other')
    expect(operationGroupOf('')).toBe('other')
  })

  it('gives every group a translated name and an icon', () => {
    const groups = Object.keys(OPERATION_GROUPS) as OperationGroupId[]
    for (const group of groups) {
      const label = i18n.t(operationGroupLabelKey(group))
      expect(label, group).not.toBe(operationGroupLabelKey(group))
      expect(label.length, group).toBeGreaterThan(0)
      expect(OPERATION_GROUPS[group].icon, group).toBeDefined()
    }
  })

  it('lists present groups in a stable, de-duplicated order', () => {
    const groups = presentGroups([
      'shift.opened',
      'invoice.created',
      'invoice.cancelled',
      'day.closed',
    ])
    expect(groups).toEqual(['invoices', 'operations'])
    expect(presentGroups([])).toEqual([])
  })

  it('recognises the recorded entity types and rejects unknown ones', () => {
    expect(isKnownEntity('business_day')).toBe(true)
    expect(isKnownEntity('day_closing')).toBe(true)
    expect(isKnownEntity('loyalty_account')).toBe(false)
    expect(entityLabelKey('invoice')).toBe('audit.entities.invoice')
  })
})

describe('operation labels', () => {
  it('translates recorded actions and entities', () => {
    expect(actionLabel(t, 'invoice.created')).toBe('إنشاء فاتورة')
    expect(actionLabel(t, 'shift.closed')).toBe('تقفيل وردية')
    expect(entityLabel(t, 'invoice')).toBe('فاتورة')
    expect(entityLabel(t, 'business_day')).toBe('يوم عمل')
  })

  it('never leaks an unmapped code, in Arabic or in English', () => {
    expect(actionLabel(t, 'loyalty.points_redeemed')).toBe('عملية مسجّلة')
    expect(entityLabel(t, 'loyalty_account')).toBe('سجل')
    expect(entityLabel(t, '')).toBe('سجل')
  })
})

describe('operation filtering', () => {
  const rows = [
    entry({
      id: 1,
      action: 'invoice.created',
      entity_type: 'invoice',
      actor_id: 1,
      actor_name: 'سارة',
    }),
    entry({
      id: 2,
      action: 'shift.opened',
      entity_type: 'shift',
      actor_id: 2,
      actor_name: 'محمود',
    }),
    entry({
      id: 3,
      action: 'catalog.price_changed',
      entity_type: 'product',
      actor_id: 1,
      actor_name: 'سارة',
    }),
  ]

  it('returns everything when no filter is active', () => {
    expect(filterOperations(rows, { search: '', group: null, actor: null }, t)).toHaveLength(3)
  })

  it('filters by operation type', () => {
    const result = filterOperations(rows, { search: '', group: 'invoices', actor: null }, t)
    expect(result.map((row) => row.id)).toEqual([1])
  })

  it('filters by operator', () => {
    const result = filterOperations(rows, { search: '', group: null, actor: '2' }, t)
    expect(result.map((row) => row.id)).toEqual([2])
  })

  it('searches the translated label, the type and the actor', () => {
    expect(filterOperations(rows, { search: 'فاتورة', group: null, actor: null }, t)).toHaveLength(
      1,
    )
    expect(filterOperations(rows, { search: 'وردية', group: null, actor: null }, t)).toHaveLength(1)
    expect(filterOperations(rows, { search: 'محمود', group: null, actor: null }, t)).toHaveLength(1)
    // A code the user cannot see must not be searchable either.
    expect(
      filterOperations(rows, { search: 'invoice.created', group: null, actor: null }, t),
    ).toEqual([])
  })

  it('combines filters and ignores surrounding whitespace', () => {
    const result = filterOperations(rows, { search: '  سارة  ', group: 'catalog', actor: null }, t)
    expect(result.map((row) => row.id)).toEqual([3])
  })

  it('collects distinct operators without duplicates', () => {
    expect(presentActors(rows)).toEqual([
      { id: '1', name: 'سارة' },
      { id: '2', name: 'محمود' },
    ])
  })

  it('skips system entries that have no actor', () => {
    expect(presentActors([entry({ actor_id: null, actor_name: null })])).toEqual([])
  })
})
