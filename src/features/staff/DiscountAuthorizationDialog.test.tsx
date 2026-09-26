/**
 * MANAGER+ configures ONE cashier's discount-authorization credential.
 *
 * The test asserts the security-relevant part of the contract: the value is
 * write-only (sent once, never read back or displayed) and a save is refused
 * locally when it is too short to be a Station credential.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '@/components/ui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/lib/i18n'
import { DiscountAuthorizationDialog } from './DiscountAuthorizationDialog'

const mocks = vi.hoisted(() => ({ setDiscountPassword: vi.fn() }))

vi.mock('@/services/posApi', () => ({
  staffApi: { setDiscountPassword: mocks.setDiscountPassword },
}))

function renderDialog(configured = false) {
  const onSaved = vi.fn()
  render(
    <ToastProvider>
      <DiscountAuthorizationDialog
        open
        userId={4}
        staffName="cashier"
        configured={configured}
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    </ToastProvider>,
  )
  return onSaved
}

describe('staff discount authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.setDiscountPassword.mockResolvedValue(undefined)
  })

  it('sends the credential once and never displays it back', async () => {
    const onSaved = renderDialog()

    const field = screen.getByLabelText('كلمة مرور تفويض الخصم')
    // Write-only: the field is a password input.
    expect(field).toHaveAttribute('type', 'password')

    fireEvent.change(field, { target: { value: 'approve123' } })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    await waitFor(() => expect(mocks.setDiscountPassword).toHaveBeenCalledWith(4, 'approve123'))
    expect(onSaved).toHaveBeenCalled()
    expect(screen.queryByDisplayValue('approve123')).not.toBeInTheDocument()
  })

  it('refuses a too-short credential before calling the backend', async () => {
    renderDialog()

    fireEvent.change(screen.getByLabelText('كلمة مرور تفويض الخصم'), {
      target: { value: '123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(mocks.setDiscountPassword).not.toHaveBeenCalled()
  })
})
