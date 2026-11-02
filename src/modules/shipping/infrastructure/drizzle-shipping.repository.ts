import {DrizzleOrderNotifications} from '../../orders/infrastructure/drizzle-order-notifications';
import {shipmentNotification} from '../domain/shipment-notification';
import {ConflictException, Inject, Injectable} from '@nestjs/common';
import {and, eq} from 'drizzle-orm';
import {DatabaseService} from '../../../shared/infrastructure/database/database.service';
import type {DatabaseSession} from '../../../shared/infrastructure/database/database-session';
import {shipments, orders, orderStatusHistory} from '../../../shared/infrastructure/database/schema';
import {DrizzleBrandsRepository} from '../../brands/drizzle-brands.repository';
import {SHIPPING, type Shipment, type ShipmentChange, type ShipmentContext} from '../domain/shipping.contract';
import type {ShipmentRepository} from '../domain/shipping.repository';
import type {OrderStatus} from '../../orders/domain/order-lifecycle';
import {projectShipment} from './shipment-projection';

@Injectable()
export class DrizzleShipmentRepository implements ShipmentRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseSession) {}
  transaction<T>(operation: (repository: ShipmentRepository) => Promise<T>): Promise<T> {
    return this.database.db.transaction(tx => operation(new DrizzleShipmentRepository({db: tx})));
  }
  async create(shipment: Shipment): Promise<Shipment> {
    const [row] = await this.database.db.insert(shipments).values({id: shipment.id, orderId: shipment.orderId, brandId: shipment.brandId})
      .onConflictDoNothing({target: shipments.orderId}).returning();
    const existing = row ? projectShipment(row) : await this.findByOrderId(shipment.orderId);
    if (!existing || existing.brandId !== shipment.brandId) throw new ConflictException(SHIPPING.failure.state);
    return existing;
  }
  async findById(id: string): Promise<Shipment | null> {
    const [row] = await this.database.db.select().from(shipments).where(eq(shipments.id, id)).limit(SHIPPING.limit.singleRow);
    return row ? projectShipment(row) : null;
  }
  async findByOrderId(orderId: string): Promise<Shipment | null> {
    const [row] = await this.database.db.select().from(shipments).where(eq(shipments.orderId, orderId)).limit(SHIPPING.limit.singleRow);
    return row ? projectShipment(row) : null;
  }
  lockManagementAccess(brandId: string, actorId: string) {
    return new DrizzleBrandsRepository(this.database).lockManagementAccess(brandId, actorId);
  }
  async lockContext(id: string): Promise<ShipmentContext | null> {
    const [reference] = await this.database.db.select({orderId: shipments.orderId}).from(shipments).where(eq(shipments.id, id)).limit(SHIPPING.limit.singleRow);
    if (!reference) return null;
    const [order] = await this.database.db.select({status: orders.status, brandId: orders.brandId}).from(orders)
      .where(eq(orders.id, reference.orderId)).limit(SHIPPING.limit.singleRow).for(SHIPPING.persistence.lock);
    const [row] = await this.database.db.select().from(shipments).where(eq(shipments.id, id)).limit(SHIPPING.limit.singleRow).for(SHIPPING.persistence.lock);
    if (!order || !row) return null;
    if (order.brandId !== row.brandId) throw new ConflictException(SHIPPING.failure.state);
    return {shipment: projectShipment(row), orderStatus: order.status as OrderStatus};
  }
  async apply(change: ShipmentChange, expectedVersion: number): Promise<void> {
    const {shipment} = change;
    const [saved] = await this.database.db.update(shipments).set({status: shipment.status, version: shipment.version,
      carrier: shipment.carrier, trackingNumber: shipment.trackingNumber, trackingUrl: shipment.trackingUrl,
      shippedAt: shipment.shippedAt ? new Date(shipment.shippedAt) : null,
      deliveredAt: shipment.deliveredAt ? new Date(shipment.deliveredAt) : null,
      incidentReason: shipment.incidentReason, incidentAt: shipment.incidentAt ? new Date(shipment.incidentAt) : null, updatedAt: new Date()})
      .where(and(eq(shipments.id, shipment.id), eq(shipments.version, expectedVersion))).returning({id: shipments.id});
    if (!saved) throw new ConflictException(SHIPPING.failure.changed);
    if (change.orderStatus !== change.previousOrderStatus) {
      const [order] = await this.database.db.update(orders).set({status: change.orderStatus, updatedAt: new Date()})
        .where(and(eq(orders.id, shipment.orderId), eq(orders.status, change.previousOrderStatus))).returning({id: orders.id});
      if (!order) throw new ConflictException(SHIPPING.failure.state);
      await this.database.db.insert(orderStatusHistory).values({orderId: shipment.orderId, fromStatus: change.previousOrderStatus,
        toStatus: change.orderStatus, reason: SHIPPING.persistence.historyReason});
    }
    await new DrizzleOrderNotifications(this.database).record(shipmentNotification(change), false);
  }
}
