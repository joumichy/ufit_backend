import { BadRequestException, Injectable } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import {
  orderItems,
  orders,
  orderStatusHistory,
  payments,
  productImages,
  products,
  productVariants
} from '../../../shared/infrastructure/database/schema';
import type {
  Order,
  OrderItemSnapshot,
  OrderRepository,
  PaymentRecord,
  PaymentRepository,
  ProductSnapshotReader,
  ShippingAddressSnapshot,
  StockRepository
} from '../application/orders.service';

@Injectable()
export class DrizzleOrderRepository implements OrderRepository {
  constructor(private readonly database: DatabaseService) {}

  async save(order: Order): Promise<Order> {
    await this.database.db.transaction(async (tx) => {
      await tx.insert(orders).values({
        id: order.id,
        orderNumber: order.orderNumber,
        customerId: order.customerId,
        brandId: order.brandId,
        sourceCreatorId: order.sourceCreatorId,
        sourceOutfitId: order.sourceOutfitId,
        status: order.status,
        subtotalAmount: order.subtotalAmount,
        shippingAmount: order.shippingAmount,
        totalAmount: order.totalAmount,
        currency: order.currency,
        shippingAddress: order.shippingAddress,
        paymentProvider: order.paymentProvider,
        stripePaymentIntentId: order.stripePaymentIntentId
      });

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
            sourceOutfitId: item.sourceOutfitId
          }))
        );
      }

      await tx.insert(orderStatusHistory).values({
        orderId: order.id,
        fromStatus: null,
        toStatus: order.status,
        reason: 'order_created'
      });
    });

    return order;
  }

  async findById(orderId: string): Promise<Order | undefined> {
    const [order] = await this.database.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) {
      return undefined;
    }

    const items = await this.database.db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      brandId: order.brandId,
      sourceCreatorId: order.sourceCreatorId ?? undefined,
      sourceOutfitId: order.sourceOutfitId ?? undefined,
      status: order.status as Order['status'],
      subtotalAmount: order.subtotalAmount,
      shippingAmount: order.shippingAmount,
      totalAmount: order.totalAmount,
      currency: order.currency,
      shippingAddress: order.shippingAddress as ShippingAddressSnapshot,
      paymentProvider: order.paymentProvider as Order['paymentProvider'],
      stripeCheckoutSessionId: order.stripeCheckoutSessionId ?? undefined,
      stripePaymentIntentId: order.stripePaymentIntentId ?? undefined,
      items: items.map((item): OrderItemSnapshot => ({
        id: item.id,
        productId: item.productId,
        productVariantId: item.productVariantId,
        productSnapshot: item.productSnapshot as Record<string, unknown>,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        commissionRate: Number(item.commissionRate),
        sourceCreatorId: item.sourceCreatorId ?? undefined,
        sourceOutfitId: item.sourceOutfitId ?? undefined
      }))
    };
  }

  async saveStripeCheckoutSession(orderId: string, checkoutSessionId: string): Promise<Order> {
    const [row] = await this.database.db
      .update(orders)
      .set({ paymentProvider: 'stripe', stripeCheckoutSessionId: checkoutSessionId, updatedAt: new Date() })
      .where(eq(orders.id, orderId))
      .returning();
    if (!row) {
      throw new BadRequestException('Order not found');
    }
    const order = await this.findById(orderId);
    if (!order) {
      throw new BadRequestException('Order not found');
    }
    return { ...order, stripeCheckoutSessionId: checkoutSessionId };
  }

  async markStripePaymentSucceeded(orderId: string, stripePaymentIntentId?: string): Promise<Order | undefined> {
    await this.database.db.transaction(async (tx) => {
      const [current] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!current) {
        return;
      }

      await tx
        .update(orders)
        .set({ status: 'paid', paymentProvider: 'stripe', stripePaymentIntentId, updatedAt: new Date() })
        .where(eq(orders.id, orderId));
      await tx.insert(orderStatusHistory).values({
        orderId,
        fromStatus: current.status,
        toStatus: 'paid',
        reason: 'payment_confirmed'
      });
    });

    return this.findById(orderId);
  }
}

@Injectable()
export class DrizzlePaymentRepository implements PaymentRepository {
  constructor(private readonly database: DatabaseService) {}

  async findByProviderPaymentIntentId(provider: PaymentRecord['provider'], providerPaymentIntentId: string): Promise<PaymentRecord | undefined> {
    const [row] = await this.database.db
      .select()
      .from(payments)
      .where(and(eq(payments.provider, provider), eq(payments.providerPaymentIntentId, providerPaymentIntentId)))
      .limit(1);
    return row
      ? {
          id: row.id,
          orderId: row.orderId,
          provider: row.provider as PaymentRecord['provider'],
          providerPaymentIntentId: row.providerPaymentIntentId ?? undefined,
          status: row.status as PaymentRecord['status'],
          amount: row.amount,
          currency: row.currency
        }
      : undefined;
  }

  async save(payment: PaymentRecord): Promise<PaymentRecord> {
    let row: typeof payments.$inferSelect | undefined;
    try {
      [row] = await this.database.db
        .insert(payments)
        .values({
          id: payment.id,
          orderId: payment.orderId,
          provider: payment.provider,
          providerPaymentIntentId: payment.providerPaymentIntentId,
          status: payment.status,
          amount: payment.amount,
          currency: payment.currency
        })
        .returning();
    } catch (error) {
      if (!isUniqueViolation(error) || !payment.providerPaymentIntentId) {
        throw error;
      }

      const existing = await this.findByProviderPaymentIntentId(payment.provider, payment.providerPaymentIntentId);
      if (!existing) {
        throw error;
      }
      return existing;
    }

    if (!row) {
      throw new BadRequestException('Payment could not be saved');
    }

    return {
      id: row.id,
      orderId: row.orderId,
      provider: row.provider as PaymentRecord['provider'],
      providerPaymentIntentId: row.providerPaymentIntentId ?? undefined,
      status: row.status as PaymentRecord['status'],
      amount: row.amount,
      currency: row.currency
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

@Injectable()
export class DrizzleStockRepository implements StockRepository {
  constructor(private readonly database: DatabaseService) {}

  async decrementAvailable(productVariantId: string, quantity: number): Promise<void> {
    const rows = await this.database.db
      .update(productVariants)
      .set({
        stockQuantity: sql`${productVariants.stockQuantity} - ${quantity}`,
        updatedAt: new Date()
      })
      .where(and(eq(productVariants.id, productVariantId), gte(productVariants.stockQuantity, quantity)))
      .returning({ id: productVariants.id });

    if (!rows.length) {
      throw new BadRequestException('Insufficient stock for this variant');
    }
  }
}

@Injectable()
export class DrizzleProductSnapshotReader implements ProductSnapshotReader {
  constructor(private readonly database: DatabaseService) {}

  async buildSnapshot(productVariantId: string): Promise<Record<string, unknown>> {
    const [variant] = await this.database.db.select().from(productVariants).where(eq(productVariants.id, productVariantId)).limit(1);
    if (!variant) {
      throw new BadRequestException('Product variant not found');
    }

    const [product] = await this.database.db.select().from(products).where(eq(products.id, variant.productId)).limit(1);
    if (!product) {
      throw new BadRequestException('Product not found');
    }

    const [image] = await this.database.db.select().from(productImages).where(eq(productImages.productId, product.id)).limit(1);
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
      commissionRate: Number(product.commissionRateOverride ?? 0)
    };
  }
}
