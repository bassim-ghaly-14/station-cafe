/** Live order panel: action row (discount / customer / ticket / ready). */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import { Check, Percent, Ticket, User } from '@/components/ui/icon'
import { useToast } from '@/components/ui'
import { api, type PosOrder } from '@/services/posApi'

export function ActionRow({
  order,
  hasWash,
  onDiscount,
  onCustomer,
  onReady,
  onRefresh,
}: {
  order: PosOrder
  hasWash: boolean
  onDiscount: () => void
  onCustomer: () => void
  onReady: () => void
  onRefresh: (o: PosOrder) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const report = (e: unknown) =>
    toast(t([`errors.${(e as { message: string }).message}`, 'errors.internal_error']), 'error')

  return (
    <div className="mb-3 flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={onDiscount}>
        <Percent size={16} aria-hidden />
        {t('pos.discount')}
      </Button>
      <Button variant="outline" size="sm" onClick={onCustomer}>
        <User size={16} aria-hidden />
        {t('pos.customerCar')}
        {order.customer_id ? ' ✓' : ''}
      </Button>
      {hasWash ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            api
              .ticket(order.id)
              .then((tk) => {
                toast(t('pos.ticketIssued', { no: tk.waiting_no }), 'success')
                return api.getOrder(order.id)
              })
              .then(onRefresh)
              .catch(report)
          }
        >
          <Ticket size={16} aria-hidden />
          {t('pos.washTicket')}
          {order.waiting_no ? ` (#${order.waiting_no})` : ''}
        </Button>
      ) : null}
      <Button variant="secondary" size="sm" onClick={onReady} disabled={order.lines.length === 0}>
        <Check size={16} aria-hidden />
        {t('pos.requestPayment')}
      </Button>
    </div>
  )
}
