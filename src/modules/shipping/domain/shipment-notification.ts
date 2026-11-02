import {NOTIFICATION} from '../../notifications/domain/notification.contract';
import type {OrderNotification} from '../../orders/domain/order-notification';
import {SHIPMENT_STATUS,type ShipmentChange} from './shipping.contract';
const SHIPMENT_NOTIFICATION = {
  prefix:'shipment/', separator:'/', subject:'Suivi de votre commande',
  state:{
    [SHIPMENT_STATUS.pending]:'Le suivi de votre commande a été actualisé. Elle attend sa préparation.',
    [SHIPMENT_STATUS.preparing]:'Votre commande est en préparation.',
    [SHIPMENT_STATUS.shipped]:'Votre commande est en cours d’acheminement. Consultez son suivi actualisé dans Ufit.',
    [SHIPMENT_STATUS.delivered]:'La livraison de votre commande a été confirmée. Retrouvez son détail dans Ufit.',
    [SHIPMENT_STATUS.failed]:'Un incident a été signalé pour votre commande. Consultez les informations de la marque dans Ufit.',
    [SHIPMENT_STATUS.cancelled]:'L’expédition de votre commande a été annulée. Retrouvez son détail dans Ufit.',
  },
} as const;
export function shipmentNotification(change:ShipmentChange):OrderNotification {
  const {shipment}=change;
  return {orderId:shipment.orderId,resourceType:NOTIFICATION.resource.shipment,resourceId:shipment.id,
    eventKey:SHIPMENT_NOTIFICATION.prefix+shipment.id+SHIPMENT_NOTIFICATION.separator+shipment.version,
    subject:SHIPMENT_NOTIFICATION.subject,text:SHIPMENT_NOTIFICATION.state[shipment.status]};
}
