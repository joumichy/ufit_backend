import type {ShippingAddressSnapshot} from '../domain/shipping-address';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { CartQuote } from "../../cart/application/cart-quote.service";
import type { Cart } from "../../cart/application/cart.service";
import {
  calculateCommissionRate,
  type CommissionRuleInput,
} from "../../commissions/application/commissions.service";

import {
  ORDER_STATUS,
  customerOrderActions,
  type OrderStatus,
  type CancellationClaim,
} from "../domain/order-lifecycle";
export type { OrderStatus } from "../domain/order-lifecycle";

export interface OrderItemSnapshot {
  id: string;
  productId: string;
  productVariantId: string;
  productSnapshot: Record<string, unknown>;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  commissionRate: number;
  sourceCreatorId?: string;
  sourceOutfitId?: string;
}

export interface Order {
  id: string;
  orderNumber: string;
  customerId: string;
  brandId: string;
  sourceCreatorId?: string;
  sourceOutfitId?: string;
  status: OrderStatus;
  createdAt: string;
  actions: { cancel: boolean; resumePayment: boolean };
  cancellation?: {
    status: string;
    reason: CancellationClaim["reason"];
    outcome?: string;
  };
  shipment?: {
    id: string;
    status: string;
    carrier?: string;
    trackingNumber?: string;
    trackingUrl?: string;
    shippedAt?: string;
    deliveredAt?: string;
  };
  subtotalAmount: number;
  shippingAmount: number;
  taxAmount: number;
  cartId?: string;
  checkoutRequestId?: string;
  checkoutFingerprint?: string;
  commerceSnapshot?: Record<string, unknown>;
  totalAmount: number;
  currency: string;
  shippingAddress: ShippingAddressSnapshot;
  paymentProvider: "stripe";
  stripePaymentIntentId?: string;
  items: OrderItemSnapshot[];
}

export interface ProductSnapshotReader {
  buildSnapshot(productVariantId: string): Promise<Record<string, unknown>>;
}

export interface OrderRepository {
  listForCustomer(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: Order[]; nextCursor: string | null }>;
  save(order: Order): Promise<Order>;
  findByCheckoutRequest(
    customerId: string,
    requestId: string,
  ): Promise<Order | undefined>;
  attachPaymentIntent(orderId: string, intentId: string): Promise<void>;
  findById(orderId: string): Promise<Order | undefined>;
}

export interface CommissionRuleResolver {
  resolve(input: {
    brandId: string;
    productId: string;
    creatorId: string;
    snapshotRate: number;
  }): Promise<CommissionRuleInput>;
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject("OrderRepository")
    private readonly orders: OrderRepository,
    @Inject("ProductSnapshotReader")
    private readonly snapshots: ProductSnapshotReader,
    @Optional()
    @Inject("CommissionRuleResolver")
    private readonly commissionRules?: CommissionRuleResolver,
  ) {}

  async listForCustomer(userId: string, limit: number, cursor?: string) {
    return this.orders.listForCustomer(userId, limit, cursor);
  }

  async getForCustomer(userId: string, orderId: string): Promise<Order> {
    const order = await this.orders.findById(orderId);
    if (!order || order.customerId !== userId)
      throw new NotFoundException("Order not found");
    return order;
  }

  async createPendingFromCart(
    cart: Cart,
    shippingAddress: ShippingAddressSnapshot,
    terms: { quote: CartQuote; requestId: string; fingerprint: string },
  ): Promise<Order> {
    if (!cart.brandId || cart.items.length === 0) {
      throw new BadRequestException(
        "Cannot create an order from an empty cart",
      );
    }

    const items: OrderItemSnapshot[] = [];
    for (const item of cart.items) {
      const productSnapshot = await this.snapshots.buildSnapshot(
        item.productVariantId,
      );
      items.push({
        id: randomUUID(),
        productId: item.productId,
        productVariantId: item.productVariantId,
        productSnapshot,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.unitPrice * item.quantity,
        commissionRate:
          item.sourceCreatorId && this.commissionRules
            ? calculateCommissionRate(
                await this.commissionRules.resolve({
                  brandId: cart.brandId,
                  productId: item.productId,
                  creatorId: item.sourceCreatorId,
                  snapshotRate: Number(productSnapshot.commissionRate ?? 0),
                }),
              )
            : Number(productSnapshot.commissionRate ?? 0),
        sourceCreatorId: item.sourceCreatorId,
        sourceOutfitId: item.sourceOutfitId,
      });
    }

    const subtotalAmount = items.reduce(
      (sum, item) => sum + item.totalPrice,
      0,
    );
    if (
      terms.quote.subtotalAmount !== subtotalAmount ||
      terms.quote.currency !== cart.currency ||
      terms.quote.brandId !== cart.brandId ||
      terms.quote.cartId !== cart.id ||
      terms.quote.country !== shippingAddress.country
    ) {
      throw new BadRequestException(
        "The commercial terms do not match this cart",
      );
    }
    const order: Order = {
      id: randomUUID(),
      orderNumber: this.makeOrderNumber(),
      customerId: cart.userId,
      brandId: cart.brandId,
      sourceCreatorId: cart.sourceCreatorId,
      sourceOutfitId: cart.sourceOutfitId,
      status: ORDER_STATUS.pendingPayment,
      createdAt: new Date().toISOString(),
      actions: customerOrderActions(ORDER_STATUS.pendingPayment),
      subtotalAmount,
      shippingAmount: terms.quote.shippingAmount,
      taxAmount: terms.quote.taxAmount,
      totalAmount: terms.quote.totalAmount,
      cartId: cart.id,
      checkoutRequestId: terms.requestId,
      checkoutFingerprint: terms.fingerprint,
      commerceSnapshot: { ...terms.quote },
      currency: cart.currency,
      shippingAddress,
      paymentProvider: "stripe",
      items,
    };

    return this.orders.save(order);
  }

  async findCheckoutRequest(customerId: string, requestId: string) {
    return this.orders.findByCheckoutRequest(customerId, requestId);
  }

  async attachPaymentIntent(orderId: string, intentId: string): Promise<void> {
    await this.orders.attachPaymentIntent(orderId, intentId);
  }

  toCreatorOrderView(order: Order): Omit<Order, "shippingAddress"> {
    const { shippingAddress: _shippingAddress, ...publicOrder } = order;
    return publicOrder;
  }

  private makeOrderNumber(): string {
    return `UF-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
  }
}
