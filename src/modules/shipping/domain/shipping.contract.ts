import {ConflictException} from '@nestjs/common';
import {z} from 'zod';
import {ORDER_STATUS, type OrderStatus} from '../../orders/domain/order-lifecycle';
import {parcelTrackingFields} from '../../../shared/domain/parcel-tracking';

export const SHIPMENT_STATUS = {
  pending: 'pending', preparing: 'preparing', shipped: 'shipped', delivered: 'delivered', failed: 'failed', cancelled: 'cancelled',
} as const;
export type ShipmentStatus = typeof SHIPMENT_STATUS[keyof typeof SHIPMENT_STATUS];
export const SHIPPING = {
  repository: 'ShipmentRepository',
  route: {root: 'shipping', action: 'shipments/:id/actions', id: 'id'},
  roles: ['brand_owner', 'brand_manager', 'admin', 'super_admin'] as const,
  revision: {initial: 1, step: 1, maximum: 2147483647},
  limit: {minimumText: 1, incident: 2000, singleRow: 1},
  persistence: {lock: 'update', historyReason: 'brand_shipment_updated'},
  protocol: {actionField: 'action'},
  failure: {
    input: {code: 'shipment_action_invalid', message: 'Invalid shipment action'},
    changed: {code: 'shipment_version_changed', message: 'The shipment changed; refresh before continuing'},
    state: {code: 'order_shipping_state_changed', message: 'The order no longer accepts this shipment action'},
    missing: {code: 'shipment_not_found', message: 'Shipment not found'},
  },
  constraint: {status: 'shipments_status_known', version: 'shipments_version_positive', incident: 'shipments_incident_consistent'},
} as const;
export const SHIPMENT_ACTION = {
  prepare: 'prepare', ship: 'ship', deliver: 'deliver', reportIncident: 'report_incident', resolveIncident: 'resolve_incident', updateTracking: 'update_tracking',
} as const;
export type ShipmentActionName = typeof SHIPMENT_ACTION[keyof typeof SHIPMENT_ACTION];
const expectedVersion = z.number().int().min(SHIPPING.revision.initial).max(SHIPPING.revision.maximum - SHIPPING.revision.step);
export const shipmentActionSchema = z.discriminatedUnion(SHIPPING.protocol.actionField, [
  z.object({action: z.literal(SHIPMENT_ACTION.prepare), expectedVersion}).strict(),
  z.object({action: z.literal(SHIPMENT_ACTION.ship), expectedVersion, ...parcelTrackingFields}).strict(),
  z.object({action: z.literal(SHIPMENT_ACTION.deliver), expectedVersion}).strict(),
  z.object({action: z.literal(SHIPMENT_ACTION.reportIncident), expectedVersion, incidentReason: z.string().trim().min(SHIPPING.limit.minimumText).max(SHIPPING.limit.incident)}).strict(),
  z.object({action: z.literal(SHIPMENT_ACTION.resolveIncident), expectedVersion}).strict(),
  z.object({action: z.literal(SHIPMENT_ACTION.updateTracking), expectedVersion, ...parcelTrackingFields}).strict(),
]);
export type ShipmentAction = z.infer<typeof shipmentActionSchema>;
export interface Shipment {
  id: string; orderId: string; brandId: string; version: number; status: ShipmentStatus;
  carrier: string | null; trackingNumber: string | null; trackingUrl: string | null;
  shippedAt: string | null; deliveredAt: string | null; incidentReason: string | null; incidentAt: string | null;
}
export interface ShipmentContext {shipment: Shipment; orderStatus: OrderStatus}
export interface ShipmentResult extends ShipmentContext {actions: ShipmentActionName[]}
export interface ShipmentChange extends ShipmentContext {previousOrderStatus: OrderStatus}
const shipmentForOrder: Partial<Record<OrderStatus, ShipmentStatus>> = {
  [ORDER_STATUS.paid]: SHIPMENT_STATUS.pending, [ORDER_STATUS.preparing]: SHIPMENT_STATUS.preparing, [ORDER_STATUS.shipped]: SHIPMENT_STATUS.shipped,
};
export function shipmentActions(context: ShipmentContext): ShipmentActionName[] {
  const {shipment, orderStatus} = context;
  if (shipment.version >= SHIPPING.revision.maximum) return [];
  const normalStatus = shipmentForOrder[orderStatus];
  if (!normalStatus) return [];
  if (shipment.status === SHIPMENT_STATUS.failed) return [SHIPMENT_ACTION.resolveIncident];
  if (shipment.status !== normalStatus) return [];
  switch (shipment.status) {
    case SHIPMENT_STATUS.pending: return [SHIPMENT_ACTION.prepare, SHIPMENT_ACTION.reportIncident];
    case SHIPMENT_STATUS.preparing: return [SHIPMENT_ACTION.ship, SHIPMENT_ACTION.reportIncident];
    case SHIPMENT_STATUS.shipped: return [SHIPMENT_ACTION.deliver, SHIPMENT_ACTION.updateTracking, SHIPMENT_ACTION.reportIncident];
    default: return [];
  }
}
export function applyShipmentAction(context: ShipmentContext, input: ShipmentAction, now: string): ShipmentChange {
  const {shipment: current} = context;
  if (current.version !== input.expectedVersion) throw new ConflictException(SHIPPING.failure.changed);
  if (!shipmentActions(context).includes(input.action)) throw new ConflictException(SHIPPING.failure.state);
  const shipment = {...current, version: current.version + SHIPPING.revision.step};
  let orderStatus = context.orderStatus;
  switch (input.action) {
    case SHIPMENT_ACTION.prepare: shipment.status = SHIPMENT_STATUS.preparing; orderStatus = ORDER_STATUS.preparing; break;
    case SHIPMENT_ACTION.ship:
      shipment.status = SHIPMENT_STATUS.shipped; shipment.shippedAt = now; orderStatus = ORDER_STATUS.shipped;
      shipment.carrier = input.carrier; shipment.trackingNumber = input.trackingNumber; shipment.trackingUrl = input.trackingUrl ?? null;
      break;
    case SHIPMENT_ACTION.deliver: shipment.status = SHIPMENT_STATUS.delivered; shipment.deliveredAt = now; orderStatus = ORDER_STATUS.delivered; break;
    case SHIPMENT_ACTION.reportIncident: shipment.status = SHIPMENT_STATUS.failed; shipment.incidentReason = input.incidentReason; shipment.incidentAt = now; break;
    case SHIPMENT_ACTION.resolveIncident: {
      const resumed = shipmentForOrder[orderStatus];
      if (!resumed) throw new ConflictException(SHIPPING.failure.state);
      shipment.status = resumed; break;
    }
    case SHIPMENT_ACTION.updateTracking:
      shipment.carrier = input.carrier; shipment.trackingNumber = input.trackingNumber; shipment.trackingUrl = input.trackingUrl ?? null;
      break;
  }
  return {shipment, orderStatus, previousOrderStatus: context.orderStatus};
}
