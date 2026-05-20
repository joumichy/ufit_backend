import { Injectable } from '@nestjs/common';
import type { Shipment, ShipmentRepository } from '../application/shipping.service';

@Injectable()
export class InMemoryShipmentRepository implements ShipmentRepository {
  private readonly shipments = new Map<string, Shipment>();

  async save(shipment: Shipment): Promise<Shipment> {
    this.shipments.set(shipment.id, structuredClone(shipment));
    return structuredClone(shipment);
  }
}
