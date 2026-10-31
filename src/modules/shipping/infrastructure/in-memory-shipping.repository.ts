import { Injectable } from "@nestjs/common";
import {
  applyShipmentUpdate,
  type Shipment,
  type ShipmentRepository,
  type ShipmentUpdate,
} from "../application/shipping.service";

@Injectable()
export class InMemoryShipmentRepository implements ShipmentRepository {
  private readonly shipments = new Map<string, Shipment>();

  async save(shipment: Shipment): Promise<Shipment> {
    this.shipments.set(shipment.id, structuredClone(shipment));
    return structuredClone(shipment);
  }

  async findById(id: string): Promise<Shipment | null> {
    return structuredClone(this.shipments.get(id) ?? null);
  }
  async transition(id: string, input: ShipmentUpdate): Promise<Shipment> {
    const shipment = this.shipments.get(id);
    if (!shipment) throw new Error("Shipment not found");
    return this.save(applyShipmentUpdate(shipment, input));
  }
  async findByOrderId(orderId: string): Promise<Shipment | null> {
    const shipment = [...this.shipments.values()].find(
      (candidate) => candidate.orderId === orderId,
    );
    return shipment ? structuredClone(shipment) : null;
  }
}
