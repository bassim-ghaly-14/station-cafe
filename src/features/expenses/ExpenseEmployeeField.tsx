/**
 * The employee selector an employee-linked expense needs — and NOTHING else.
 *
 * A category that requires an employee (the seeded advance) needs one; every
 * other category must not be asked for it. That decision is DATA: the field reads
 * `requires_employee` from the category the manager picked, so there is no
 * hardcoded category code in the UI and a future employee-linked category works
 * without a change here.
 *
 * # Why this is one shared component
 *
 * The Manager expense dialog and the cashier shift dialog already call the SAME
 * `create_expense` command, so the backend rule is shared by construction. This
 * component is the frontend half of that same sharing: both dialogs mount it, so
 * the label, the search, the required marker, the error text and the clear-on-
 * switch behaviour can never drift apart between the two entry points.
 *
 * # What it deliberately does not do
 *
 * It computes nothing and decides no validity. A missing employee is still refused
 * by the backend; this only gives immediate feedback and prevents submitting a
 * knowingly-incomplete form.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Field, Input } from '@/components/ui/input'
import { EmployeeAvatar } from '@/components/ui'
import type { ExpenseCategory } from '@/services/opsApi'
import { useEmployeeList } from '@/features/employees/useEmployeeData'
import { roleOf } from '@/features/employees/employee-role'

export function ExpenseEmployeeField({
  category,
  categories,
  employeeId,
  onChange,
  invalid,
}: {
  /** The currently selected category code, or an empty string. */
  readonly category: string
  /** The category list the dialog already holds, from the backend. */
  readonly categories: readonly ExpenseCategory[]
  readonly employeeId: number | null
  readonly onChange: (employeeId: number | null) => void
  /** The dialog's own field-error text for this field, if any. */
  readonly invalid?: string | null
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  // Inactive staff are included on purpose: a person who was stopped still has
  // advances and deductions on record, and an advance may be back-dated to them.
  const list = useEmployeeList('', '', '', true)

  const requiresEmployee = categories.find((c) => c.code === category)?.requires_employee ?? false

  // Switching to a category that needs no employee must not leave a stale
  // selection behind: the id would be ignored by the backend, but keeping it in
  // state would silently re-attach it when the manager switched back.
  useEffect(() => {
    if (!requiresEmployee && employeeId !== null) onChange(null)
  }, [requiresEmployee, employeeId, onChange])

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const people = list.list?.employees ?? []
    if (needle === '') return people
    return people.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) || (row.phone ?? '').toLowerCase().includes(needle),
    )
  }, [list.list, query])

  if (!requiresEmployee) return null

  const selected = rows.find((row) => row.id === employeeId) ?? null

  return (
    <Field
      label={`${t('expenses.employee')} *`}
      hint={t('expenses.employeeHint')}
      error={invalid ?? undefined}
    >
      <div className="flex flex-col gap-2">
        <Input
          id="expense-employee-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('expenses.employeeSearch')}
          aria-label={t('expenses.employeeSearch')}
        />
        <div className="max-h-56 overflow-y-auto rounded-md border border-border-subtle">
          {rows.length === 0 ? (
            <p className="text-caption text-foreground-subtle p-3">{t('expenses.employeeEmpty')}</p>
          ) : (
            <ul>
              {rows.map((row) => {
                const isSelected = row.id === employeeId
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => onChange(isSelected ? null : row.id)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-start ${
                        isSelected ? 'bg-surface-muted' : ''
                      }`}
                    >
                      <EmployeeAvatar role={roleOf(row)} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-body">
                        {row.name}
                        {row.status === 'INACTIVE' ? (
                          <span className="text-caption text-foreground-subtle">
                            {' · '}
                            {t('employees.status.INACTIVE')}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        {selected ? (
          <p className="text-caption text-foreground-muted">
            {t('expenses.employeeSelected', { name: selected.name })}
          </p>
        ) : null}
      </div>
    </Field>
  )
}
