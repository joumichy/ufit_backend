import {NOTIFICATION} from '../../notifications/domain/notification.contract';
import type {OrderNotification} from './order-notification';
import {RETURN_STATUS,type ReturnStatus} from './order-return.contract';
const RETURN_NOTIFICATION = {
  event:{prefix:'return/',refund:'refund/',separator:'/'},subject:'Suivi de votre retour Ufit',
  state:{
    [RETURN_STATUS.requested]:'Une demande de retour a été enregistrée. Retrouvez son détail dans Ufit.',
    [RETURN_STATUS.approved]:'Le retour est accepté. Consultez les instructions d’expédition dans Ufit.',
    [RETURN_STATUS.rejected]:'Le retour a été refusé. Consultez la décision et les possibilités de recours dans Ufit.',
    [RETURN_STATUS.disputed]:'Un arbitrage a été demandé pour ce retour. Retrouvez son état dans Ufit.',
    [RETURN_STATUS.inTransit]:'Les informations d’expédition du retour ont été actualisées. Consultez le suivi dans Ufit.',
    [RETURN_STATUS.refundPending]:'Le retour a été réceptionné et son remboursement est en cours de traitement.',
    [RETURN_STATUS.refundFailed]:'Le remboursement de ce retour n’a pas abouti. Consultez son état dans Ufit.',
    [RETURN_STATUS.refunded]:'Le remboursement de ce retour est confirmé. Le délai d’apparition dépend de votre banque.',
    [RETURN_STATUS.closed]:'Ce retour a été clôturé. Consultez la décision dans Ufit.',
    [RETURN_STATUS.withdrawn]:'La demande de retour a été retirée.',
  },
} as const;
export function returnNotification(orderId:string,returnId:string,revision:number,status:ReturnStatus):OrderNotification {
  return {orderId,resourceType:NOTIFICATION.resource.orderReturn,resourceId:returnId,
    eventKey:RETURN_NOTIFICATION.event.prefix+returnId+RETURN_NOTIFICATION.event.separator+revision,
    subject:RETURN_NOTIFICATION.subject,text:RETURN_NOTIFICATION.state[status]};
}
export function returnRefundNotification(orderId:string,returnId:string,attemptId:string,status:typeof RETURN_STATUS.refunded|typeof RETURN_STATUS.refundFailed):OrderNotification {
  return {orderId,resourceType:NOTIFICATION.resource.orderReturn,resourceId:returnId,subject:RETURN_NOTIFICATION.subject,text:RETURN_NOTIFICATION.state[status],
    eventKey:RETURN_NOTIFICATION.event.prefix+returnId+RETURN_NOTIFICATION.event.separator+RETURN_NOTIFICATION.event.refund+attemptId+RETURN_NOTIFICATION.event.separator+status};
}
