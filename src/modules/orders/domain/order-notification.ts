import {NOTIFICATION} from '../../notifications/domain/notification.contract';
export const ORDER_NOTIFICATION = {
  event:{paid:'paid',cancelled:'cancelled',separator:'/',prefix:'order/'},
  recipient:{active:'active',memberActive:'active',roles:['brand_owner','brand_manager'] as const},
  copy:{
    paid:{subject:'Commande confirmée',text:'Le paiement de cette commande est confirmé. Retrouvez son détail dans Ufit.'},
    cancelled:{subject:'Commande annulée',text:'Cette commande a été annulée. Retrouvez son détail dans Ufit.'},
    refundedCancellation:{subject:'Commande annulée et remboursée',text:'Cette commande a été annulée et son remboursement confirmé. Le délai d’apparition dépend de votre banque.'},
  },
} as const;
export interface OrderNotification {
  orderId:string; resourceType:typeof NOTIFICATION.resource.order|typeof NOTIFICATION.resource.shipment|typeof NOTIFICATION.resource.orderReturn;
  resourceId:string;eventKey:string;subject:string;text:string;
}
export function paidOrderNotification(orderId:string):OrderNotification {
  return {orderId,resourceType:NOTIFICATION.resource.order,resourceId:orderId,
    eventKey:ORDER_NOTIFICATION.event.prefix+orderId+ORDER_NOTIFICATION.event.separator+ORDER_NOTIFICATION.event.paid,...ORDER_NOTIFICATION.copy.paid};
}
export function cancelledOrderNotification(orderId:string,refunded:boolean):OrderNotification {
  return {orderId,resourceType:NOTIFICATION.resource.order,resourceId:orderId,
    eventKey:ORDER_NOTIFICATION.event.prefix+orderId+ORDER_NOTIFICATION.event.separator+ORDER_NOTIFICATION.event.cancelled,
    ...(refunded?ORDER_NOTIFICATION.copy.refundedCancellation:ORDER_NOTIFICATION.copy.cancelled)};
}
