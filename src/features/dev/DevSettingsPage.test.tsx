import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import DevSettingsPage from './DevSettingsPage'

const mocks = vi.hoisted(() => ({
  user: { role: 'ADMIN' as 'ADMIN' | 'STAFF' },
  loadOfficial: vi.fn(),
  clear: vi.fn(),
  clearSessionToken: vi.fn(),
  clearLocalSession: vi.fn(),
}))
vi.mock('@/features/auth/useSession', () => ({
  useSession: () => ({
    user: mocks.user,
    clearSessionToken: mocks.clearSessionToken,
    clearLocalSession: mocks.clearLocalSession,
  }),
}))
vi.mock('@/services/developerApi', () => ({
  developerApi: {
    loadOfficial: mocks.loadOfficial,
    clear: mocks.clear,
    setReseedToken: vi.fn(),
    takeReseedToken: () => 'one-time-grant',
    clearReseedToken: vi.fn(),
  },
}))

function page() {
  return render(
    <ToastProvider>
      <DevSettingsPage />
    </ToastProvider>,
  )
}

describe('DevSettingsPage', () => {
  beforeEach(() => {
    mocks.user.role = 'ADMIN'
    mocks.loadOfficial.mockReset().mockResolvedValue(undefined)
    mocks.clear.mockReset().mockResolvedValue('one-time-grant')
    mocks.clearSessionToken.mockReset()
    mocks.clearLocalSession.mockReset()
  })

  it('hides the page from staff', () => {
    mocks.user.role = 'STAFF'
    page()
    expect(screen.queryByRole('heading', { name: 'إعدادات المطوّر' })).not.toBeInTheDocument()
  })

  it('loads official data and refreshes local application state', async () => {
    page()
    fireEvent.click(screen.getByRole('button', { name: 'تحميل بيانات رسمية' }))
    await waitFor(() => expect(mocks.loadOfficial).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mocks.clearLocalSession).toHaveBeenCalledTimes(1))
  })

  it('requires confirmation and clarifies the preserved developer account', () => {
    page()
    fireEvent.click(screen.getByRole('button', { name: 'مسح قاعدة البيانات بالكامل' }))
    const dialog = screen.getByRole('dialog', { name: 'تأكيد مسح قاعدة البيانات بالكامل' })
    expect(within(dialog).getByText(/سيتم الاحتفاظ بحساب المطور ADMIN فقط/)).toBeInTheDocument()
    expect(mocks.clear).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }))
    expect(
      screen.queryByRole('dialog', { name: 'تأكيد مسح قاعدة البيانات بالكامل' }),
    ).not.toBeInTheDocument()
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  it('clears only after confirm', async () => {
    page()
    fireEvent.click(screen.getByRole('button', { name: 'مسح قاعدة البيانات بالكامل' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'مسح قاعدة البيانات بالكامل',
      }),
    )
    await waitFor(() => expect(mocks.clear).toHaveBeenCalledTimes(1))
    expect(mocks.clearSessionToken).toHaveBeenCalledTimes(1)
  })
})
