import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionProvider, useSession } from './useSession'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

function LoginProbe() {
  const { login } = useSession()
  return (
    <button onClick={() => void login('Belly', 'test-password')}>login</button>
  )
}

describe('SessionProvider login IPC', () => {
  beforeEach(() => {
    invoke.mockReset()
    localStorage.clear()
    invoke.mockResolvedValue({
      token: 'session-token',
      user: {
        id: 1,
        name: 'Belly',
        phone: null,
        role: 'ADMIN',
        status: 'ACTIVE',
        created_at: '',
        updated_at: '',
      },
    })
  })

  it('submits the user name through the real login command contract', async () => {
    render(
      <SessionProvider>
        <LoginProbe />
      </SessionProvider>,
    )

    await waitFor(() => expect(invoke).not.toHaveBeenCalledWith('me', expect.anything()))
    await act(async () => screen.getByRole('button', { name: 'login' }).click())

    expect(invoke).toHaveBeenCalledWith('login', {
      input: { name: 'Belly', password: 'test-password' },
    })
    expect(localStorage.getItem('station.session.token')).toBe('session-token')
  })
})
