import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { shipments } from '../../../shared/infrastructure/database/schema';
import type { Shipment, ShipmentRepository, ShipmentStatus } from '../application/shipping.service';

@Injectable()
export class DrizzleShipmentRepository implements ShipmentRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async save(shipment: Shipment): Promise<Shipment> {
    const [row] = await this.database.db
      .insert(shipments)
      .values({
        id: shipment.id,
        orderId: shipment.orderId,
        brandId: shipment.brandId,
        status: shipment.status,
        carrier: shipment.carrier,
        trackingNumber: shipment.trackingNumber,
        trackingUrl: shipment.trackingUrl,
        shippedAt: shipment.shippedAt ? new Date(shipment.shippedAt) : undefined,
        deliveredAt: shipment.deliveredAt ? new Date(shipment.deliveredAt) : undefined
      })
      .onConflictDoUpdate({
        target: shipments.id,
        set: {
          status: shipment.status,
          carrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
          trackingUrl: shipment.trackingUrl,
          shippedAt: shipment.shippedAt ? new Date(shipment.shippedAt) : undefined,
          deliveredAt: shipment.deliveredAt ? new Date(shipment.deliveredAt) : undefined,
          updatedAt: new Date()
        }
      })
      .returning();

    return this.toShipment(row);
  }

  async findByOrderId(orderId: string): Promise<Shipment | null> {
    const [row] = await this.database.db.select().from(shipments).where(eq(shipments.orderId, orderId)).limit(1);
    return row ? this.toShipment(row) : null;
  }

  private toShipment(row: typeof shipments.$inferSelect): Shipment {
    return {
      id: row.id,
      orderId: row.orderId,
      brandId: row.brandId,
      status: row.status as ShipmentStatus,
      carrier: row.carrier ?? undefined,
      trackingNumber: row.trackingNumber ?? undefined,
      trackingUrl: row.trackingUrl ?? undefined,
      shippedAt: row.shippedAt?.toISOString(),
      deliveredAt: row.deliveredAt?.toISOString()
    };
  }
}
