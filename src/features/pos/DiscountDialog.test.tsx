/**
 * The discount selector may only offer admin-configured FIXED amounts, always
 * behind an authorization password. There is no percentage and no free amount:
 * the test asserts both the offered options and the ABSENCE of any input the
 * user could type a discount into.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '@/components/ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/lib/i18n'
import { formatMinorMoney } from '@/lib/money'
import { DiscountDialog } from './DiscountDialog'

const mocks = vi.hoisted(() => ({ setDiscount: vi.fn() }))

vi.mock('@/services/posApi', () => ({
  api: { setDiscount: mocks.setDiscount },
}))

const OPTIONS = [2000, 5000, 10000]

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
        amounts={OPTIONS}
        onClose={vi.fn()}
        onApply={onApply}
      />
    </ToastProvider>,
  )

  return onApply
}

describe('DiscountDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.setDiscount.mockResolvedValue({ id: 7 })
  })

  it('offers exactly the configured options and nothing to type', () => {
    renderDialog()

    for (const amount of OPTIONS) {
      expect(
        screen.getByRole('button', { name: formatMinorMoney(amount, { variant: 'auto' }) }),
      ).toBeInTheDocument()
    }

    // The only text field is the authorization password: no amount, no percent.
    const inputs = Array.from(document.querySelectorAll('input'))
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toHaveAttribute('type', 'password')
    // The removed percentage model leaves no trace in the UI.
    expect(screen.queryByText('%')).not.toBeInTheDocument()
    expect(screen.queryByText('نسبة الخصم % (0 – 100)')).not.toBeInTheDocument()
  })

  it('requires the authorization password before applying an option', async () => {
    const onApply = renderDialog()

    fireEvent.click(
      screen.getByRole('button', { name: formatMinorMoney(5000, { variant: 'auto' }) }),
    )

    const confirm = screen.getByRole('button', { name: 'تأكيد' })
    expect(confirm).toBeDisabled()
    expect(mocks.setDiscount).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('كلمة مرور تفويض الخصم'), {
      target: { value: 'approve123' },
    })
    expect(confirm).toBeEnabled()

    fireEvent.click(confirm)

    await waitFor(() => expect(mocks.setDiscount).toHaveBeenCalledWith(7, 5000, 'approve123'))
    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith({ mode: 'FIXED', value: 5000 }, { id: 7 }),
    )
  })

  it('reports a refused authorization and applies nothing', async () => {
    mocks.setDiscount.mockRejectedValue({ message: 'discount.password_incorrect' })
    renderDialog()

    fireEvent.click(
      screen.getByRole('button', { name: formatMinorMoney(5000, { variant: 'auto' }) }),
    )
    fireEvent.change(screen.getByLabelText('كلمة مرور تفويض الخصم'), {
      target: { value: 'wrong-one' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('كلمة مرور تفويض الخصم غير صحيحة')
  })

  it('clears an applied discount without asking for a password', async () => {
    renderDialog({ mode: 'FIXED', value: 5000 })

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء الخصم' }))

    await waitFor(() => expect(mocks.setDiscount).toHaveBeenCalledWith(7, null, null))
  })
})
