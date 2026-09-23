/**
 * Manager reports UI — exposes the existing report service: sales by day,
 * product sales, audit log and print job history. No new reporting engine.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState, LoadingState } from '@/components/states'
import { Badge, Button, Card, CardHeader, DateRangePicker, MoneyDisplay } from '@/components/ui'
import { Field, Input } from '@/components/ui/input'
import { BarChart3, Printer } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { addDays, todayIso } from '@/lib/date'
import {
  opsApi,
  type AuditEntry,
  type PrintJobRow,
  type ProductSales,
  type SalesByDay,
} from '@/services/opsApi'
import { useErrText } from '@/lib/err'

type Tab = 'sales' | 'products' | 'audit' | 'print'

export default function ReportsPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('sales')
  // Default period: the last seven local business days, as `YYYY-MM-DD` strings.
  const today = todayIso()
  const weekAgo = addDays(today, -6)
  const [from, setFrom] = useState(weekAgo)
  const [to, setTo] = useState(today)

  const TABS: { id: Tab; label: string }[] = [
    { id: 'sales', label: t('reports.sales') },
    { id: 'products', label: t('reports.products') },
    { id: 'audit', label: t('nav.audit') },
    { id: 'print', label: t('reports.printJobs') },
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
          <LoadingState label={t('app.loading')} />
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
                  <td className="py-2 text-body" dir="ltr">
                    {r.day_date}
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
          <LoadingState label={t('app.loading')} />
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
                <tr key={`${r.product_name}-${r.department}`} className="border-b border-border-subtle">
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
          <LoadingState label={t('app.loading')} />
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
                  <p className="text-caption" dir="ltr">
                    {a.created_at}
                    {a.entity_type
                      ? ` · ${a.entity_type}${a.entity_id ? `#${a.entity_id}` : ''}`
                      : ''}
                  </p>
                </div>
                {a.actor_name ? (
                  <Badge tone="neutral">
                    {a.actor_name} · {a.actor_role ? t(`roles.${a.actor_role}`) : ''}
                  </Badge>
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
          <LoadingState label={t('app.loading')} />
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
                  <p className="text-body font-bold" dir="ltr">
                    {j.doc_type} #{j.id}
                  </p>
                  <p className="text-caption" dir="ltr">
                    {j.created_at} · {t('reports.attempts')}: {j.attempts}
                  </p>
                </div>
                {j.error ? <span className="text-caption text-destructive">{j.error}</span> : null}
                <Badge
                  tone={
                    j.status === 'DONE' ? 'success' : j.status === 'FAILED' ? 'danger' : 'warning'
                  }
                >
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
