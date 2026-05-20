import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Cart } from '../../cart/application/cart.service';
import type { Commission, CommissionRuleInput } from '../../commissions/application/commissions.service';
import type { Shipment } from '../../shipping/application/shipping.service';

export type OrderStatus = 'pending_payment' | 'paid' | 'preparing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';
export type PaymentStatus = 'disabled' | 'requires_payment' | 'succeeded' | 'failed' | 'refunded';

export interface ShippingAddressSnapshot {
  fullName: string;
  line1: string;
  line2?: string;
  postalCode: string;
  city: string;
  country: string;
  phone?: string;
}

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
  subtotalAmount: number;
  shippingAmount: number;
  totalAmount: number;
  currency: string;
  shippingAddress: ShippingAddressSnapshot;
  paymentProvider: 'placeholder' | 'stripe';
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string;
  items: OrderItemSnapshot[];
}

export interface PaymentRecord {
  id: string;
  orderId: string;
  provider: 'placeholder' | 'stripe';
  providerPaymentIntentId?: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
}

export interface ConfirmPaymentFromWebhookInput {
  orderId: string;
  provider: 'stripe';
  providerPaymentIntentId: string;
  amount: number;
  currency: string;
}

export interface PaymentConfirmationResult {
  order: Order;
  payment: PaymentRecord;
  shipment?: Shipment;
  commissions: Commission[];
  alreadyProcessed: boolean;
}

export interface ProductSnapshotReader {
  buildSnapshot(productVariantId: string): Promise<Record<string, unknown>>;
}

export interface OrderRepository {
  save(order: Order): Promise<Order>;
  findById?(orderId: string): Promise<Order | undefined>;
  saveStripeCheckoutSession?(orderId: string, checkoutSessionId: string): Promise<Order>;
  markStripePaymentSucceeded?(orderId: string, stripePaymentIntentId?: string): Promise<Order | undefined>;
}

export interface PaymentRepository {
  findByProviderPaymentIntentId(provider: PaymentRecord['provider'], providerPaymentIntentId: string): Promise<PaymentRecord | undefined>;
  save(payment: PaymentRecord): Promise<PaymentRecord>;
}

export interface StockRepository {
  decrementAvailable(productVariantId: string, quantity: number): Promise<void>;
}

export interface PaidOrderShipmentCreator {
  createPendingForPaidOrder(orderId: string, brandId: string): Promise<Shipment>;
}

export interface PaidOrderCommissionCreator {
  createPending(input: {
    orderItemId: string;
    creatorId: string;
    brandId: string;
    sourceOutfitId: string;
    baseAmount: number;
    rule: CommissionRuleInput;
  }): Promise<Commission>;
}

export interface CommissionRuleResolver {
  resolve(input: { brandId: string; productId: string; creatorId: string; snapshotRate: number }): Promise<CommissionRuleInput>;
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject('OrderRepository')
    private readonly orders: OrderRepository,
    @Inject('ProductSnapshotReader')
    private readonly snapshots: ProductSnapshotReader,
    @Optional()
    @Inject('PaymentRepository')
    private readonly payments?: PaymentRepository,
    @Optional()
    @Inject('StockRepository')
    private readonly stock?: StockRepository,
    @Optional()
    @Inject('PaidOrderShipmentCreator')
    private readonly shipmentCreator?: PaidOrderShipmentCreator,
    @Optional()
    @Inject('PaidOrderCommissionCreator')
    private readonly commissionCreator?: PaidOrderCommissionCreator,
    @Optional()
    @Inject('CommissionRuleResolver')
    private readonly commissionRules?: CommissionRuleResolver
  ) {}

  async createPendingFromCart(cart: Cart, shippingAddress: ShippingAddressSnapshot, shippingAmount = 0): Promise<Order> {
    if (!cart.brandId || cart.items.length === 0) {
      throw new BadRequestException('Cannot create an order from an empty cart');
    }

    const items: OrderItemSnapshot[] = [];
    for (const item of cart.items) {
      const productSnapshot = await this.snapshots.buildSnapshot(item.productVariantId);
      items.push({
        id: randomUUID(),
        productId: item.productId,
        productVariantId: item.productVariantId,
        productSnapshot,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.unitPrice * item.quantity,
        commissionRate: Number(productSnapshot.commissionRate ?? 0),
        sourceCreatorId: item.sourceCreatorId,
        sourceOutfitId: item.sourceOutfitId
      });
    }

    const subtotalAmount = items.reduce((sum, item) => sum + item.totalPrice, 0);
    const order: Order = {
      id: randomUUID(),
      orderNumber: this.makeOrderNumber(),
      customerId: cart.userId,
      brandId: cart.brandId,
      sourceCreatorId: cart.sourceCreatorId,
      sourceOutfitId: cart.sourceOutfitId,
      status: 'pending_payment',
      subtotalAmount,
      shippingAmount,
      totalAmount: subtotalAmount + shippingAmount,
      currency: cart.currency,
      shippingAddress,
      paymentProvider: 'placeholder',
      items
    };

    return this.orders.save(order);
  }

  async attachStripeCheckoutSession(orderId: string, checkoutSessionId: string): Promise<Order> {
    if (!this.orders.saveStripeCheckoutSession) {
      throw new ForbiddenException('Stripe checkout session persistence is not wired in this build');
    }
    return this.orders.saveStripeCheckoutSession(orderId, checkoutSessionId);
  }

  async markStripePaymentSucceeded(orderId: string, stripePaymentIntentId?: string): Promise<Order | undefined> {
    return this.confirmStripePaymentSucceededFromWebhook({
      orderId,
      provider: 'stripe',
      providerPaymentIntentId: stripePaymentIntentId ?? `stripe:${orderId}`,
      amount: await this.lookupOrderTotal(orderId),
      currency: await this.lookupOrderCurrency(orderId)
    }).then((result) => result.order);
  }

  checkoutPlaceholder(): never {
    throw new ForbiddenException('Stripe checkout is disabled in this build; no live payment can be created yet');
  }

  async confirmStripePaymentSucceededFromWebhook(input: ConfirmPaymentFromWebhookInput): Promise<PaymentConfirmationResult> {
    if (!this.payments || !this.stock || !this.shipmentCreator || !this.commissionCreator) {
      throw new ForbiddenException('Payment confirmation workflow is not wired in this build');
    }

    const existingPayment = await this.payments.findByProviderPaymentIntentId(input.provider, input.providerPaymentIntentId);
    if (existingPayment?.status === 'succeeded') {
      const existingOrder = await this.loadOrder(existingPayment.orderId);
      return { order: existingOrder, payment: existingPayment, commissions: [], alreadyProcessed: true };
    }

    const order = await this.loadOrder(input.orderId);
    if (existingPayment && existingPayment.orderId !== order.id) {
      throw new ConflictException('Payment intent is already linked to another order');
    }
    if (input.amount !== order.totalAmount || input.currency !== order.currency) {
      throw new BadRequestException('Payment confirmation does not match order total');
    }
    if (order.status !== 'pending_payment') {
      if (order.status === 'paid') {
        const payment = existingPayment ?? (await this.saveSucceededPayment(order, input));
        return { order, payment, commissions: [], alreadyProcessed: true };
      }
      throw new ConflictException(`Cannot confirm payment for order in ${order.status} status`);
    }

    for (const item of order.items) {
      await this.stock.decrementAvailable(item.productVariantId, item.quantity);
    }

    const paidOrder = await this.markOrderPaid(order.id, input.providerPaymentIntentId);
    const payment = existingPayment ?? (await this.saveSucceededPayment(paidOrder, input));
    const shipment = await this.shipmentCreator.createPendingForPaidOrder(paidOrder.id, paidOrder.brandId);
    const commissions = await this.createCommissionsForPaidOrder(paidOrder);

    return { order: paidOrder, payment, shipment, commissions, alreadyProcessed: false };
  }

  toCreatorOrderView(order: Order): Omit<Order, 'shippingAddress'> {
    const { shippingAddress: _shippingAddress, ...publicOrder } = order;
    return publicOrder;
  }

  private makeOrderNumber(): string {
    return `UF-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`;
  }

  private async loadOrder(orderId: string): Promise<Order> {
    const order = await this.orders.findById?.(orderId);
    if (!order) {
      throw new BadRequestException('Order not found');
    }
    return order;
  }

  private async lookupOrderTotal(orderId: string): Promise<number> {
    return (await this.loadOrder(orderId)).totalAmount;
  }

  private async lookupOrderCurrency(orderId: string): Promise<string> {
    return (await this.loadOrder(orderId)).currency;
  }

  private async markOrderPaid(orderId: string, stripePaymentIntentId?: string): Promise<Order> {
    const updated = await this.orders.markStripePaymentSucceeded?.(orderId, stripePaymentIntentId);
    if (!updated) {
      throw new ForbiddenException('Order repository cannot mark orders as paid');
    }
    return updated;
  }

  private saveSucceededPayment(order: Order, input: ConfirmPaymentFromWebhookInput): Promise<PaymentRecord> {
    if (!this.payments) {
      throw new ForbiddenException('Payment repository is not wired');
    }
    return this.payments.save({
      id: randomUUID(),
      orderId: order.id,
      provider: input.provider,
      providerPaymentIntentId: input.providerPaymentIntentId,
      status: 'succeeded',
      amount: input.amount,
      currency: input.currency
    });
  }

  private async createCommissionsForPaidOrder(order: Order): Promise<Commission[]> {
    if (!this.commissionCreator) {
      return [];
    }

    const commissions: Commission[] = [];
    for (const item of order.items) {
      if (!item.sourceCreatorId || !item.sourceOutfitId) {
        continue;
      }

      commissions.push(
        await this.commissionCreator.createPending({
          orderItemId: item.id,
          creatorId: item.sourceCreatorId,
          brandId: order.brandId,
          sourceOutfitId: item.sourceOutfitId,
          baseAmount: item.totalPrice,
          rule: await this.resolveCommissionRule(order, item)
        })
      );
    }
    return commissions;
  }

  private async resolveCommissionRule(order: Order, item: OrderItemSnapshot): Promise<CommissionRuleInput> {
    if (!this.commissionRules) {
      return { baseRate: item.commissionRate };
    }

    return this.commissionRules.resolve({
      brandId: order.brandId,
      productId: item.productId,
      creatorId: item.sourceCreatorId ?? '',
      snapshotRate: item.commissionRate
    });
  }
}
