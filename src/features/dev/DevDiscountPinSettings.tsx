/**
 * The Dev Settings "Shared discount PIN" section.
 *
 * One setting, one state: whether a PIN exists, and the button that opens the
 * dialog that changes it. The PIN itself stays write-only and is owned by the
 * page — this section only reports whether one is configured.
 */
import { useTranslation } from 'react-i18next'
import { Badge, Button } from '@/components/ui'
import { Lock } from '@/components/ui/icon'

export function DevDiscountPinSettings({
  configured,
  onOpen,
}: {
  configured: boolean
  onOpen: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-3 md:col-span-2">
      <h3 className="font-bold text-foreground">{t('dev.discountPin')}</h3>

      <p className="text-sm text-foreground-muted">{t('dev.discountPinHelp')}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={configured ? 'success' : 'neutral'} size="sm" dot>
          {configured ? t('dev.discountPinConfigured') : t('dev.discountPinUnconfigured')}
        </Badge>

        <Button variant="secondary" onClick={onOpen}>
          <Lock size={16} aria-hidden />
          {configured ? t('dev.changeDiscountPin') : t('dev.setDiscountPin')}
        </Button>
      </div>
    </div>
  )
}
