import {ConflictException, Injectable} from '@nestjs/common';
import type {BrandManagementAccess} from '../../brands/brands.repository';
import {SHIPPING, type Shipment, type ShipmentChange, type ShipmentContext} from '../domain/shipping.contract';
import type {ShipmentRepository} from '../domain/shipping.repository';
import type {OrderStatus} from '../../orders/domain/order-lifecycle';

@Injectable()
export class InMemoryShipmentRepository implements ShipmentRepository {
  readonly shipments = new Map<string, Shipment>();
  readonly orderStatuses = new Map<string, OrderStatus>();
  readonly access = new Map<string, Map<string, BrandManagementAccess>>();
  async transaction<T>(operation: (repository: ShipmentRepository) => Promise<T>): Promise<T> {
    const shipments = structuredClone(this.shipments), statuses = structuredClone(this.orderStatuses);
    try { return await operation(this); }
    catch (error) {
      this.shipments.clear(); for (const [key, value] of shipments) this.shipments.set(key, value);
      this.orderStatuses.clear(); for (const [key, value] of statuses) this.orderStatuses.set(key, value);
      throw error;
    }
  }
  async create(shipment: Shipment): Promise<Shipment> {
    const existing = await this.findByOrderId(shipment.orderId);
    if (existing) {
      if (existing.brandId !== shipment.brandId) throw new ConflictException(SHIPPING.failure.state);
      return existing;
    }
    this.shipments.set(shipment.id, structuredClone(shipment));
    return structuredClone(shipment);
  }
  async findById(id: string): Promise<Shipment | null> { return structuredClone(this.shipments.get(id) ?? null); }
  async findByOrderId(orderId: string): Promise<Shipment | null> {
    return structuredClone([...this.shipments.values()].find(value => value.orderId === orderId) ?? null);
  }
  async lockManagementAccess(brandId: string, actorId: string) { return structuredClone(this.access.get(actorId)?.get(brandId)); }
  async lockContext(id: string): Promise<ShipmentContext | null> {
    const shipment = await this.findById(id), orderStatus = shipment ? this.orderStatuses.get(shipment.orderId) : undefined;
    return shipment && orderStatus ? {shipment, orderStatus} : null;
  }
  async apply(change: ShipmentChange, expectedVersion: number): Promise<void> {
    const current = this.shipments.get(change.shipment.id);
    if (!current || current.version !== expectedVersion) throw new ConflictException(SHIPPING.failure.changed);
    if (this.orderStatuses.get(current.orderId) !== change.previousOrderStatus) throw new ConflictException(SHIPPING.failure.state);
    this.shipments.set(current.id, structuredClone(change.shipment));
    this.orderStatuses.set(current.orderId, change.orderStatus);
  }
}
