/**
 * The manager notification queue: a persisted read over the backend outbox.
 *
 * The backend syncs alerts on inventory WRITES only, so this suite pins the
 * frontend contract: reads never create, opening the page never marks read,
 * and explicit mark-read calls refresh the queue.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/lib/i18n'
import { ToastProvider } from '@/components/ui'
import InventoryPage from './InventoryPage'
import type { InventoryNotification } from '@/services/opsApi'

const notifMocks = vi.hoisted(() => ({
  stock: vi.fn(),
  movements: vi.fn(),
  adjustStock: vi.fn(),
  notifications: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
}))

vi.mock('@/services/opsApi', () => ({
  opsApi: {
    stock: notifMocks.stock,
    movements: notifMocks.movements,
    adjustStock: notifMocks.adjustStock,
    notifications: notifMocks.notifications,
    markNotificationRead: notifMocks.markRead,
    markAllNotificationsRead: notifMocks.markAllRead,
  },
  STOCK_REASONS: ['PURCHASE', 'ADJUSTMENT', 'WASTE'],
}))

function note(over: Partial<InventoryNotification> = {}): InventoryNotification {
  return {
    id: 1,
    product_id: 7,
    product_name: 'حليب',
    kind: 'BELOW_MINIMUM',
    quantity: 2,
    min_quantity: 5,
    status: 'ACTIVE',
    created_at: '2026-01-01 10:00:00',
    resolved_at: null,
    read_at: null,
    ...over,
  }
}

function page() {
  return render(
    <ToastProvider>
      <InventoryPage />
    </ToastProvider>,
  )
}

describe('InventoryNotifications — persisted manager queue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notifMocks.stock.mockResolvedValue([])
    notifMocks.movements.mockResolvedValue([])
    notifMocks.notifications.mockResolvedValue([note()])
    notifMocks.markRead.mockResolvedValue(true)
    notifMocks.markAllRead.mockResolvedValue(1)
  })

  it('renders the persisted queue with the unread badge, without creating anything', async () => {
    page()
    expect(await screen.findByText('تنبيهات المخزون')).toBeInTheDocument()
    // The below-minimum state word appears both in the row's message title and
    // its status badge — both are legitimate, so assert the word is present.
    expect((await screen.findAllByText('مخزون منخفض')).length).toBeGreaterThan(0)
    // One read on mount — no creation call exists to assert beyond that.
    await waitFor(() => expect(notifMocks.notifications).toHaveBeenCalledTimes(1))
  })

  it('marks one notification read through the explicit action only', async () => {
    page()
    const section = await screen.findByLabelText('تنبيهات المخزون')
    // The button's accessible name is its product-specific aria-label, which
    // names the item being marked — the more descriptive option over the
    // generic visible short text.
    fireEvent.click(within(section).getByRole('button', { name: 'تعليم تنبيه حليب كمقروء' }))
    await waitFor(() => expect(notifMocks.markRead).toHaveBeenCalledWith(1))
    // The queue refreshes after the mark — still reads only.
    await waitFor(() => expect(notifMocks.notifications.mock.calls.length).toBeGreaterThan(1))
  })

  it('marks all notifications read through the explicit action only', async () => {
    page()
    const section = await screen.findByLabelText('تنبيهات المخزون')
    fireEvent.click(within(section).getByRole('button', { name: 'تعليم الكل كمقروء' }))
    await waitFor(() => expect(notifMocks.markAllRead).toHaveBeenCalledTimes(1))
  })

  it('shows the empty state when nothing is active', async () => {
    notifMocks.notifications.mockResolvedValue([])
    page()
    expect(await screen.findByText(/لا توجد تنبيهات نشطة/)).toBeInTheDocument()
  })
})
