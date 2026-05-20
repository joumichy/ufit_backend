import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Cart } from '../../cart/application/cart.service';

export type OrderStatus = 'pending_payment' | 'paid' | 'preparing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';

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
  items: OrderItemSnapshot[];
}

export interface ProductSnapshotReader {
  buildSnapshot(productVariantId: string): Promise<Record<string, unknown>>;
}

export interface OrderRepository {
  save(order: Order): Promise<Order>;
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject('OrderRepository')
    private readonly orders: OrderRepository,
    @Inject('ProductSnapshotReader')
    private readonly snapshots: ProductSnapshotReader
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

  checkoutPlaceholder(): never {
    throw new ForbiddenException('Stripe checkout is disabled in this build; no live payment can be created yet');
  }

  toCreatorOrderView(order: Order): Omit<Order, 'shippingAddress'> {
    const { shippingAddress: _shippingAddress, ...publicOrder } = order;
    return publicOrder;
  }

  private makeOrderNumber(): string {
    return `UF-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`;
  }
}
