/**
 * The catalog page header: identity, the counts a manager scans first, and the
 * two management actions.
 *
 * The actions are the ONLY place the catalog offers "add"; a read-only role
 * simply has no buttons here, which is why the permission arrives as a prop
 * rather than being re-derived inside.
 */
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui'
import { Coffee, Droplets, Package, Plus } from '@/components/ui/icon'

import type { Department } from './catalogModel'
import { departmentStyles } from './catalogVisual'

export function CatalogHeader({
  resultCount,
  activeCount,
  canManageCatalog,
  onAddProduct,
  onAddCategory,
}: {
  readonly resultCount: number
  readonly activeCount: number
  readonly canManageCatalog: boolean
  readonly onAddProduct: () => void
  readonly onAddCategory: () => void
}) {
  const { t } = useTranslation()

  return (
    <header className="flex flex-col gap-5 border-b border-border pb-6 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <div className="mb-3 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center border border-border bg-surface-muted text-foreground-muted">
            <Package size={16} aria-hidden />
          </div>

          <span className="text-caption font-bold uppercase tracking-[0.16em] text-foreground-subtle">
            {t('nav.catalog')}
          </span>
        </div>

        <h1 className="text-heading">{t('catalog.description')}</h1>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-caption">
            {resultCount} {t('catalog.type')}
          </span>

          <span className="h-1 w-1 bg-foreground-faint" aria-hidden />

          <span className="text-caption">
            {activeCount} {t('catalog.active')}
          </span>
        </div>
      </div>

      {canManageCatalog ? (
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <Button onClick={onAddProduct} className="w-full sm:w-auto">
            <Plus size={16} aria-hidden />
            {t('catalog.add')}
          </Button>
          <Button variant="outline" onClick={onAddCategory} className="w-full sm:w-auto">
            <Plus size={16} aria-hidden />
            {t('catalog.addCategory')}
          </Button>
        </div>
      ) : null}
    </header>
  )
}

/* ========================================================================== */
/* Catalog overview                                                           */
/* ========================================================================== */

export function CatalogOverview({
  type,
  count,
  active,
  onClick,
  t,
}: {
  readonly type: 'TOTAL' | Department
  readonly count: number
  readonly active: boolean
  readonly onClick: () => void
  readonly t: (key: string) => string
}) {
  const isTotal = type === 'TOTAL'
  const department = isTotal ? null : type
  const style = department ? departmentStyles[department] : null

  const Icon = isTotal ? Package : department === 'CAFE' ? Coffee : Droplets

  const label = isTotal ? t('catalog.total') : t(`catalog.${department}`)
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'group relative overflow-hidden border bg-surface text-start',
        'transition-[transform,box-shadow,border-color] duration-200',
        'hover:-translate-y-0.5 hover:shadow-md',
        active
          ? isTotal
            ? 'border-border-strong shadow-md'
            : `${style?.border} shadow-md`
          : 'border-border',
      ].join(' ')}
    >
      {/* Accent */}
      <div
        className={[
          'absolute inset-y-0 inset-s-0 w-1',
          style?.accent ?? 'bg-foreground-muted',
        ].join(' ')}
      />

      {/*
        The card's own body.

        `p-4 sm:p-5`, a `h-12 sm:h-14` icon tile and a `h-9 sm:h-10` count box, so
        the whole card fits the 296px a 320px screen has. At the original
        measurement — 20px padding, a 56px tile and 16px gaps — the label
        between them was left with under 60px and every department name truncated
        to an ellipsis, on the one card that names the two halves of the business.

        The count box keeps `shrink-0` and the label keeps `min-w-0 truncate`, so
        what gives way at the narrowest width is the NAME and never the figure:
        the count is what the card is selected for.
      */}
      <div className="flex min-h-24 items-center justify-between gap-3 p-4 ps-5 sm:min-h-28 sm:gap-5 sm:p-5 sm:ps-6">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <div
            className={[
              'flex shrink-0 items-center justify-center border',
              'h-12 w-12 sm:h-14 sm:w-14',
              isTotal
                ? 'border-border bg-surface-muted text-foreground-muted'
                : `${style?.soft} ${style?.border} ${style?.accentText}`,
            ].join(' ')}
          >
            <Icon size={25} strokeWidth={1.8} aria-hidden />
          </div>

          <div className="min-w-0">
            <p
              className={[
                'text-[11px] font-bold uppercase tracking-[0.18em]',
                style?.accentText ?? 'text-foreground-muted',
              ].join(' ')}
            >
              {label}
            </p>

            <h2 className="text-body mt-1 truncate font-bold">
              {isTotal ? t('nav.catalog') : t(`catalog.${department}`)}
            </h2>
          </div>
        </div>

        <div
          className={[
            'flex shrink-0 items-center justify-center border',
            'h-9 w-9 sm:h-10 sm:w-10',
            isTotal
              ? 'border-border bg-surface-muted text-foreground-muted'
              : `${style?.mutedBorder} ${style?.accentText} ${
                  active ? style?.soft : 'bg-surface-muted'
                }`,
          ].join(' ')}
        >
          <span className="text-sm font-black">{count}</span>
        </div>
      </div>

      {/* Active indicator */}
      <div
        className={[
          'h-1 origin-start transition-transform duration-200',
          style?.accent ?? 'bg-foreground-muted',
          active ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100',
        ].join(' ')}
      />
    </button>
  )
}
