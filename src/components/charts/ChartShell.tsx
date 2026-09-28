/**
 * ChartShell — the card every chart in the application sits in, and the ONE
 * fullscreen + export implementation behind all of them.
 *
 * It exists because that machinery was written twice (once inside the monthly
 * comparison chart, once inside the reports donut) and the daily charts had none
 * at all. Rather than let a fourth copy appear, the mechanism is stated once here
 * and every chart — reports donuts, reports monthly comparisons, the sales daily
 * chart and the expenses daily chart — renders through it.
 *
 * What it owns (so no chart has to repeat it):
 *  - the card, its header (title, description, period line) and the toolbar;
 *  - the fullscreen trigger and the `Dialog` it opens, INCLUDING the self-render:
 *    the body is asked for again with `presentation="fullscreen"`, so what fills
 *    the dialog is the SAME chart, not a second implementation of it;
 *  - focus restoration on close (the trigger is refocused by id), so keyboard
 *    users are returned where they were;
 *  - the export actions menu — the same two entries, the same labels, the same
 *    `FileDown` affordance — driven by callbacks the CHART supplies, so this
 *    file owns no exporter and no data.
 *
 * What it deliberately does NOT own: the plot, the legend, the empty state and
 * every word on screen. The body is a function of the presentation, which is how
 * a chart can resize its own plot for fullscreen without this file knowing what
 * is inside it.
 */
import { useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Button, Card, Dialog } from '@/components/ui'
import { FileDown, Maximize2, MoreHorizontal } from '@/components/ui/icon'
import { cn } from '@/lib/utils'

/** How the card wraps itself: inline on a page, or filling a fullscreen dialog. */
export type ChartPresentation = 'card' | 'fullscreen'

export type ChartShellProps = {
  /** Stable id: it namespaces the fullscreen trigger and the focus restoration. */
  id: string
  title: string
  description?: string
  /** Period or scope line, shown under the description. */
  period?: string
  /**
   * Where the period line appears. The reports donuts state it only in fullscreen
   * (the inline card sits under a period picker that already says it); the
   * monthly charts state it always, because their window comes from Dev Settings
   * rather than from anything on screen.
   */
  periodVisibility?: 'always' | 'fullscreen'
  /** Optional leading glyph, the reports tiles' icon badge. */
  icon?: ReactNode
  /** Rendered in the toolbar, before the fullscreen and export buttons. */
  toolbarExtra?: ReactNode
  /** Export callbacks; when both are absent the actions menu is not rendered. */
  onExportPng?: () => void | Promise<void>
  onExportExcel?: () => void | Promise<void>
  presentation?: ChartPresentation
  className?: string
  /**
   * Extra classes merged into the card INLINE only. The reports donuts need
   * `overflow-visible` so a full-bleed label is never clipped; fullscreen is
   * untouched because its own bounds are the dialog's.
   */
  inlineCardClassName?: string
  /**
   * Test id for the card, WITHOUT the `fullscreen-` prefix — the shell adds that
   * prefix itself, so the two presentations can never be told apart by accident.
   */
  testId: string
  /**
   * The chart body, asked for again for the fullscreen presentation. A function
   * rather than an element because the plot is sized differently in each.
   */
  children: (presentation: ChartPresentation) => ReactNode
}

/**
 * The chart header: identity on the start side, actions on the end side. Split
 * out of `ChartShell` so each part reads on its own; the rendered output is
 * exactly what the shell used to build inline.
 */
function ChartHeader({
  t,
  title,
  description,
  period,
  showPeriod,
  icon,
  fullscreen,
  id,
  hasExports,
  menuOpen,
  setMenuOpen,
  toolbarExtra,
  onExportPng,
  onExportExcel,
  setFullscreenOpen,
}: Readonly<{
  readonly t: TFunction
  readonly title: string
  readonly description?: string
  readonly period?: string
  readonly showPeriod: boolean
  readonly icon?: ReactNode
  readonly fullscreen: boolean
  readonly id: string
  readonly hasExports: boolean
  readonly menuOpen: boolean
  readonly setMenuOpen: (open: boolean) => void
  readonly toolbarExtra?: ReactNode
  readonly onExportPng?: () => void | Promise<void>
  readonly onExportExcel?: () => void | Promise<void>
  readonly setFullscreenOpen: (open: boolean) => void
}>) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        {icon ? (
          <span className="flex size-10 shrink-0 items-center justify-center bg-accent text-primary">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0">
          <h2 className="text-section text-start text-foreground-strong">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-caption text-foreground-subtle">{description}</p>
          ) : null}
          {period && showPeriod ? (
            <p className="mt-1 text-caption text-foreground-muted">{period}</p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {toolbarExtra}
        {!fullscreen ? (
          <Button
            id={`fullscreen-trigger-${id}`}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`${t('reports.charts.fullscreen')}: ${title}`}
            title={t('reports.charts.fullscreen')}
            onClick={() => setFullscreenOpen(true)}
          >
            <Maximize2 size={17} aria-hidden />
          </Button>
        ) : null}
        {hasExports ? (
          <ExportMenu
            t={t}
            menuOpen={menuOpen}
            setMenuOpen={setMenuOpen}
            onExportPng={onExportPng}
            onExportExcel={onExportExcel}
          />
        ) : null}
      </div>
    </div>
  )
}

/** The export menu: one button plus the items the caller actually provided. */
function ExportMenu({
  t,
  menuOpen,
  setMenuOpen,
  onExportPng,
  onExportExcel,
}: Readonly<{
  readonly t: TFunction
  readonly menuOpen: boolean
  readonly setMenuOpen: (open: boolean) => void
  readonly onExportPng?: () => void | Promise<void>
  readonly onExportExcel?: () => void | Promise<void>
}>) {
  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t('reports.charts.actions')}
        title={t('reports.charts.actions')}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(!menuOpen)}
      >
        <MoreHorizontal size={18} aria-hidden />
      </Button>
      {menuOpen ? (
        <div
          role="menu"
          className="absolute inset-e-0 top-11 z-10 w-44 rounded-md border border-border-strong bg-surface-popover p-1 shadow-lg"
        >
          {onExportPng ? (
            <ExportMenuItem
              onClick={() => {
                setMenuOpen(false)
                void onExportPng()
              }}
            >
              {t('reports.charts.png')}
            </ExportMenuItem>
          ) : null}
          {onExportExcel ? (
            <ExportMenuItem
              onClick={() => {
                setMenuOpen(false)
                void onExportExcel()
              }}
            >
              {t('reports.charts.excel')}
            </ExportMenuItem>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function ChartShell({
  id,
  title,
  description,
  period,
  periodVisibility = 'always',
  icon,
  toolbarExtra,
  onExportPng,
  onExportExcel,
  presentation = 'card',
  className,
  inlineCardClassName,
  testId,
  children,
}: Readonly<ChartShellProps>) {
  const { t } = useTranslation()
  const fullscreen = presentation === 'fullscreen'
  const [fullscreenOpen, setFullscreenOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const hasExports = Boolean(onExportPng ?? onExportExcel)
  const showPeriod = periodVisibility === 'always' || fullscreen

  const closeFullscreen = () => {
    setFullscreenOpen(false)
    requestAnimationFrame(() => document.getElementById(`fullscreen-trigger-${id}`)?.focus())
  }

  return (
    <>
      <Card
        className={cn(
          'relative flex flex-col p-5 shadow-none',
          // Fullscreen GROWS with its content rather than being a fixed slice of
          // the viewport, so a long legend wraps into more rows instead of
          // scrolling inside the card. Only if the whole thing outgrows the
          // viewport does the DIALOG scroll, which is its pre-existing behaviour
          // and not a second nested region.
          fullscreen ? 'max-h-[calc(100dvh-4rem)]' : cn('min-h-88', inlineCardClassName),
          className,
        )}
        data-testid={`${fullscreen ? 'fullscreen-' : ''}${testId}`}
      >
        <ChartHeader
          t={t}
          title={title}
          description={description}
          period={period}
          showPeriod={showPeriod}
          icon={icon}
          fullscreen={fullscreen}
          id={id}
          hasExports={hasExports}
          menuOpen={menuOpen}
          setMenuOpen={setMenuOpen}
          toolbarExtra={toolbarExtra}
          onExportPng={onExportPng}
          onExportExcel={onExportExcel}
          setFullscreenOpen={setFullscreenOpen}
        />

        {children(presentation)}
      </Card>

      {!fullscreen ? (
        <Dialog
          open={fullscreenOpen}
          onClose={closeFullscreen}
          title={t('reports.charts.fullscreen')}
          className="w-[calc(100vw-1rem)] max-w-none max-h-[calc(100dvh-1rem)] p-3 sm:p-5"
        >
          <ChartShell
            id={id}
            title={title}
            description={description}
            period={period}
            periodVisibility={periodVisibility}
            icon={icon}
            toolbarExtra={toolbarExtra}
            onExportPng={onExportPng}
            onExportExcel={onExportExcel}
            presentation="fullscreen"
            testId={testId}
          >
            {children}
          </ChartShell>
        </Dialog>
      ) : null}
    </>
  )
}

function ExportMenuItem({
  onClick,
  children,
}: Readonly<{ readonly onClick: () => void; children: ReactNode }>) {
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-3 py-2 text-start text-sm hover:bg-surface-hover"
    >
      <FileDown size={16} aria-hidden />
      {children}
    </button>
  )
}
