/**
 * The monthly revenue targets card — the Dev Settings tests for the feature.
 *
 * They assert the behaviour the owner actually depends on:
 *
 *  - the two DEFAULTS are editable in whole pounds and save independently;
 *  - the ACTIVE month's override is per DEPARTMENT, so clearing one leaves the
 *    other alone — the whole reason overrides are not stored as one blob;
 *  - an empty override field means "follow the default", and the badge says so;
 *  - the month is the one the BACKEND named, never one the browser invented.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastProvider } from '@/components/ui'
import { formatMonthKey } from '@/lib/date'
import { DEFAULT_LOCALE } from '@/lib/i18n'
import { settingsApi, type RevenueTargetsView } from '@/services/posApi'
import { RevenueTargetsCard } from './RevenueTargetsCard'

vi.mock('@/services/posApi', async () => {
  const actual = await vi.importActual<typeof import('@/services/posApi')>('@/services/posApi')
  return {
    ...actual,
    settingsApi: {
      ...actual.settingsApi,
      revenueTargets: vi.fn(),
      setRevenueTargets: vi.fn(),
      setRevenueTargetOverride: vi.fn(),
    },
  }
})

/** Defaults only: the month follows both of them. */
const defaultsOnly: RevenueTargetsView = {
  month: '2026-10',
  defaults: { cafe_minor: 15_000_000, wash_minor: 8_000_000 },
  overrides: { cafe_minor: null, wash_minor: null },
  targets: [
    { month: '2026-10', department: 'CAFE', target_minor: 15_000_000, overridden: false },
    { month: '2026-10', department: 'WASH', target_minor: 8_000_000, overridden: false },
  ],
}

/** October overriding cafe only — the state that must stay unambiguous. */
const cafeOverridden: RevenueTargetsView = {
  ...defaultsOnly,
  overrides: { cafe_minor: 17_500_000, wash_minor: null },
  targets: [
    { month: '2026-10', department: 'CAFE', target_minor: 17_500_000, overridden: true },
    { month: '2026-10', department: 'WASH', target_minor: 8_000_000, overridden: false },
  ],
}

const renderCard = () =>
  render(
    <ToastProvider>
      <RevenueTargetsCard />
    </ToastProvider>,
  )

/**
 * Both sections label a department's field the same way, so the FIRST match is
 * the default field and the LAST is that department's override field. Naming
 * them once here keeps every test saying which one it is driving.
 */
function field(label: string, index: number) {
  return screen.getAllByLabelText(label)[index] as HTMLInputElement
}
const cafeDefault = () => field('هدف الكافيه الافتراضي', 0)
describe('RevenueTargetsCard', () => {
  beforeEach(() => {
    vi.mocked(settingsApi.revenueTargets).mockReset().mockResolvedValue(defaultsOnly)
    vi.mocked(settingsApi.setRevenueTargets).mockReset().mockResolvedValue(undefined)
    vi.mocked(settingsApi.setRevenueTargetOverride).mockReset().mockResolvedValue(undefined)
  })

  it('renders both departments and the month the backend named', async () => {
    renderCard()

    await waitFor(() => expect(cafeDefault()).toBeInTheDocument())
    expect(screen.getAllByLabelText('هدف المغسلة الافتراضي').length).toBeGreaterThan(0)
    // The stored amounts are shown in WHOLE POUNDS, not piastres.
    expect(cafeDefault()).toHaveValue('150000')
    expect(field('هدف المغسلة الافتراضي', 0)).toHaveValue('80000')
    // October 2026 — the month the BACKEND resolved, labelled by the shared month
    // formatter. The key stays canonical `YYYY-MM`; only the display is localized.
    expect(
      screen.getByText(`تجاوز هدف الشهر ${formatMonthKey('2026-10', DEFAULT_LOCALE)}`),
    ).toBeInTheDocument()
  })

  it('states that a month with no override is following the default', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId('override-badge-CAFE')).toBeInTheDocument())

    expect(screen.getByTestId('override-badge-CAFE')).toHaveTextContent('يتبع الافتراضي')
    expect(screen.getByTestId('override-badge-WASH')).toHaveTextContent('يتبع الافتراضي')
    // And the empty field shows the default it would fall back to.
    expect(cafeOverride()).toHaveAttribute('placeholder', '150000')
  })

  it('says so explicitly when a month IS overridden', async () => {
    vi.mocked(settingsApi.revenueTargets).mockResolvedValue(cafeOverridden)
    renderCard()

    await waitFor(() =>
      expect(screen.getByTestId('override-badge-CAFE')).toHaveTextContent('تجاوز خاص بهذا الشهر'),
    )
    // The other department is untouched: it still says it follows the default.
    expect(screen.getByTestId('override-badge-WASH')).toHaveTextContent('يتبع الافتراضي')
  })

  it('saves the two defaults together, in whole pounds', async () => {
    renderCard()
    await waitFor(() => expect(cafeDefault()).toHaveValue('150000'))

    fireEvent.change(cafeDefault(), { target: { value: '200000' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'حفظ' })[0])

    await waitFor(() =>
      expect(settingsApi.setRevenueTargets).toHaveBeenCalledWith({
        cafe_minor: 20_000_000,
        wash_minor: 8_000_000,
      }),
    )
  })

  /** A fraction is not a target Station can hold, so it never reaches state. */
  it('refuses a decimal or a negative target at the keystroke', async () => {
    renderCard()
    await waitFor(() => expect(cafeDefault()).toHaveValue('150000'))

    fireEvent.change(cafeDefault(), { target: { value: '1500.5' } })
    fireEvent.change(cafeDefault(), { target: { value: '-100' } })
    fireEvent.change(cafeDefault(), { target: { value: 'abc' } })

    // The field still holds the last whole number it accepted.
    expect(cafeDefault()).toHaveValue('150000')
    expect(settingsApi.setRevenueTargets).not.toHaveBeenCalled()
  })

  it('sets ONE department override without touching the other', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId('override-badge-CAFE')).toBeInTheDocument())

    fireEvent.change(cafeOverride(), { target: { value: '175000' } })
    // Save within the cafe override's own card, not the defaults section.
    const cafeCard = screen.getByTestId('override-badge-CAFE').closest('div.rounded-md')!
    fireEvent.click(within(cafeCard as HTMLElement).getByRole('button', { name: 'حفظ' }))

    await waitFor(() =>
      expect(settingsApi.setRevenueTargetOverride).toHaveBeenCalledWith('CAFE', 17_500_000),
    )
    // Wash was never sent: overriding cafe must not rewrite its sibling.
    expect(settingsApi.setRevenueTargetOverride).not.toHaveBeenCalledWith('WASH', expect.anything())
  })

  /** Clearing one override must never disturb the other department's. */
  it('clears one override by sending an empty amount for that department alone', async () => {
    vi.mocked(settingsApi.revenueTargets).mockResolvedValue(cafeOverridden)
    renderCard()

    await waitFor(() =>
      expect(screen.getByTestId('override-badge-CAFE')).toHaveTextContent('تجاوز خاص بهذا الشهر'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'إزالة التجاوز' }))

    await waitFor(() =>
      // `null` is the explicit "no override" — the backend then restores the
      // default for this department only.
      expect(settingsApi.setRevenueTargetOverride).toHaveBeenCalledWith('CAFE', null),
    )
  })

  it('offers no clear action when the month has no override to remove', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId('override-badge-CAFE')).toBeInTheDocument())

    expect(screen.queryByRole('button', { name: 'إزالة التجاوز' })).not.toBeInTheDocument()
  })

  it('reports a refused save instead of leaving the draft looking saved', async () => {
    vi.mocked(settingsApi.setRevenueTargets).mockRejectedValue({ message: 'auth.forbidden' })
    renderCard()
    await waitFor(() => expect(cafeDefault()).toHaveValue('150000'))

    fireEvent.change(cafeDefault(), { target: { value: '200000' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'حفظ' })[0])

    expect(await screen.findByText('ليس لديك صلاحية لتنفيذ هذا الإجراء')).toBeInTheDocument()
    // The screen never re-reads after a refusal, so the draft stays visibly
    // unsaved and the save button stays available.
    expect(settingsApi.revenueTargets).toHaveBeenCalledTimes(1)
  })
})
const cafeOverride = () => field('هدف الكافيه الافتراضي', 1)
