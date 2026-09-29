/**
 * Printer settings contract.
 *
 * The form exists so a printer can actually be pointed at the Xprinter, which
 * means three things must hold: only a MANAGER sees it, every save goes through
 * the EXISTING `set_print_config` command with the value exactly as typed, and
 * the panel is told what was stored so the two can never disagree.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui'
import '@/lib/i18n'
import type { PrintConfig } from '@/services/opsApi'
import { PrinterSettings } from './PrinterSettings'

const mocks = vi.hoisted(() => ({
  setPrintConfig: vi.fn(),
  session: { current: null as { user: { role: string } } | null },
}))

vi.mock('@/services/opsApi', () => ({
  opsApi: { setPrintConfig: mocks.setPrintConfig },
}))

// The role is the ONLY thing this form reads from the session, so the session is
// stubbed at its own boundary rather than driving a real login through the
// transport.
vi.mock('@/features/auth/useSession', () => ({
  useOptionalSession: () => mocks.session.current,
}))

const CONFIG: PrintConfig = {
  target: 'none',
  arabic_mode: 'CP1256',
  codepage: 22,
  logo: true,
  duplicate_window_secs: 60,
}

/**
 * The same shape the print panel uses: it owns the loaded configuration and
 * hands it down. The form is therefore CONTROLLED, and a test that pretended
 * otherwise would be testing a component the application never renders.
 */
function Harness({ onChanged }: Readonly<{ readonly onChanged: (next: PrintConfig) => void }>) {
  const [config, setConfig] = useState<PrintConfig>(CONFIG)
  return (
    <PrinterSettings
      config={config}
      onChanged={(next) => {
        setConfig(next)
        onChanged(next)
      }}
    />
  )
}

function renderAs(role: 'ADMIN' | 'MANAGER' | 'STAFF' | null, onChanged = vi.fn()) {
  mocks.session.current = role ? { user: { role } } : null
  return render(
    <div dir="rtl">
      <ToastProvider>
        <Harness onChanged={onChanged} />
      </ToastProvider>
    </div>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.current = { user: { role: 'MANAGER' } }
  mocks.setPrintConfig.mockResolvedValue(undefined)
})

describe('PrinterSettings', () => {
  it('is offered to a manager and to an admin', () => {
    renderAs('MANAGER')
    expect(screen.getByLabelText('اسم طابعة ويندوز')).toBeInTheDocument()
    renderAs('ADMIN')
    expect(screen.getAllByLabelText('اسم طابعة ويندوز')).toHaveLength(2)
  })

  it('is not offered to a cashier, who could not save it anyway', () => {
    // Presentation only: the backend refuses the write regardless, but a
    // cashier must never be shown a control that cannot work.
    renderAs('STAFF')
    expect(screen.queryByLabelText('اسم طابعة ويندوز')).not.toBeInTheDocument()
  })

  it('claims nothing when the session cannot be resolved', () => {
    renderAs(null)
    expect(screen.queryByLabelText('اسم طابعة ويندوز')).not.toBeInTheDocument()
  })

  it('sends the target exactly as typed, never a normalized form of it', async () => {
    const onChanged = vi.fn()
    renderAs('MANAGER', onChanged)
    const target = screen.getByLabelText('اسم طابعة ويندوز')

    // Typed, not pasted-into-place: the save happens on blur, so a half-typed
    // name is never written over a working one.
    fireEvent.change(target, { target: { value: '\\\\localhost\\XP80' } })
    expect(mocks.setPrintConfig).not.toHaveBeenCalled()

    fireEvent.focusOut(target)
    await waitFor(() => expect(mocks.setPrintConfig).toHaveBeenCalledTimes(1))
    // The raw value, verbatim: interpreting a queue name is the printing
    // service's job, not the form's.
    expect(mocks.setPrintConfig).toHaveBeenCalledWith({
      ...CONFIG,
      target: '\\\\localhost\\XP80',
    })
    expect(onChanged).toHaveBeenCalledWith({ ...CONFIG, target: '\\\\localhost\\XP80' })
  })

  it('keeps the existing values and only changes the one being edited', async () => {
    renderAs('MANAGER')
    const mode = screen.getByLabelText('طريقة عرض العربية')

    fireEvent.change(mode, { target: { value: 'LATIN' } })
    fireEvent.focusOut(mode)

    await waitFor(() =>
      expect(mocks.setPrintConfig).toHaveBeenCalledWith({ ...CONFIG, arabic_mode: 'LATIN' }),
    )
    // The printer itself is untouched by a change to the Arabic rendering.
    expect(mocks.setPrintConfig.mock.calls[0][0].target).toBe(CONFIG.target)
  })

  it('saves nothing when a field is left exactly as it was', () => {
    renderAs('MANAGER')
    const target = screen.getByLabelText('اسم طابعة ويندوز')

    fireEvent.focusOut(target)

    expect(mocks.setPrintConfig).not.toHaveBeenCalled()
  })

  it('confirms a saved setting', async () => {
    renderAs('MANAGER')
    const target = screen.getByLabelText('اسم طابعة ويندوز')

    fireEvent.change(target, { target: { value: 'XP80' } })
    fireEvent.focusOut(target)

    expect(await screen.findByText('تم حفظ إعداد الطابعة')).toBeInTheDocument()
  })

  it('reports a refusal and never claims the setting was saved', async () => {
    mocks.setPrintConfig.mockRejectedValue({ message: 'internal_error' })
    const onChanged = vi.fn()
    renderAs('MANAGER', onChanged)
    const target = screen.getByLabelText('اسم طابعة ويندوز')

    fireEvent.change(target, { target: { value: 'XP80' } })
    fireEvent.focusOut(target)

    expect(await screen.findByText('حدث خطأ غير متوقع، حاول مرة أخرى')).toBeInTheDocument()
    expect(screen.queryByText('تم حفظ إعداد الطابعة')).not.toBeInTheDocument()
    // The panel is told nothing, so it cannot display a value that was refused.
    expect(onChanged).not.toHaveBeenCalled()
  })
})
