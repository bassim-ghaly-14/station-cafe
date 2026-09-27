/** Shift/day gate: guide staff to open them instead of blocking silently. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, CardHeader, useToast } from '@/components/ui'
import { Power } from '@/components/ui/icon'
import { Field, Input } from '@/components/ui/input'
import { shiftApi, type DayShiftState } from '@/services/shiftApi'
import { parseMajor } from '@/lib/utils'

export function ShiftGate({ state, onReady }: { state: DayShiftState; onReady: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [opening, setOpening] = useState(false)
  const [cash, setCash] = useState('')
  const [cashError, setCashError] = useState<string | null>(null)

  if (state.any_active_shift && !state.my_shift) {
    return (
      <Card>
        <CardHeader title={t('shift.someoneElseOpen')} subtitle={t('shift.someoneElseOpenHint')} />
      </Card>
    )
  }

  async function start() {
    setOpening(true)
    setCashError(null)
    try {
      const cashMinor =
        cash.trim() === ''
          ? 0
          : (parseMajor(cash) ??
            (() => {
              setCashError(t('shift.invalidCash'))
              throw new Error('bad-input')
            })())
      await shiftApi.openShift(cashMinor)
      onReady()
    } catch (e) {
      if ((e as Error).message !== 'bad-input') {
        toast(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']), 'error')
      }
    } finally {
      setOpening(false)
    }
  }

  return (
    <Card>
      <CardHeader title={t('pos.shiftRequired')} subtitle={t('pos.shiftRequiredHint')} />
      <div className="flex max-w-sm flex-col gap-3">
        <Field label={t('shift.openingCash')} error={cashError}>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={cash}
            onChange={(e) => setCash(e.target.value)}
            placeholder="0.00"
          />
        </Field>
        <Button
          size="lg"
          disabled={opening}
          loading={opening}
          onClick={() => void start()}
          className="bg-success-solid text-success-solid-foreground hover:bg-success-solid-hover active:bg-success-solid-active"
        >
          {!opening ? <Power size={20} aria-hidden /> : null}
          {t('shift.openShift')}
        </Button>
      </div>
    </Card>
  )
}
