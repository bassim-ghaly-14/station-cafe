/** Shift/day gate: guide staff to open them instead of blocking silently. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, CardHeader } from '@/components/ui'
import { Field, Input } from '@/components/ui/input'
import { useToast } from '@/components/ui'
import { shiftApi } from '@/services/shiftApi'
import { parseMajor } from '@/lib/utils'

export function ShiftGate({ onReady }: { onReady: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [opening, setOpening] = useState(false)
  const [cash, setCash] = useState('')
  const [cashError, setCashError] = useState<string | null>(null)

  async function start() {
    setOpening(true)
    setCashError(null)
    try {
      const st = await shiftApi.state()
      if (!st.day) {
        try {
          await shiftApi.openDay()
        } catch (e) {
          const again = await shiftApi.state()
          if (!again.day) throw e
        }
      }
      const st2 = await shiftApi.state()
      if (!st2.my_shift) {
        const cashMinor =
          cash.trim() === ''
            ? 0
            : (parseMajor(cash) ??
              (() => {
                setCashError(t('shift.invalidCash'))
                throw new Error('bad-input')
              })())
        await shiftApi.openShift(cashMinor)
      }
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
        <Button size="lg" disabled={opening} onClick={() => void start()}>
          {t('shift.openShift')}
        </Button>
      </div>
    </Card>
  )
}
