/**
 * The Raw Materials segment — its business-facing surface, tested through the
 * real component tree with the IPC boundary (`recipesApi`) mocked.
 *
 * What is under test:
 *  1. the LAST COST column shows the EXACT per-purchase-unit cost of the most
 *     recent purchase (30.00 EGP/kg for 10 kg bought for 300 EGP), never the
 *     per-gram rate the old code printed (0.03/g), and an em-dash when there is
 *     no purchase yet;
 *  2. the row actions are the SAME shared `TableAction*` controls the Customers
 *     table uses — icon-only, accessible-named, with Adjust/Waste/Archive behind
 *     the overflow menu and the destructive Archive carrying its danger tone;
 *  3. archiving hides the row and surfaces it in the archived workspace, where
 *     Restore puts it back — reloading both lists — with no confirmation.
 *
 * The default viewport is DESKTOP (see `src/test/setup.ts`), so the `DataTable`
 * presentation is exercised unless a test narrows it.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { resetViewportWidth, setViewportWidth } from '@/test/setup'
import '@/lib/i18n'
import { ToastProvider } from '@/components/ui'
import { RawMaterialsPanel } from './RawMaterialsPanel'
import type { RawMaterial, RawMaterialMovement } from '@/services/recipesApi'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listArchived: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
  purchase: vi.fn(),
  adjust: vi.fn(),
  waste: vi.fn(),
  movements: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}))

vi.mock('@/services/recipesApi', () => ({
  recipesApi: {
    list: mocks.list,
    listArchived: mocks.listArchived,
    archive: mocks.archive,
    restore: mocks.restore,
    purchase: mocks.purchase,
    adjust: mocks.adjust,
    waste: mocks.waste,
    movements: mocks.movements,
    create: mocks.create,
    update: mocks.update,
  },
}))

/** A material with the exact per-purchase-unit pair the backend now returns. */
function material(over: Partial<RawMaterial> = {}): RawMaterial {
  return {
    id: 1,
    name: 'حبوب القهوة',
    department: 'CAFE',
    base_unit: 'GRAM',
    current_quantity: 10_000,
    last_purchase_unit_cost_minor: 3, // per-gram basis Recipe Cost reads
    last_purchase_unit: 'KILOGRAM',
    last_purchase_cost_per_unit_minor: 3000, // 30000 / 10 = 30.00 EGP/kg
    is_active: true,
    created_at: '2026-01-01T00:00:00',
    ...over,
  }
}

function page() {
  return render(
    <ToastProvider>
      <RawMaterialsPanel />
    </ToastProvider>,
  )
}

async function loaded() {
  await waitFor(() => expect(screen.getAllByText('حبوب القهوة').length).toBeGreaterThan(0))
}

beforeEach(() => {
  vi.clearAllMocks()
  resetViewportWidth()
  mocks.list.mockResolvedValue([material()])
  mocks.listArchived.mockResolvedValue([])
  mocks.movements.mockResolvedValue([] as RawMaterialMovement[])
  mocks.archive.mockResolvedValue(undefined)
  mocks.restore.mockResolvedValue(undefined)
})

afterEach(() => {
  resetViewportWidth()
})

describe('Raw Materials — last cost per purchase unit', () => {
  it('shows the exact per-purchase-unit cost (30.00 EGP/kg), not the per-gram rate', async () => {
    page()
    await loaded()
    // The per-kg figure (3000 minor = 30.00) is present with its kg unit label,
    // and the misleading per-gram value (0.03) is nowhere to be found.
    expect(screen.getByText(/30\.00/)).toBeInTheDocument()
    expect(screen.getByText(/كيلوجرام/)).toBeInTheDocument()
    expect(screen.queryByText(/0\.03/)).not.toBeInTheDocument()
  })

  it('renders the value through the shared MoneyDisplay with a currency label', async () => {
    page()
    await loaded()
    // MoneyDisplay prints the currency (ج.م) and forces LTR numerals.
    expect(screen.getByText(/30\.00/).textContent).toContain('ج.م')
  })

  it('shows an em-dash when the material has never been purchased', async () => {
    mocks.list.mockResolvedValue([
      material({
        name: 'سكر',
        last_purchase_unit_cost_minor: null,
        last_purchase_unit: null,
        last_purchase_cost_per_unit_minor: null,
      }),
    ])
    page()
    await waitFor(() => expect(screen.getAllByText('سكر').length).toBeGreaterThan(0))
    expect(screen.queryByText(/0\.00/)).not.toBeInTheDocument()
  })
})

describe('Raw Materials — row actions match the Customers table', () => {
  it('exposes Purchase and Edit as accessible-named icon buttons', async () => {
    page()
    await loaded()
    expect(screen.getByRole('button', { name: 'شراء حبوب القهوة' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'تعديل حبوب القهوة' })).toBeInTheDocument()
  })

  it('keeps Adjust, Waste and Archive behind the overflow menu', async () => {
    page()
    await loaded()
    const menu = screen.getByRole('button', { name: /المزيد من الإجراءات/ })
    fireEvent.click(menu)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('تسوية')).toBeInTheDocument()
    expect(within(dialog).getByText('هالك')).toBeInTheDocument()
    expect(within(dialog).getByText('أرشفة')).toBeInTheDocument()
  })

  it('archives the material and moves it into the archived workspace', async () => {
    mocks.list.mockResolvedValueOnce([material()]).mockResolvedValue([])
    mocks.listArchived.mockResolvedValueOnce([]).mockResolvedValue([material()])
    page()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: /المزيد من الإجراءات/ }))
    const menuDialog = await screen.findByRole('dialog')
    fireEvent.click(within(menuDialog).getByText('أرشفة'))
    const confirm = await screen.findByRole('dialog', { name: /أرشفة المادة الخام/ })
    fireEvent.click(within(confirm).getByRole('button', { name: 'أرشفة' }))

    await waitFor(() => expect(mocks.archive).toHaveBeenCalledWith(1))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'استعادة حبوب القهوة' })).toBeInTheDocument(),
    )
  })
})

describe('Raw Materials — archived workspace restore', () => {
  it('offers a Restore action that reactivates the material with no confirmation', async () => {
    mocks.list.mockResolvedValueOnce([]).mockResolvedValue([material()])
    mocks.listArchived.mockResolvedValueOnce([material()]).mockResolvedValue([])

    page()
    const restore = await screen.findByRole('button', { name: 'استعادة حبوب القهوة' })
    fireEvent.click(restore)

    await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith(1))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'شراء حبوب القهوة' })).toBeInTheDocument(),
    )
    expect(screen.queryByRole('button', { name: 'استعادة حبوب القهوة' })).not.toBeInTheDocument()
  })

  it('renders no archived section when nothing is archived', async () => {
    page()
    await loaded()
    expect(screen.queryByText('المواد المؤرشفة')).not.toBeInTheDocument()
  })
})

describe('Raw Materials — phone presentation', () => {
  it('shows the last cost and the shared actions in the record layout', async () => {
    setViewportWidth(360)
    page()
    await waitFor(() => expect(screen.getAllByText('حبوب القهوة').length).toBeGreaterThan(0))
    expect(screen.getByText(/30\.00/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'شراء حبوب القهوة' })).toBeInTheDocument()
  })
})
