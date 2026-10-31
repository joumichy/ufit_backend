import {
  ConflictException,
  NotFoundException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../../../shared/infrastructure/database/database.service";
import {
  shipments,
  orders,
  orderStatusHistory,
} from "../../../shared/infrastructure/database/schema";
import {
  applyShipmentUpdate,
  SHIPMENT_STATUS,
  type Shipment,
  type ShipmentRepository,
  type ShipmentStatus,
  type ShipmentUpdate,
} from "../application/shipping.service";

import { ORDER_STATUS, ORDER_LIMIT } from "../../orders/domain/order-lifecycle";
const SHIPPING_PERSISTENCE = {
  lock: "update",
  notFound: "Shipment not found",
  state: {
    code: "order_shipping_state_changed",
    message: "The order no longer accepts this shipment update",
  },
  reason: "brand_shipment_updated",
} as const;

@Injectable()
export class DrizzleShipmentRepository implements ShipmentRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

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
        shippedAt: shipment.shippedAt
          ? new Date(shipment.shippedAt)
          : undefined,
        deliveredAt: shipment.deliveredAt
          ? new Date(shipment.deliveredAt)
          : undefined,
      })
      .onConflictDoUpdate({
        target: shipments.id,
        set: {
          status: shipment.status,
          carrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
          trackingUrl: shipment.trackingUrl,
          shippedAt: shipment.shippedAt
            ? new Date(shipment.shippedAt)
            : undefined,
          deliveredAt: shipment.deliveredAt
            ? new Date(shipment.deliveredAt)
            : undefined,
          updatedAt: new Date(),
        },
      })
      .returning();

    return this.toShipment(row);
  }

  async findById(id: string): Promise<Shipment | null> {
    const [row] = await this.database.db
      .select()
      .from(shipments)
      .where(eq(shipments.id, id))
      .limit(ORDER_LIMIT.singleRow);
    return row ? this.toShipment(row) : null;
  }
  async transition(id: string, input: ShipmentUpdate): Promise<Shipment> {
    return this.database.db.transaction(async (tx) => {
      const [reference] = await tx
        .select({ orderId: shipments.orderId })
        .from(shipments)
        .where(eq(shipments.id, id))
        .limit(ORDER_LIMIT.singleRow);
      if (!reference)
        throw new NotFoundException(SHIPPING_PERSISTENCE.notFound);
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, reference.orderId))
        .limit(ORDER_LIMIT.singleRow)
        .for(SHIPPING_PERSISTENCE.lock);
      const [row] = await tx
        .select()
        .from(shipments)
        .where(eq(shipments.id, id))
        .limit(ORDER_LIMIT.singleRow)
        .for(SHIPPING_PERSISTENCE.lock);
      if (!order || !row)
        throw new NotFoundException(SHIPPING_PERSISTENCE.notFound);
      const current = this.toShipment(row);
      if (current.status === input.nextStatus) return current;
      const transitions = {
        [SHIPMENT_STATUS.preparing]: {
          from: ORDER_STATUS.paid,
          to: ORDER_STATUS.preparing,
        },
        [SHIPMENT_STATUS.shipped]: {
          from: ORDER_STATUS.preparing,
          to: ORDER_STATUS.shipped,
        },
        [SHIPMENT_STATUS.delivered]: {
          from: ORDER_STATUS.shipped,
          to: ORDER_STATUS.delivered,
        },
      };
      const change = transitions[input.nextStatus as keyof typeof transitions];
      const failureAllowed: readonly string[] = [
        ORDER_STATUS.paid,
        ORDER_STATUS.preparing,
        ORDER_STATUS.shipped,
      ];
      if (
        change
          ? order.status !== change.from
          : !failureAllowed.includes(order.status)
      )
        throw new ConflictException(SHIPPING_PERSISTENCE.state);
      const next = applyShipmentUpdate(current, input);
      await tx
        .update(shipments)
        .set({
          status: next.status,
          carrier: next.carrier,
          trackingNumber: next.trackingNumber,
          trackingUrl: next.trackingUrl,
          shippedAt: next.shippedAt ? new Date(next.shippedAt) : undefined,
          deliveredAt: next.deliveredAt
            ? new Date(next.deliveredAt)
            : undefined,
          updatedAt: new Date(),
        })
        .where(eq(shipments.id, id));
      if (change) {
        await tx
          .update(orders)
          .set({ status: change.to, updatedAt: new Date() })
          .where(eq(orders.id, order.id));
        await tx
          .insert(orderStatusHistory)
          .values({
            orderId: order.id,
            fromStatus: order.status,
            toStatus: change.to,
            reason: SHIPPING_PERSISTENCE.reason,
          });
      }
      return next;
    });
  }

  async findByOrderId(orderId: string): Promise<Shipment | null> {
    const [row] = await this.database.db
      .select()
      .from(shipments)
      .where(eq(shipments.orderId, orderId))
      .limit(1);
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
      deliveredAt: row.deliveredAt?.toISOString(),
    };
  }
}
