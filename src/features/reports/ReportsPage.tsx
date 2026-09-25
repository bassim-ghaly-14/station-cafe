/**
 * Manager reports UI — exposes the existing report service: sales by day,
 * product sales, audit log and print job history. No new reporting engine.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState } from '@/components/states'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DateRangePicker,
  EmployeeAvatar,
  MoneyDisplay,
  TableSkeleton,
} from '@/components/ui'
import { Field, Input } from '@/components/ui/input'
import { BarChart3, Printer } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import {
  DisplayDate,
  DisplayDateTime,
  DisplayDateTimeRange,
} from '@/components/ui/display-datetime'
import { addDays, todayIso } from '@/lib/date'
import {
  opsApi,
  type AuditEntry,
  type PrintJobRow,
  type ProductSales,
  type SalesByDay,
} from '@/services/opsApi'
import { printJobBadgeVariant } from '@/lib/status-badge'
import { useErrText } from '@/lib/err'
import { useAnalyticsCharts } from './charts/mockCharts'
import { AnalyticsDonutChart } from './charts/AnalyticsDonutChart'
import { PrintPreviewDialog, type PrintPreviewTarget } from '@/features/pos/PrintPreviewDialog'
import type { ShiftRow } from '@/services/shiftApi'

type Tab = 'sales' | 'products' | 'audit' | 'print' | 'shiftClosings' | 'dayClosings' | 'charts'
const RANGE_KEY = 'station.reports.dateRange'

function initialRange(): { from: string; to: string } {
  try {
    const stored = localStorage.getItem(RANGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as { from?: unknown; to?: unknown }
      return {
        from: typeof parsed.from === 'string' ? parsed.from : '',
        to: typeof parsed.to === 'string' ? parsed.to : '',
      }
    }
  } catch {
    /* fall back to the product's initial seven-day default */
  }
  const today = todayIso()
  return { from: addDays(today, -6), to: today }
}

export default function ReportsPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('sales')
  const [{ from, to }, setRange] = useState(initialRange)
  useEffect(() => {
    localStorage.setItem(RANGE_KEY, JSON.stringify({ from, to }))
  }, [from, to])

  const setFrom = (value: string) => setRange((current) => ({ ...current, from: value }))
  const setTo = (value: string) => setRange((current) => ({ ...current, to: value }))

  const TABS: { id: Tab; label: string }[] = [
    { id: 'sales', label: t('reports.sales') },
    { id: 'products', label: t('reports.products') },
    { id: 'audit', label: t('nav.audit') },
    { id: 'print', label: t('reports.printJobs') },
    { id: 'shiftClosings', label: t('reports.shiftClosings') },
    { id: 'dayClosings', label: t('reports.dayClosings') },
    { id: 'charts', label: t('reports.charts.title') },
  ]

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-heading flex items-center gap-2">
        <BarChart3 size={22} aria-hidden />
        {t('nav.reports')}
      </h1>

      <div
        className="flex flex-wrap items-center gap-2"
        role="tablist"
        aria-label={t('nav.reports')}
      >
        {TABS.map((x) => (
          <Button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            variant={tab === x.id ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setTab(x.id)}
          >
            {x.label}
          </Button>
        ))}
      </div>

      {tab === 'sales' ? <SalesReport from={from} to={to} setFrom={setFrom} setTo={setTo} /> : null}
      {tab === 'products' ? (
        <ProductSalesReport from={from} to={to} setFrom={setFrom} setTo={setTo} />
      ) : null}
      {tab === 'audit' ? <AuditList /> : null}
      {tab === 'print' ? <PrintJobsList /> : null}
      {tab === 'shiftClosings' ? (
        <ClosingReports kind="shift" from={from} to={to} setFrom={setFrom} setTo={setTo} />
      ) : null}
      {tab === 'dayClosings' ? (
        <ClosingReports kind="day" from={from} to={to} setFrom={setFrom} setTo={setTo} />
      ) : null}
      {tab === 'charts' ? (
        <ChartsReport from={from} to={to} setFrom={setFrom} setTo={setTo} />
      ) : null}
    </div>
  )
}

function ChartsReport({
  from,
  to,
  setFrom,
  setTo,
}: {
  from: string
  to: string
  setFrom: (v: string) => void
  setTo: (v: string) => void
}) {
  const report = useAnalyticsCharts()
  return (
    <div className="flex flex-col gap-4">
      <RangePicker from={from} to={to} setFrom={setFrom} setTo={setTo} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {report.data.map((chart) => (
          <AnalyticsDonutChart key={chart.id} chart={chart} from={from} to={to} />
        ))}
      </div>
    </div>
  )
}

/**
 * Report period filter — one shared range control for the `from` / `to` pair the
 * report services already expect. The values travel to the API untouched:
 * `YYYY-MM-DD` strings, empty when the user clears the period.
 */
function RangePicker({
  from,
  to,
  setFrom,
  setTo,
}: {
  from: string
  to: string
  setFrom: (v: string) => void
  setTo: (v: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DateRangePicker
        from={from}
        to={to}
        onChange={({ from: nextFrom, to: nextTo }) => {
          setFrom(nextFrom)
          setTo(nextTo)
        }}
      />
    </div>
  )
}

function SalesReport({
  from,
  to,
  setFrom,
  setTo,
}: {
  from: string
  to: string
  setFrom: (v: string) => void
  setTo: (v: string) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [rows, setRows] = useState<SalesByDay[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoadError(null)
    opsApi
      .salesByDay(from, to)
      .then(setRows)
      .catch((e) => {
        setLoadError(errText(e))
        toast(errText(e), 'error')
      })
  }, [from, to, toast, errText])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="flex flex-col gap-3">
      <RangePicker from={from} to={to} setFrom={setFrom} setTo={setTo} />
      {rows === null ? (
        loadError ? (
          <ErrorState message={loadError} onRetry={load} retryLabel={t('app.retry')} />
        ) : (
          <TableSkeleton rows={6} columns={7} />
        )
      ) : rows.length === 0 ? (
        <EmptyState title={t('reports.noData')} />
      ) : (
        <Card>
          <CardHeader title={t('reports.sales')} subtitle={t('reports.salesHint')} />
          <table className="w-full text-right">
            <thead>
              <tr className="text-caption border-b border-border">
                <th className="py-2 font-bold">{t('app.date')}</th>
                <th className="py-2 font-bold">{t('reports.invoices')}</th>
                <th className="py-2 font-bold">{t('pos.cafe')}</th>
                <th className="py-2 font-bold">{t('pos.wash')}</th>
                <th className="py-2 font-bold">{t('pos.discount')}</th>
                <th className="py-2 font-bold">{t('pos.serviceCharge')}</th>
                <th className="py-2 font-bold">{t('pos.total')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.day_id} className="border-b border-border-subtle">
                  <td className="py-2 text-body">
                    <DisplayDate value={r.day_date} />
                  </td>
                  <td className="py-2">{r.invoices_count}</td>
                  <td className="py-2">
                    <MoneyDisplay amount={r.cafe_sales} />
                  </td>
                  <td className="py-2">
                    <MoneyDisplay amount={r.wash_sales} />
                  </td>
                  <td className="py-2">
                    <MoneyDisplay amount={-r.discounts} />
                  </td>
                  <td className="py-2">
                    <MoneyDisplay amount={r.service_charges} />
                  </td>
                  <td className="py-2 text-money">
                    <MoneyDisplay amount={r.total_sales} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}

function ProductSalesReport({
  from,
  to,
  setFrom,
  setTo,
}: {
  from: string
  to: string
  setFrom: (v: string) => void
  setTo: (v: string) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [rows, setRows] = useState<ProductSales[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoadError(null)
    opsApi
      .productSales(from, to)
      .then(setRows)
      .catch((e) => {
        setLoadError(errText(e))
        toast(errText(e), 'error')
      })
  }, [from, to, toast, errText])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="flex flex-col gap-3">
      <RangePicker from={from} to={to} setFrom={setFrom} setTo={setTo} />
      {rows === null ? (
        loadError ? (
          <ErrorState message={loadError} onRetry={load} retryLabel={t('app.retry')} />
        ) : (
          <TableSkeleton rows={6} columns={4} />
        )
      ) : rows.length === 0 ? (
        <EmptyState title={t('reports.noData')} />
      ) : (
        <Card>
          <CardHeader title={t('reports.products')} />
          <table className="w-full text-right">
            <thead>
              <tr className="text-caption border-b border-border">
                <th className="py-2 font-bold">{t('catalog.name')}</th>
                <th className="py-2 font-bold">{t('catalog.department')}</th>
                <th className="py-2 font-bold">{t('pos.qty')}</th>
                <th className="py-2 font-bold">{t('pos.total')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.product_name}-${r.department}`}
                  className="border-b border-border-subtle"
                >
                  <td className="py-2 text-body font-bold">{r.product_name}</td>
                  <td className="py-2">{t(`catalog.${r.department}`)}</td>
                  <td className="py-2">{r.quantity}</td>
                  <td className="py-2 text-money">
                    <MoneyDisplay amount={r.total} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}

function ClosingReports({
  kind,
  from,
  to,
  setFrom,
  setTo,
}: {
  kind: 'shift' | 'day'
  from: string
  to: string
  setFrom: (v: string) => void
  setTo: (v: string) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [shifts, setShifts] = useState<ShiftRow[]>([])
  const [days, setDays] = useState<import('@/services/opsApi').ClosedBusinessDay[]>([])
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState<PrintPreviewTarget | null>(null)
  const load = useCallback(() => {
    setError(null)
    const request =
      kind === 'shift'
        ? opsApi.closedShifts(from || undefined, to || undefined)
        : opsApi.closedBusinessDays(from || undefined, to || undefined)
    request
      .then((rows) =>
        kind === 'shift'
          ? setShifts(rows as ShiftRow[])
          : setDays(rows as import('@/services/opsApi').ClosedBusinessDay[]),
      )
      .catch((e) => {
        setError(errText(e))
        toast(errText(e), 'error')
      })
  }, [kind, from, to, errText, toast])
  useEffect(() => {
    load()
  }, [load])
  return (
    <div className="flex flex-col gap-3">
      <RangePicker from={from} to={to} setFrom={setFrom} setTo={setTo} />
      {error ? (
        <ErrorState message={error} onRetry={load} retryLabel={t('app.retry')} />
      ) : kind === 'shift' ? (
        <Card>
          <CardHeader title={t('reports.shiftClosings')} />
          <div className="divide-y divide-border-subtle">
            {shifts.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-48 flex-1">
                  <p className="flex min-w-0 items-center gap-1.5 font-bold">
                    <span className="tabular-nums">#{s.id}</span>
                    <span aria-hidden>·</span>
                    <EmployeeAvatar role={s.user_role} size="sm" />
                    <span className="truncate">{s.user_name ?? '—'}</span>
                  </p>
                  <p className="min-w-0 text-caption">
                    <DisplayDateTimeRange from={s.opened_at} to={s.closed_at} />
                  </p>
                  <MoneyDisplay amount={s.expected_cash} />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTarget({ kind: 'shift_report', shift_id: s.id })}
                >
                  {t('reports.preview')}
                </Button>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader title={t('reports.dayClosings')} />
          <div className="divide-y divide-border-subtle">
            {days.map((d) => (
              <div key={d.business_day_id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-48 flex-1">
                  <p className="font-bold">
                    <span className="tabular-nums">#{d.business_day_id}</span> ·{' '}
                    <DisplayDate value={d.day_date} />
                  </p>
                  <p className="min-w-0 text-caption">
                    <DisplayDateTimeRange from={d.opened_at} to={d.closed_at} />
                  </p>
                  <p>
                    {d.shift_count} · <MoneyDisplay amount={d.totals.total_sales} />
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTarget({ kind: 'day_report', day_id: d.business_day_id })}
                >
                  {t('reports.preview')}
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}
      {target ? <PrintPreviewDialog target={target} onClose={() => setTarget(null)} /> : null}
    </div>
  )
}

function AuditList() {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [rows, setRows] = useState<AuditEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [action, setAction] = useState('')

  const load = useCallback(() => {
    setLoadError(null)

    opsApi
      .audit(100, action.trim() || undefined)
      .then(setRows)
      .catch((e) => {
        setLoadError(errText(e))
        toast(errText(e), 'error')
      })
  }, [action, toast, errText])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('audit.actionFilter')}>
          <Input
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="catalog. / payment. / inventory."
          />
        </Field>
      </div>
      {rows === null ? (
        loadError ? (
          <ErrorState message={loadError} onRetry={load} retryLabel={t('app.retry')} />
        ) : (
          <TableSkeleton rows={7} columns={3} />
        )
      ) : rows.length === 0 ? (
        <EmptyState title={t('audit.empty')} />
      ) : (
        <Card>
          <CardHeader title={t('nav.audit')} subtitle={t('audit.hint')} />
          <div className="flex flex-col divide-y divide-border-subtle">
            {rows.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-48 flex-1">
                  <p className="text-body font-bold">
                    {t([`audit.actions.${a.action}`, a.action])}
                  </p>
                  <p className="min-w-0 text-caption">
                    <DisplayDateTime value={a.created_at} separator="" />
                    {a.entity_type
                      ? ` · ${a.entity_type}${a.entity_id ? `#${a.entity_id}` : ''}`
                      : ''}
                  </p>
                </div>
                {a.actor_name ? (
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <EmployeeAvatar role={a.actor_role} size="sm" />
                    <span className="truncate">{a.actor_name}</span>
                    {a.actor_role ? (
                      <span className="shrink-0 text-foreground-subtle">
                        · {t(`roles.${a.actor_role}`)}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {a.after_json ? (
                  <span className="text-caption max-w-72 truncate" dir="ltr" title={a.after_json}>
                    {a.after_json}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

function PrintJobsList() {
  const { t } = useTranslation()
  const toast = useToast()
  const errText = useErrText(t)
  const [rows, setRows] = useState<PrintJobRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const load = useCallback(() => {
    setLoadError(null)
    opsApi
      .printJobs(30)
      .then(setRows)
      .catch((e) => {
        setLoadError(errText(e))
        toast(errText(e), 'error')
      })
  }, [toast, errText])

  useEffect(() => {
    load()
  }, [load])

  async function testPrint() {
    setTesting(true)
    try {
      const o = await opsApi.printTest()
      toast(o.duplicate_suppressed ? t('print.duplicateSuppressed') : t('print.done'), 'success')
      load()
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          variant="outline"
          onClick={() => void testPrint()}
          disabled={testing}
          loading={testing}
        >
          {!testing ? <Printer size={16} aria-hidden /> : null}
          {t('reports.printTest')}
        </Button>
      </div>
      {rows === null ? (
        loadError ? (
          <ErrorState message={loadError} onRetry={load} retryLabel={t('app.retry')} />
        ) : (
          <TableSkeleton rows={5} columns={3} />
        )
      ) : rows.length === 0 ? (
        <EmptyState title={t('reports.noPrintJobs')} />
      ) : (
        <Card>
          <CardHeader title={t('reports.printJobs')} subtitle={t('reports.printJobsHint')} />
          <div className="flex flex-col divide-y divide-border-subtle">
            {rows.map((j) => (
              <div key={j.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-40 flex-1">
                  <p className="text-body font-bold">
                    <span className="tabular-nums">{j.doc_type}</span>{' '}
                    <span className="tabular-nums">#{j.id}</span>
                  </p>
                  <p className="min-w-0 text-caption">
                    <DisplayDateTime value={j.created_at} separator="" /> · {t('reports.attempts')}:{' '}
                    <span className="tabular-nums">{j.attempts}</span>
                  </p>
                </div>
                {j.error ? <span className="text-caption text-destructive">{j.error}</span> : null}
                <Badge variant={printJobBadgeVariant(j.status)} size="sm" dot>
                  {t([`reports.job.${j.status}`, j.status])}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}
