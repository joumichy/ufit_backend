import type {ShippingAddressSnapshot} from '../domain/shipping-address';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { DatabaseService } from "../../../shared/infrastructure/database/database.service";
import {
  orderItems,
  shipments,
  orderCancellations,
  type OrderRow,
  type OrderItemRow,
  type ShipmentRow,
  orders,
  orderStatusHistory,
  productImages,
  products,
  productVariants,
} from "../../../shared/infrastructure/database/schema";
import type {
  Order,
  OrderItemSnapshot,
  OrderRepository,
  ProductSnapshotReader,
} from "../application/orders.service";

import {
  ORDER_LIMIT,
  ORDER_STATUS,
  customerOrderActions,
  type OrderStatus,
  type CancellationClaim,
} from "../domain/order-lifecycle";
const ORDER_READ = {
  cursor: "Invalid order cursor",
  snapshot: { isolationLevel: "repeatable read", accessMode: "read only" },
} as const;

@Injectable()
export class DrizzleOrderRepository implements OrderRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async save(order: Order): Promise<Order> {
    const savedId = await this.database.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(orders)
        .values({
          id: order.id,
          orderNumber: order.orderNumber,
          customerId: order.customerId,
          brandId: order.brandId,
          sourceCreatorId: order.sourceCreatorId,
          sourceOutfitId: order.sourceOutfitId,
          status: order.status,
          subtotalAmount: order.subtotalAmount,
          shippingAmount: order.shippingAmount,
          taxAmount: order.taxAmount,
          cartId: order.cartId,
          checkoutRequestId: order.checkoutRequestId,
          checkoutFingerprint: order.checkoutFingerprint,
          commerceSnapshot: order.commerceSnapshot,
          totalAmount: order.totalAmount,
          currency: order.currency,
          shippingAddress: order.shippingAddress,
          paymentProvider: order.paymentProvider,
          stripePaymentIntentId: order.stripePaymentIntentId,
        })
        .onConflictDoNothing({
          target: [orders.customerId, orders.checkoutRequestId],
        })
        .returning({ id: orders.id });
      if (!inserted) {
        const [existing] = await tx
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.customerId, order.customerId),
              eq(orders.checkoutRequestId, order.checkoutRequestId!),
            ),
          )
          .limit(1);
        if (
          !existing ||
          existing.checkoutFingerprint !== order.checkoutFingerprint
        )
          throw new ConflictException({
            code: "checkout_request_conflict",
            message: "Checkout request was already used for another purchase",
          });
        return existing.id;
      }

      if (order.items.length) {
        await tx.insert(orderItems).values(
          order.items.map((item) => ({
            id: item.id,
            orderId: order.id,
            productId: item.productId,
            productVariantId: item.productVariantId,
            productSnapshot: item.productSnapshot,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            totalPrice: item.totalPrice,
            commissionRate: item.commissionRate.toFixed(4),
            sourceCreatorId: item.sourceCreatorId,
            sourceOutfitId: item.sourceOutfitId,
          })),
        );
      }

      await tx.insert(orderStatusHistory).values({
        orderId: order.id,
        fromStatus: null,
        toStatus: order.status,
        reason: "order_created",
      });
      return order.id;
    });

    return savedId === order.id ? order : (await this.findById(savedId))!;
  }

  async findByCheckoutRequest(
    customerId: string,
    requestId: string,
  ): Promise<Order | undefined> {
    const [row] = await this.database.db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.customerId, customerId),
          eq(orders.checkoutRequestId, requestId),
        ),
      )
      .limit(1);
    return row ? this.findById(row.id) : undefined;
  }

  async attachPaymentIntent(orderId: string, intentId: string): Promise<void> {
    const rows = await this.database.db
      .update(orders)
      .set({
        stripePaymentIntentId: intentId,
        paymentProvider: "stripe",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.status, ORDER_STATUS.pendingPayment),
          sql`(${orders.stripePaymentIntentId} is null or ${orders.stripePaymentIntentId} = ${intentId})`,
        ),
      )
      .returning({ id: orders.id });
    if (!rows.length)
      throw new ConflictException(
        "The payment cannot be attached to this order",
      );
  }

  async listForCustomer(userId: string, limit: number, cursor?: string) {
    return this.database.db.transaction(async (tx) => {
      let anchor: OrderRow | undefined;
      if (cursor) {
        [anchor] = await tx
          .select()
          .from(orders)
          .where(and(eq(orders.id, cursor), eq(orders.customerId, userId)))
          .limit(ORDER_LIMIT.singleRow);
        if (!anchor) throw new BadRequestException(ORDER_READ.cursor);
      }
      const rows = await tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.customerId, userId),
            anchor
              ? or(
                  lt(orders.createdAt, anchor.createdAt),
                  and(
                    eq(orders.createdAt, anchor.createdAt),
                    lt(orders.id, anchor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(limit + ORDER_LIMIT.overflow);
      const selected = rows.slice(ORDER_LIMIT.firstRow, limit);
      const ids = selected.map((row) => row.id);
      if (!ids.length) return { items: [], nextCursor: null };
      const [items, shipping, cancellations] = await Promise.all([
        tx.select().from(orderItems).where(inArray(orderItems.orderId, ids)),
        tx.select().from(shipments).where(inArray(shipments.orderId, ids)),
        tx
          .select()
          .from(orderCancellations)
          .where(inArray(orderCancellations.orderId, ids)),
      ]);
      return {
        items: selected.map((row) =>
          projectOrder(
            row,
            items.filter((item) => item.orderId === row.id),
            shipping.find((value) => value.orderId === row.id),
            cancellations.find((value) => value.orderId === row.id),
          ),
        ),
        nextCursor:
          rows.length > limit ? selected.at(ORDER_LIMIT.lastRow)!.id : null,
      };
    }, ORDER_READ.snapshot);
  }

  async findById(orderId: string): Promise<Order | undefined> {
    return this.database.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(ORDER_LIMIT.singleRow);
      if (!order) return undefined;
      const [items, [shipment], [cancellation]] = await Promise.all([
        tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
        tx
          .select()
          .from(shipments)
          .where(eq(shipments.orderId, orderId))
          .limit(ORDER_LIMIT.singleRow),
        tx
          .select()
          .from(orderCancellations)
          .where(eq(orderCancellations.orderId, orderId))
          .limit(ORDER_LIMIT.singleRow),
      ]);
      return projectOrder(order, items, shipment, cancellation);
    }, ORDER_READ.snapshot);
  }
}

function projectOrder(
  order: OrderRow,
  items: OrderItemRow[],
  shipment?: ShipmentRow,
  cancellation?: typeof orderCancellations.$inferSelect,
): Order {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    customerId: order.customerId,
    brandId: order.brandId,
    sourceCreatorId: order.sourceCreatorId ?? undefined,
    sourceOutfitId: order.sourceOutfitId ?? undefined,
    status: order.status as Order["status"],
    createdAt: order.createdAt.toISOString(),
    actions: customerOrderActions(
      order.status as OrderStatus,
      cancellation?.reason as CancellationClaim["reason"] | undefined,
    ),
    shipment: shipment
      ? {
          id: shipment.id,
          status: shipment.status,
          carrier: shipment.carrier ?? undefined,
          trackingNumber: shipment.trackingNumber ?? undefined,
          trackingUrl: shipment.trackingUrl ?? undefined,
          shippedAt: shipment.shippedAt?.toISOString(),
          deliveredAt: shipment.deliveredAt?.toISOString(),
          incidentReason: shipment.incidentReason ?? undefined,
          incidentAt: shipment.incidentAt?.toISOString(),
        }
      : undefined,
    cancellation: cancellation
      ? {
          status: cancellation.status,
          reason: cancellation.reason as CancellationClaim["reason"],
          outcome: cancellation.paymentOutcome ?? undefined,
        }
      : undefined,
    subtotalAmount: order.subtotalAmount,
    shippingAmount: order.shippingAmount,
    taxAmount: order.taxAmount,
    cartId: order.cartId ?? undefined,
    checkoutRequestId: order.checkoutRequestId ?? undefined,
    checkoutFingerprint: order.checkoutFingerprint ?? undefined,
    commerceSnapshot: order.commerceSnapshot ?? undefined,
    totalAmount: order.totalAmount,
    currency: order.currency,
    shippingAddress: order.shippingAddress as ShippingAddressSnapshot,
    paymentProvider: order.paymentProvider as Order["paymentProvider"],
    stripePaymentIntentId: order.stripePaymentIntentId ?? undefined,
    items: items.map(
      (item): OrderItemSnapshot => ({
        id: item.id,
        productId: item.productId,
        productVariantId: item.productVariantId,
        productSnapshot: item.productSnapshot as Record<string, unknown>,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        commissionRate: Number(item.commissionRate),
        sourceCreatorId: item.sourceCreatorId ?? undefined,
        sourceOutfitId: item.sourceOutfitId ?? undefined,
      }),
    ),
  };
}

@Injectable()
export class DrizzleProductSnapshotReader implements ProductSnapshotReader {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async buildSnapshot(
    productVariantId: string,
  ): Promise<Record<string, unknown>> {
    const [variant] = await this.database.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, productVariantId))
      .limit(1);
    if (!variant) {
      throw new BadRequestException("Product variant not found");
    }

    const [product] = await this.database.db
      .select()
      .from(products)
      .where(eq(products.id, variant.productId))
      .limit(1);
    if (!product) {
      throw new BadRequestException("Product not found");
    }

    const [image] = await this.database.db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, product.id))
      .limit(1);
    return {
      name: product.name,
      slug: product.slug,
      brandId: product.brandId,
      category: product.category,
      size: variant.size,
      color: variant.color,
      sku: variant.sku,
      unitPrice: variant.priceOverride ?? product.basePrice,
      currency: product.currency,
      imageUrl: image?.url,
      commissionRate: Number(product.commissionRateOverride ?? 0),
    };
  }
}
