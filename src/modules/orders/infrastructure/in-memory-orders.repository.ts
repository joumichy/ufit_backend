import { Injectable, NotFoundException } from '@nestjs/common';
import type { Order, OrderRepository, ProductSnapshotReader } from '../application/orders.service';

@Injectable()
export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, Order>();

  async save(order: Order): Promise<Order> {
    this.orders.set(order.id, structuredClone(order));
    return structuredClone(order);
  }
}

@Injectable()
export class DisabledProductSnapshotReader implements ProductSnapshotReader {
  async buildSnapshot(productVariantId: string): Promise<Record<string, unknown>> {
    throw new NotFoundException(`Product snapshot source for ${productVariantId} is not wired yet`);
  }
}
