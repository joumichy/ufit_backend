import { Injectable, NotFoundException } from "@nestjs/common";
import type { Order, OrderRepository } from "../application/orders.service";

@Injectable()
export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, Order>();

  async save(order: Order): Promise<Order> {
    this.orders.set(order.id, structuredClone(order));
    return structuredClone(order);
  }

  async listForCustomer(userId: string, limit: number, cursor?: string) {
    const rows = [...this.orders.values()]
      .filter(
        (order) =>
          order.customerId === userId && (!cursor || order.id < cursor),
      )
      .sort((left, right) => right.id.localeCompare(left.id));
    const items = structuredClone(rows.slice(0, limit));
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  }

  async findById(orderId: string): Promise<Order | undefined> {
    const order = this.orders.get(orderId);
    return order ? structuredClone(order) : undefined;
  }

  async findByCheckoutRequest(
    customerId: string,
    requestId: string,
  ): Promise<Order | undefined> {
    return structuredClone(
      [...this.orders.values()].find(
        (order) =>
          order.customerId === customerId &&
          order.checkoutRequestId === requestId,
      ),
    );
  }
  async attachPaymentIntent(orderId: string, intentId: string): Promise<void> {
    const order = this.orders.get(orderId);
    if (!order) throw new NotFoundException("Order not found");
    order.stripePaymentIntentId = intentId;
    order.paymentProvider = "stripe";
  }
}
