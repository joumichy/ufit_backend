import type {ShipmentRow} from '../../../shared/infrastructure/database/schema';
import type {Shipment, ShipmentStatus} from '../domain/shipping.contract';

export function projectShipment(row: ShipmentRow): Shipment {
  return {id: row.id, orderId: row.orderId, brandId: row.brandId, version: row.version, status: row.status as ShipmentStatus,
    carrier: row.carrier, trackingNumber: row.trackingNumber, trackingUrl: row.trackingUrl,
    shippedAt: row.shippedAt?.toISOString() ?? null, deliveredAt: row.deliveredAt?.toISOString() ?? null,
    incidentReason: row.incidentReason, incidentAt: row.incidentAt?.toISOString() ?? null};
}
