/**
 * The discount flow is: amount → authorization → applied.
 *
 * The amount is OPEN-ENDED (any value the order can carry, not only the
 * configured quick-picks), and NOTHING is applied before the authorization
 * dialog succeeds. These tests assert both halves of that contract.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastProvider } from '@/components/ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/lib/i18n'
import { formatMinorMoney } from '@/lib/money'
import { DiscountDialog } from './DiscountDialog'

const mocks = vi.hoisted(() => ({ setDiscount: vi.fn() }))

vi.mock('@/services/posApi', () => ({
  api: { setDiscount: mocks.setDiscount },
}))

const QUICK_PICKS = [2000, 5000, 10000]
const SUBTOTAL = 440_000

function renderDialog(
  initial: { mode: string | null; value: number | null } = {
    mode: null,
    value: null,
  },
) {
  const onApply = vi.fn()

  render(
    <ToastProvider>
      <DiscountDialog
        initial={initial}
        orderId={7}
        subtotal={SUBTOTAL}
        amounts={QUICK_PICKS}
        onClose={vi.fn()}
        onApply={onApply}
      />
    </ToastProvider>,
  )

  return onApply
}

/** Type an amount and press the continue button. */
function enterAmount(value: string) {
  fireEvent.change(screen.getByLabelText('قيمة الخصم'), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: 'متابعة' }))
}

/** The authorization dialog only — the amount dialog stays mounted behind it. */
function authorization() {
  return within(screen.getByRole('dialog', { name: 'الخصم يحتاج إلى صلاحية' }))
}

describe('DiscountDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.setDiscount.mockResolvedValue({ id: 7 })
  })

  it('accepts an open-ended amount, not only the configured quick-picks', () => {
    renderDialog()

    for (const amount of QUICK_PICKS) {
      expect(
        screen.getByRole('button', { name: formatMinorMoney(amount, { variant: 'auto' }) }),
      ).toBeInTheDocument()
    }

    // 1,000 EGP is well beyond every quick-pick and is still a valid amount.
    enterAmount('1000')
    expect(authorization().getByText(formatMinorMoney(100_000))).toBeInTheDocument()
    expect(mocks.setDiscount).not.toHaveBeenCalled()
  })

  it('refuses an amount the invoice cannot carry, before asking for a password', async () => {
    renderDialog()

    enterAmount('5000')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'الخصم لا يمكن أن يتجاوز إجمالي الطلب',
    )
    expect(screen.queryByRole('dialog', { name: 'الخصم يحتاج إلى صلاحية' })).not.toBeInTheDocument()
    expect(mocks.setDiscount).not.toHaveBeenCalled()
  })

  it('applies the discount only after the authorization succeeds', async () => {
    const onApply = renderDialog()

    enterAmount('50')
    fireEvent.change(authorization().getByLabelText('كلمة مرور تفويض الخصم'), {
      target: { value: 'approve123' },
    })
    fireEvent.click(authorization().getByRole('button', { name: 'تفويض الخصم' }))

    await waitFor(() => expect(mocks.setDiscount).toHaveBeenCalledWith(7, 5_000, 'approve123'))
    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith({ mode: 'FIXED', value: 5_000 }, { id: 7 }),
    )
  })

  it('reports a refused authorization and applies nothing', async () => {
    mocks.setDiscount.mockRejectedValue({ message: 'discount.authorization_failed' })
    renderDialog()

    enterAmount('50')
    fireEvent.change(authorization().getByLabelText('كلمة مرور تفويض الخصم'), {
      target: { value: 'wrong-one' },
    })
    fireEvent.click(authorization().getByRole('button', { name: 'تفويض الخصم' }))

    // Still on the authorization step, and the discount was never applied.
    expect(await authorization().findByRole('alert')).toHaveTextContent('تفويض الخصم غير صحيح')
    expect(mocks.setDiscount).toHaveBeenCalledTimes(1)
  })

  it('cancels the authorization without applying anything', () => {
    renderDialog()

    enterAmount('50')
    fireEvent.click(authorization().getByRole('button', { name: 'إلغاء' }))

    expect(screen.queryByRole('dialog', { name: 'الخصم يحتاج إلى صلاحية' })).not.toBeInTheDocument()
    expect(mocks.setDiscount).not.toHaveBeenCalled()
  })

  it('clears an applied discount without asking for a password', async () => {
    renderDialog({ mode: 'FIXED', value: 5000 })

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء الخصم' }))

    await waitFor(() => expect(mocks.setDiscount).toHaveBeenCalledWith(7, null, null))
  })
})
