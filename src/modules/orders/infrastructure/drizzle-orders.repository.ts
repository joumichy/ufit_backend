import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { DatabaseService } from "../../../shared/infrastructure/database/database.service";
import {
  orderItems,
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
  ShippingAddressSnapshot,
} from "../application/orders.service";

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
          taxAmount: order.taxAmount ?? 0,
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
          eq(orders.status, "pending_payment"),
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
    const pageOverflow = 1;
    const rows = await this.database.db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.customerId, userId),
          cursor ? lt(orders.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(orders.id))
      .limit(limit + pageOverflow);
    const selected = rows.slice(0, limit);
    const items = await Promise.all(
      selected.map(async (row) => {
        const order = await this.findById(row.id);
        if (!order)
          throw new BadRequestException("Order disappeared during retrieval");
        return order;
      }),
    );
    return {
      items,
      nextCursor: rows.length > limit ? selected.at(-1)!.id : null,
    };
  }

  async findById(orderId: string): Promise<Order | undefined> {
    const [order] = await this.database.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!order) {
      return undefined;
    }

    const items = await this.database.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      brandId: order.brandId,
      sourceCreatorId: order.sourceCreatorId ?? undefined,
      sourceOutfitId: order.sourceOutfitId ?? undefined,
      status: order.status as Order["status"],
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
