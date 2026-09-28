/**
 * The catalog's filter state, in one place.
 *
 * These five values are pure view state: the page owns nothing else about
 * them, they are only ever read to narrow the grid and reset together, so
 * grouping them here keeps the "clear all" rule attached to the state it
 * clears instead of leaving five setters scattered across the page.
 */
import { useState } from 'react'

import { hasCatalogFilters, type Department, type ItemType, type Status } from './catalogModel'

export function useCatalogFilters() {
  const [query, setQuery] = useState('')
  const [dept, setDept] = useState<'' | Department>('')
  const [type, setType] = useState<'' | ItemType>('')
  const [status, setStatus] = useState<Status>('')
  /** `null` = every category; otherwise the category's database id. */
  const [categoryId, setCategoryId] = useState<number | null>(null)

  const hasFilters = hasCatalogFilters(query, dept, type, status, categoryId)

  function clearFilters() {
    setQuery('')
    setDept('')
    setType('')
    setStatus('')
    setCategoryId(null)
  }

  return {
    query,
    setQuery,
    dept,
    setDept,
    type,
    setType,
    status,
    setStatus,
    categoryId,
    setCategoryId,
    hasFilters,
    clearFilters,
  }
}

export type CatalogFilters = ReturnType<typeof useCatalogFilters>
