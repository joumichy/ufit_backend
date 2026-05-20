import { Injectable, NotFoundException } from '@nestjs/common';
import type { Order, OrderRepository, PaymentRecord, PaymentRepository, ProductSnapshotReader, StockRepository } from '../application/orders.service';

@Injectable()
export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, Order>();

  async save(order: Order): Promise<Order> {
    this.orders.set(order.id, structuredClone(order));
    return structuredClone(order);
  }

  async findById(orderId: string): Promise<Order | undefined> {
    const order = this.orders.get(orderId);
    return order ? structuredClone(order) : undefined;
  }

  async saveStripeCheckoutSession(orderId: string, checkoutSessionId: string): Promise<Order> {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new NotFoundException(`Order ${orderId} was not found`);
    }

    const updated: Order = {
      ...order,
      paymentProvider: 'stripe',
      stripeCheckoutSessionId: checkoutSessionId
    };
    this.orders.set(orderId, structuredClone(updated));
    return structuredClone(updated);
  }

  async markStripePaymentSucceeded(orderId: string, stripePaymentIntentId?: string): Promise<Order | undefined> {
    const order = this.orders.get(orderId);
    if (!order) {
      return undefined;
    }

    const updated: Order = {
      ...order,
      status: 'paid',
      paymentProvider: 'stripe',
      ...(stripePaymentIntentId ? { stripePaymentIntentId } : {})
    };
    this.orders.set(orderId, structuredClone(updated));
    return structuredClone(updated);
  }
}

@Injectable()
export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly payments = new Map<string, PaymentRecord>();

  async findByProviderPaymentIntentId(provider: PaymentRecord['provider'], providerPaymentIntentId: string): Promise<PaymentRecord | undefined> {
    const payment = [...this.payments.values()].find(
      (candidate) => candidate.provider === provider && candidate.providerPaymentIntentId === providerPaymentIntentId
    );
    return payment ? structuredClone(payment) : undefined;
  }

  async save(payment: PaymentRecord): Promise<PaymentRecord> {
    this.payments.set(payment.id, structuredClone(payment));
    return structuredClone(payment);
  }
}

@Injectable()
export class DisabledStockRepository implements StockRepository {
  async decrementAvailable(productVariantId: string): Promise<void> {
    throw new NotFoundException(`Stock source for ${productVariantId} is not wired yet`);
  }
}

@Injectable()
export class DisabledProductSnapshotReader implements ProductSnapshotReader {
  async buildSnapshot(productVariantId: string): Promise<Record<string, unknown>> {
    throw new NotFoundException(`Product snapshot source for ${productVariantId} is not wired yet`);
  }
}
