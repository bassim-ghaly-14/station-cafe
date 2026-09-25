import { useMemo } from 'react'
import type { LucideIcon } from '@/components/ui/icon'
import { BarChart3, Coffee, Droplets, Wallet } from '@/components/ui/icon'

export type AnalyticsCategory = { id: string; label: string; value: number; color: string }
export type AnalyticsChart = {
  id: string
  title: string
  description: string
  total: number
  unit: 'EGP'
  categories: AnalyticsCategory[]
  icon: LucideIcon
  exportFilename: string
}

export type AnalyticsReportState = {
  data: AnalyticsChart[]
  loading: boolean
  error: string | null
}

/** Static UI fixture only. Replace this function with a report query when the reporting layer is ready. */
export function getMockCharts(): AnalyticsReportState {
  return {
    loading: false,
    error: null,
    data: [
      {
        id: 'laundry-cafe',
        title: 'المغسلة مقابل الكافيه',
        description: 'توزيع الإيرادات حسب النشاط',
        total: 18_640_00,
        unit: 'EGP',
        categories: [
          { id: 'laundry', label: 'المغسلة', value: 11_180_00, color: 'var(--primary)' },
          { id: 'cafe', label: 'كافيه', value: 7_460_00, color: 'var(--info)' },
        ],
        icon: Droplets,
        exportFilename: 'station-laundry-cafe',
      },
      {
        id: 'cash-visa',
        title: 'كاش مقابل فيزا',
        description: 'توزيع المبيعات حسب طريقة الدفع',
        total: 24_820_00,
        unit: 'EGP',
        categories: [
          { id: 'cash', label: 'كاش', value: 15_730_00, color: 'var(--success)' },
          { id: 'visa', label: 'فيزا', value: 9_090_00, color: 'var(--info)' },
        ],
        icon: Wallet,
        exportFilename: 'station-cash-visa',
      },
      {
        id: 'sales-expenses',
        title: 'المبيعات مقابل المصروفات',
        description: 'مقارنة المبيعات بالمصروفات التشغيلية',
        total: 125_400_00,
        unit: 'EGP',
        categories: [
          { id: 'sales', label: 'المبيعات', value: 102_400_00, color: 'var(--success)' },
          { id: 'expenses', label: 'المصروفات', value: 23_000_00, color: 'var(--destructive)' },
        ],
        icon: BarChart3,
        exportFilename: 'station-sales-expenses',
      },
    ],
  }
}

export function useAnalyticsCharts(): AnalyticsReportState {
  return useMemo(() => getMockCharts(), [])
}

export function chartIconFor(chart: AnalyticsChart) {
  return chart.icon ?? Coffee
}
